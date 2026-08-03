import { type Rng, mulberry32, shuffle } from './rng.js';
import { applyLens } from './lens.js';
import type { Rule } from './ir.js';
import { dist, isFlanking, posEq } from './grid.js';
import type { CharacterId, Pos, Side } from './types.js';
import { type Decision, type Fighter, decide } from './scoring.js';

export interface UnitSpec {
  id: string;
  name: string;
  side: Side;
  maxHp: number;
  atk: number;
  range: number;
  speed: number;
  move: number;
  tags?: string[];
  character: CharacterId;
  rules: Rule[];
  /** Фиксированная точка спавна; у врагов без неё слот выбирается по сиду. */
  spawn?: Pos;
}

export type BattleEvent =
  | { t: 'spawn'; unit: string; name: string; side: Side; pos: Pos; maxHp: number }
  | { t: 'round'; n: number }
  | ({ t: 'decision'; unit: string; round: number } & Pick<Decision, 'factors'> & {
      to: Pos;
      action: string;
      target?: string;
    })
  | { t: 'move'; unit: string; from: Pos; to: Pos }
  | { t: 'attack'; unit: string; target: string; dmg: number; flank: boolean; targetHp: number }
  | { t: 'defend'; unit: string }
  | { t: 'wait'; unit: string }
  | { t: 'die'; unit: string }
  | { t: 'end'; winner: Side | 'draw'; rounds: number };

export interface BattleResult {
  winner: Side | 'draw';
  rounds: number;
  events: BattleEvent[];
  units: Fighter[];
}

const MAX_ROUNDS = 30;
const FOE_SPAWN_SLOTS: Pos[] = [1, 2, 4, 5, 6].map((y) => ({ x: 6, y }));

function makeFighter(spec: UnitSpec, pos: Pos): Fighter {
  return {
    id: spec.id,
    name: spec.name,
    side: spec.side,
    maxHp: spec.maxHp,
    hp: spec.maxHp,
    atk: spec.atk,
    range: spec.range,
    speed: spec.speed,
    move: spec.move,
    pos: { ...pos },
    startPos: { ...pos },
    alive: true,
    defending: false,
    tags: spec.tags ?? [],
    character: spec.character,
    compiled: applyLens(spec.character, spec.rules),
  };
}

function placeUnits(specs: readonly UnitSpec[], rng: Rng): Fighter[] {
  const slots = shuffle(FOE_SPAWN_SLOTS, rng);
  let slotIdx = 0;
  return specs.map((s) => {
    if (s.spawn) return makeFighter(s, s.spawn);
    const slot = slots[slotIdx++ % slots.length]!;
    return makeFighter(s, slot);
  });
}

function rollDamage(base: number, rng: Rng): number {
  return Math.max(1, Math.round(base * (0.85 + 0.3 * rng())));
}

function winnerOf(units: readonly Fighter[]): Side | undefined {
  const partyAlive = units.some((u) => u.alive && u.side === 'party');
  const foeAlive = units.some((u) => u.alive && u.side === 'foe');
  if (partyAlive && foeAlive) return undefined;
  return partyAlive ? 'party' : 'foe';
}

/** Детерминированный бой: тот же seed + те же принципы = тот же лог событий. */
export function runBattle(seed: number, specs: readonly UnitSpec[]): BattleResult {
  const rng = mulberry32(seed);
  const units = placeUnits(specs, rng);
  const events: BattleEvent[] = [];
  for (const u of units) {
    events.push({ t: 'spawn', unit: u.id, name: u.name, side: u.side, pos: { ...u.pos }, maxHp: u.maxHp });
  }
  let rounds = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    rounds = round;
    events.push({ t: 'round', n: round });
    const order = units
      .filter((u) => u.alive)
      .sort((a, b) => b.speed - a.speed || (a.id < b.id ? -1 : 1));

    for (const unit of order) {
      if (!unit.alive) continue;
      unit.defending = false;

      const decision = decide(unit, units);
      const { to, action, targetId } = decision.chosen;
      events.push({
        t: 'decision',
        unit: unit.id,
        round,
        to,
        action,
        ...(targetId ? { target: targetId } : {}),
        factors: decision.factors,
      });

      if (!posEq(to, unit.pos)) {
        events.push({ t: 'move', unit: unit.id, from: { ...unit.pos }, to: { ...to } });
        unit.pos = { ...to };
      }

      if (action === 'attack' && targetId) {
        const target = units.find((u) => u.id === targetId)!;
        if (target.alive && dist(unit.pos, target.pos) <= unit.range) {
          const allyPositions = units
            .filter((u) => u.alive && u.side === unit.side && u !== unit)
            .map((u) => u.pos);
          const flank = unit.range === 1 && isFlanking(unit.pos, target.pos, allyPositions);
          let dmg = rollDamage(unit.atk * (flank ? 1.5 : 1), rng);
          if (target.defending) dmg = Math.max(1, Math.floor(dmg * 0.5));
          target.hp = Math.max(0, target.hp - dmg);
          events.push({
            t: 'attack',
            unit: unit.id,
            target: target.id,
            dmg,
            flank,
            targetHp: target.hp,
          });
          if (target.hp === 0) {
            target.alive = false;
            events.push({ t: 'die', unit: target.id });
          }
        }
      } else if (action === 'defend') {
        unit.defending = true;
        events.push({ t: 'defend', unit: unit.id });
      } else {
        events.push({ t: 'wait', unit: unit.id });
      }

      const w = winnerOf(units);
      if (w) {
        events.push({ t: 'end', winner: w, rounds: round });
        return { winner: w, rounds: round, events, units };
      }
    }
  }

  events.push({ t: 'end', winner: 'draw', rounds });
  return { winner: 'draw', rounds, events, units };
}

