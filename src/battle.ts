import { type Rng, mulberry32, shuffle } from './rng.js';
import { AP_PER_TURN, HAZARD_DMG, SELFLESS_VULN_MULT, expectedDamage } from './tuning.js';
import { applyLens } from './lens.js';
import type { Rule } from './ir.js';
import { dist, hasLoS, inBounds, isFlanking, posEq } from './grid.js';
import { type ArenaTag, type HazardKind, type Tile, pickTerrain } from './terrain.js';
import type { AoeSpec, LensId, Pos, Side } from './types.js';
import {
  type ActionKind,
  type Decision,
  type Fighter,
  AOE_RITUAL_RADIUS,
  aoeDamage,
  aoeVictims,
  apCostFor,
  ritualReady,
  attackMult,
  coverLevelOf,
  decide,
  heightDmgBonus,
  isAttack,
  isMovement,
  makeCtx,
  rangeAt,
  shoveDest,
} from './scoring.js';

export interface UnitSpec {
  id: string;
  name: string;
  side: Side;
  maxHp: number;
  /** Стартовое hp боя (перенос между боями забега); по умолчанию maxHp. */
  hp?: number;
  atk: number;
  range: number;
  speed: number;
  move: number;
  tags?: string[];
  /** Линзы характера в порядке применения. */
  lenses: LensId[];
  rules: Rule[];
  /** Площадное оружие носителя АОЕ (план АОЕ). */
  aoe?: AoeSpec;
  /** Фиксированная точка спавна; у врагов без неё слот выбирается по сиду. */
  spawn?: Pos;
}

export type BattleEvent =
  | { t: 'spawn'; unit: string; name: string; side: Side; pos: Pos; maxHp: number }
  | { t: 'round'; n: number }
  | ({ t: 'decision'; unit: string; round: number } & Pick<Decision, 'factors' | 'condRules'> & {
      to: Pos;
      action: ActionKind;
      target?: string;
      /** Центр зоны площадного каста. */
      at?: Pos;
      /** Очков хода на момент решения (до списания цены действия). */
      ap: number;
    })
  | { t: 'move'; unit: string; from: Pos; to: Pos }
  | { t: 'hazard'; unit: string; kind: HazardKind; dmg: number; hp: number }
  | { t: 'shove'; unit: string; target: string; from: Pos; to: Pos }
  | { t: 'aoeCast'; unit: string; form: 'blast' | 'ritual'; at: Pos }
  | { t: 'aoeHit'; unit: string; by: string; dmg: number; hp: number }
  /** Замах ритуала: зона 5×5 у `at` объявлена, ударит в начале следующего хода кастера. */
  | { t: 'telegraph'; unit: string; at: Pos; dmg: number }
  | {
      t: 'attack';
      unit: string;
      action: ActionKind;
      target: string;
      dmg: number;
      flank: boolean;
      targetHp: number;
    }
  | { t: 'cover'; unit: string; level: number; ally?: string }
  | { t: 'wait'; unit: string }
  | { t: 'die'; unit: string }
  | { t: 'end'; winner: Side | 'draw'; rounds: number };

export interface BattleResult {
  winner: Side | 'draw';
  rounds: number;
  events: BattleEvent[];
  units: Fighter[];
  /** Террейн боя: имя и вопрос схемы, клетки [y][x] — для отрисовки и разбора. */
  terrain: { name: string; scenario: string; tiles: Tile[][] };
}

const MAX_ROUNDS = 30;
const FOE_SPAWN_SLOTS: Pos[] = [3, 6, 8, 11, 14].map((y) => ({ x: 15, y }));

function makeFighter(spec: UnitSpec, pos: Pos): Fighter {
  return {
    id: spec.id,
    name: spec.name,
    side: spec.side,
    maxHp: spec.maxHp,
    hp: Math.min(spec.hp ?? spec.maxHp, spec.maxHp),
    atk: spec.atk,
    range: spec.range,
    speed: spec.speed,
    move: spec.move,
    pos: { ...pos },
    startPos: { ...pos },
    alive: true,
    coverLevel: 0,
    exposed: false,
    tags: spec.tags ?? [],
    lenses: spec.lenses,
    aoe: spec.aoe,
    compiled: applyLens(spec.lenses, spec.rules),
  };
}

/** Точки спавна по спекам: явный spawn как есть, остальным — слоты от сида. */
function assignSpawns(specs: readonly UnitSpec[], rng: Rng): Pos[] {
  const slots = shuffle(FOE_SPAWN_SLOTS, rng);
  let slotIdx = 0;
  return specs.map((s) => s.spawn ?? slots[slotIdx++ % slots.length]!);
}

function placeUnits(specs: readonly UnitSpec[], rng: Rng): Fighter[] {
  const spawns = assignSpawns(specs, rng);
  return specs.map((s, i) => makeFighter(s, spawns[i]!));
}

/**
 * Позиции спавна без боя — превью расстановки на экране узла: тот же сид и
 * тот же порядок спеков, что у runBattle, дают ту же раскладку.
 */
export function spawnPreview(seed: number, specs: readonly UnitSpec[]): { id: string; pos: Pos }[] {
  const rng = mulberry32(seed);
  return assignSpawns(specs, rng).map((pos, i) => ({ id: specs[i]!.id, pos: { ...pos } }));
}

function rollDamage(base: number, rng: Rng): number {
  return Math.max(1, Math.round(expectedDamage(base) * (0.85 + 0.3 * rng())));
}

function winnerOf(units: readonly Fighter[]): Side | undefined {
  const partyAlive = units.some((u) => u.alive && u.side === 'party');
  const foeAlive = units.some((u) => u.alive && u.side === 'foe');
  if (partyAlive && foeAlive) return undefined;
  return partyAlive ? 'party' : 'foe';
}

/** Детерминированный бой: тот же seed + те же принципы = тот же лог событий. */
export function runBattle(seed: number, specs: readonly UnitSpec[], arena: ArenaTag = 'late'): BattleResult {
  const rng = mulberry32(seed);
  const units = placeUnits(specs, rng);
  // рабочая копия схемы; камни, совпавшие с чьей-то точкой спавна, убираем
  // (кастомные спавны тестов/сценариев)
  const layout = pickTerrain(seed, arena);
  const tiles = layout.tiles.map((row) => row.map((t) => ({ ...t })));
  for (const u of units) {
    const t = tiles[u.pos.y]?.[u.pos.x];
    if (t?.blocked) t.blocked = false;
  }
  const terrain = { name: layout.name, scenario: layout.scenario, tiles };
  const blocked = (p: Pos): boolean => tiles[p.y]?.[p.x]?.blocked === true;
  const heightAt = (p: Pos): number => tiles[p.y]?.[p.x]?.height ?? 0;
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

      // висящая зона ритуала бьёт в начале хода кастера — ДО сброса прикрытий:
      // «не могу выйти — прикрываюсь» работает, прикрытия жертв ещё активны.
      // Смерть кастера отменяет зону сама собой: мёртвый хода не получает
      if (unit.pendingRitual) {
        const { at } = unit.pendingRitual;
        unit.pendingRitual = undefined;
        const mult = unit.aoe?.ritual?.mult ?? 1;
        events.push({ t: 'aoeCast', unit: unit.id, form: 'ritual', at: { ...at } });
        for (const v of aoeVictims(at, units, AOE_RITUAL_RADIUS)) {
          const dmg = aoeDamage(unit, mult, v);
          v.hp = Math.max(0, v.hp - dmg);
          v.lastAttackerId = unit.id;
          events.push({ t: 'aoeHit', unit: v.id, by: unit.id, dmg, hp: v.hp });
          if (v.hp === 0) {
            v.alive = false;
            events.push({ t: 'die', unit: v.id });
          }
        }
        const w = winnerOf(units);
        if (w) {
          events.push({ t: 'end', winner: w, rounds: round });
          return { winner: w, rounds: round, events, units, terrain };
        }
        if (!unit.alive) continue; // накрыл сам себя
      }

      // прикрытие и открытость держатся до своего следующего хода
      unit.coverLevel = 0;
      unit.exposed = false;

      // поля дистанций считаем раз на ход: за ход этого юнита никто, кроме
      // него, не двигается, поэтому кэш ctx остаётся верным для всех действий
      const ctx = makeCtx(blocked, tiles);
      let ap = AP_PER_TURN;
      let over = false;

      while (ap > 0 && !over && unit.alive) {
        const decision = decide(unit, units, round, blocked, ap, ctx);
        const { to, action, targetId, at } = decision.chosen;
        events.push({
          t: 'decision',
          unit: unit.id,
          round,
          to,
          action,
          ...(targetId ? { target: targetId } : {}),
          ...(at ? { at: { ...at } } : {}),
          ap,
          factors: decision.factors,
          condRules: decision.condRules,
        });
        ap -= apCostFor(action, unit);

        if (isMovement(action)) {
          events.push({ t: 'move', unit: unit.id, from: { ...unit.pos }, to: { ...to } });
          unit.pos = { ...to };
          // опасная клетка бьёт закончившего на ней шаг; осторожный шаг не
          // будит опасность, проход насквозь безопасен. Без rng — фиксированный
          const hz = action === 'move' ? tiles[to.y]?.[to.x]?.hazard : undefined;
          if (hz) {
            unit.hp = Math.max(0, unit.hp - HAZARD_DMG);
            events.push({ t: 'hazard', unit: unit.id, kind: hz, dmg: HAZARD_DMG, hp: unit.hp });
            if (unit.hp === 0) {
              unit.alive = false;
              events.push({ t: 'die', unit: unit.id });
            }
          }
        } else if (isAttack(action) && targetId) {
          if (action === 'selflessAttack') unit.exposed = true;
          const target = units.find((u) => u.id === targetId)!;
          if (target.alive && dist(unit.pos, target.pos) <= rangeAt(unit, heightAt(unit.pos))) {
            const allyPositions = units
              .filter((u) => u.alive && u.side === unit.side && u !== unit)
              .map((u) => u.pos);
            const flank = unit.range === 1 && isFlanking(unit.pos, target.pos, allyPositions);
            const raw = rollDamage(unit.atk * attackMult(action) * (flank ? 1.5 : 1), rng);
            // каменное укрытие цели не складывается с прикрытием — берётся максимум
            const mitigation = Math.max(target.coverLevel, ctx.coverFrom(unit.pos, target.pos));
            const dmg = Math.max(
              1,
              Math.round(raw * (1 - mitigation) * (target.exposed ? SELFLESS_VULN_MULT : 1)) +
                heightDmgBonus(unit, heightAt(unit.pos)),
            );
            target.hp = Math.max(0, target.hp - dmg);
            target.lastAttackerId = unit.id;
            events.push({
              t: 'attack',
              unit: unit.id,
              action,
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
        } else if (action === 'shove' && targetId) {
          const target = units.find((u) => u.id === targetId)!;
          const dest = shoveDest(unit.pos, target.pos);
          if (
            target.alive &&
            dist(unit.pos, target.pos) === 1 &&
            inBounds(dest) &&
            !blocked(dest) &&
            !units.some((u) => u.alive && posEq(u.pos, dest))
          ) {
            events.push({ t: 'shove', unit: unit.id, target: target.id, from: { ...target.pos }, to: { ...dest } });
            target.pos = { ...dest };
            // опасность на клетке назначения срабатывает немедленно — иначе весь смысл
            const hz = tiles[dest.y]?.[dest.x]?.hazard;
            if (hz) {
              target.hp = Math.max(0, target.hp - HAZARD_DMG);
              target.lastAttackerId = unit.id; // мститель запомнит толкнувшего
              events.push({ t: 'hazard', unit: target.id, kind: hz, dmg: HAZARD_DMG, hp: target.hp });
              if (target.hp === 0) {
                target.alive = false;
                events.push({ t: 'die', unit: target.id });
              }
            }
          }
        } else if (action === 'aoeRitual' && at) {
          // замах: зона объявлена, урон — в начале следующего хода кастера.
          // Перезарядка и лимит списываются на замахе, а не на залпе
          const ritual = unit.aoe?.ritual;
          if (
            ritual &&
            ritualReady(unit, round) &&
            dist(unit.pos, at) <= ritual.range &&
            hasLoS(unit.pos, at, blocked)
          ) {
            unit.pendingRitual = { at: { ...at } };
            unit.lastRitualRound = round;
            unit.ritualUses = (unit.ritualUses ?? 0) + 1;
            // dmg — номинал по чистой цели, для телеграфии в логе и разведке
            const nominal = Math.max(1, Math.round(expectedDamage(unit.atk) * ritual.mult));
            events.push({ t: 'telegraph', unit: unit.id, at: { ...at }, dmg: nominal });
          }
        } else if (action === 'aoeBlast' && at) {
          // залп: фиксированный урон всем в 3×3 вокруг центра — обеим сторонам
          // (friendly fire включён) и самому кастеру, если влез в зону
          const blast = unit.aoe?.blast;
          if (blast && dist(unit.pos, at) <= blast.range && hasLoS(unit.pos, at, blocked)) {
            events.push({ t: 'aoeCast', unit: unit.id, form: 'blast', at: { ...at } });
            for (const v of aoeVictims(at, units)) {
              const dmg = aoeDamage(unit, blast.mult, v);
              v.hp = Math.max(0, v.hp - dmg);
              v.lastAttackerId = unit.id; // мститель запомнит накрывшего
              events.push({ t: 'aoeHit', unit: v.id, by: unit.id, dmg, hp: v.hp });
              if (v.hp === 0) {
                v.alive = false;
                events.push({ t: 'die', unit: v.id });
              }
            }
          }
        } else if (action === 'shieldAlly' && targetId) {
          const ally = units.find((u) => u.id === targetId)!;
          if (ally.alive) {
            ally.coverLevel = Math.max(ally.coverLevel, coverLevelOf(action));
            events.push({ t: 'cover', unit: unit.id, level: ally.coverLevel, ally: ally.id });
          }
        } else if (coverLevelOf(action) > 0) {
          unit.coverLevel = Math.max(unit.coverLevel, coverLevelOf(action));
          events.push({ t: 'cover', unit: unit.id, level: unit.coverLevel });
        } else {
          events.push({ t: 'wait', unit: unit.id });
          over = true; // пас завершает ход: тратить остаток очков не на что
        }

        const w = winnerOf(units);
        if (w) {
          events.push({ t: 'end', winner: w, rounds: round });
          return { winner: w, rounds: round, events, units, terrain };
        }
      }
    }
  }

  events.push({ t: 'end', winner: 'draw', rounds });
  return { winner: 'draw', rounds, events, units, terrain };
}

