import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import { AP_COST, type Fighter, decide, generateCandidates, makeCtx, rangeAt } from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { ARENA_H, ARENA_W, type Tile, pickTerrain } from '../src/terrain.js';
import { compilePhrase } from '../src/constructor.js';
import { CONCEPTS, COMMON_WORDS, STARTING_VOCAB, type ConceptId } from '../src/vocab.js';
import { understandingCard } from '../src/cards.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import type { CombatUnit, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Высота (план поля, шаг 2): стрелку холм даёт +height к дальности,
 * высота 2 — ещё и +1 к урону; ближний бой высота не меняет.
 * Слово «держать высоту» — CORE-пул.
 */

const FULL_VOCAB = Object.keys(CONCEPTS) as ConceptId[];

function fighter(id: string, side: Side, pos: Pos, over: Partial<CombatUnit> = {}, rules: Rule[] = []): Fighter {
  return {
    id,
    name: id,
    side,
    maxHp: 20,
    hp: 20,
    atk: 5,
    range: 1,
    speed: 5,
    move: 3,
    pos,
    startPos: { ...pos },
    alive: true,
    coverLevel: 0,
    exposed: false,
    tags: [],
    lenses: ['plain'],
    ...over,
    compiled: applyLens(['plain'], rules),
  };
}

const rule = (then: Rule['then'], weight = 2): Rule => ({
  when: { kind: 'always' },
  then,
  weight,
  scope: 'self',
  source: 'тест',
});

const attacksIn = (events: readonly BattleEvent[]): Extract<BattleEvent, { t: 'attack' }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: 'attack' }> => e.t === 'attack');

describe('дальность с высоты', () => {
  it('rangeAt: стрелку +height, ближнику ничего', () => {
    const shooter = fighter('s', 'party', { x: 0, y: 0 }, { range: 4 });
    const melee = fighter('m', 'party', { x: 0, y: 0 }, { range: 1 });
    expect(rangeAt(shooter, 0)).toBe(4);
    expect(rangeAt(shooter, 1)).toBe(5);
    expect(rangeAt(shooter, 2)).toBe(6);
    expect(rangeAt(melee, 2)).toBe(1);
  });

  it('кандидаты атаки появляются на дальности range+2 только с высоты 2', () => {
    const shooter = fighter('s', 'party', { x: 8, y: 8 }, { range: 4, move: 0 }, [rule({ kind: 'attack', target: 'nearest' })]);
    const target = fighter('e', 'foe', { x: 14, y: 8 });
    // клетка стрелка (8,8) поднимается на нужную высоту
    const at = (h: 0 | 1 | 2): ReturnType<typeof makeCtx> => {
      const tiles = Array.from({ length: ARENA_H }, () => Array.from({ length: ARENA_W }, (): Tile => ({})));
      if (h > 0) tiles[8]![8] = { height: h };
      return makeCtx(() => false, tiles);
    };
    const flat = generateCandidates(shooter, [shooter, target], at(0), 3);
    expect(flat.some((c) => c.action === 'attack')).toBe(false);
    const onH1 = generateCandidates(shooter, [shooter, target], at(1), 3);
    expect(onH1.some((c) => c.action === 'attack')).toBe(false);
    const onH2 = generateCandidates(shooter, [shooter, target], at(2), 3);
    expect(onH2.some((c) => c.action === 'attack')).toBe(true);
  });

  it('в бою на террасе стрелок с высоты 2 достаёт на 2 дальше', () => {
    // сид 10 → «терраса»: y12–17 x4–13 — высота 2
    const specs: UnitSpec[] = [
      { id: 'a', name: 'a', side: 'party', maxHp: 30, atk: 5, range: 4, speed: 9, move: 0, lenses: ['plain'], rules: [rule({ kind: 'attack', target: 'nearest' })], spawn: { x: 8, y: 14 } },
      { id: 'e', name: 'e', side: 'foe', maxHp: 30, atk: 5, range: 1, speed: 1, move: 0, lenses: ['plain'], rules: [], spawn: { x: 14, y: 14 } },
    ];
    const r = runBattle(10, specs);
    expect(r.terrain.name).toBe('терраса');
    expect(attacksIn(r.events).some((e) => e.unit === 'a')).toBe(true);

    // с высоты 1 (y6–11) та же дистанция 6 уже не простреливается
    const low: UnitSpec[] = [
      { ...specs[0]!, spawn: { x: 8, y: 8 } },
      { ...specs[1]!, spawn: { x: 14, y: 8 } },
    ];
    expect(attacksIn(runBattle(10, low).events).length).toBe(0);
  });
});

describe('урон с высоты 2', () => {
  // манера «бить наверняка» фиксирует вид атаки: обе стороны сравнения бьют
  // обычным ударом, и первый бросок урона в обоих боях приходит из одного rng
  const shooterRules = [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'strikeHard' })];

  it('стрелок с высоты 2 бьёт ровно на +1', () => {
    const onHill: UnitSpec[] = [
      { id: 'a', name: 'a', side: 'party', maxHp: 40, atk: 5, range: 4, speed: 9, move: 0, lenses: ['plain'], rules: shooterRules, spawn: { x: 8, y: 14 } },
      { id: 'e', name: 'e', side: 'foe', maxHp: 40, atk: 5, range: 1, speed: 1, move: 0, lenses: ['plain'], rules: [], spawn: { x: 12, y: 14 } },
    ];
    const flat: UnitSpec[] = [
      { ...onHill[0]!, spawn: { x: 2, y: 14 } },
      { ...onHill[1]!, spawn: { x: 6, y: 14 } },
    ];
    const a = attacksIn(runBattle(10, onHill).events)[0]!;
    const b = attacksIn(runBattle(10, flat).events)[0]!;
    expect(a.unit).toBe('a');
    expect(b.unit).toBe('a');
    expect(a.dmg).toBe(b.dmg + 1);
  });

  it('ближнему бойцу высота урона не добавляет', () => {
    const rules = [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'strikeHard' })];
    const onHill: UnitSpec[] = [
      { id: 'a', name: 'a', side: 'party', maxHp: 40, atk: 5, range: 1, speed: 9, move: 0, lenses: ['plain'], rules, spawn: { x: 8, y: 14 } },
      { id: 'e', name: 'e', side: 'foe', maxHp: 40, atk: 5, range: 1, speed: 1, move: 0, lenses: ['plain'], rules: [], spawn: { x: 9, y: 14 } },
    ];
    const flat: UnitSpec[] = [
      { ...onHill[0]!, spawn: { x: 1, y: 8 } },
      { ...onHill[1]!, spawn: { x: 2, y: 8 } },
    ];
    const a = attacksIn(runBattle(10, onHill).events)[0]!;
    const b = attacksIn(runBattle(10, flat).events)[0]!;
    expect(a.dmg).toBe(b.dmg);
  });
});

describe('слово «держать высоту»', () => {
  it('принцип уводит стрелка на вершину кургана', () => {
    // сид 6 → «курган»: кольцо высоты 1 (x7–10, y7–10), вершина 2×2 в центре
    const layout = pickTerrain(6);
    expect(layout.name).toBe('курган');
    const blocked = (p: Pos): boolean => layout.tiles[p.y]?.[p.x]?.blocked === true;
    const ctx = makeCtx(blocked, layout.tiles);
    const self = fighter('s', 'party', { x: 4, y: 8 }, { range: 4, move: 2 }, [rule({ kind: 'highGround' }, 1.5)]);
    const enemy = fighter('e', 'foe', { x: 16, y: 9 }, { move: 0 });
    for (let round = 1; round <= 2; round++) {
      let ap = 3;
      while (ap > 0) {
        const d = decide(self, [self, enemy], round, blocked, ap, ctx);
        if (d.chosen.action === 'move') self.pos = { ...d.chosen.to };
        else break;
        ap -= AP_COST.move;
      }
    }
    expect(ctx.heightAt(self.pos)).toBe(2);
  });

  it('в CORE-пуле; компилируется при открытом словаре и закрыт в стартовом', () => {
    expect(COMMON_WORDS).toContain('space.highGround');
    expect(STARTING_VOCAB).not.toContain('space.highGround');
    const draft = { condition: { id: 'always' }, preference: { id: 'space.highGround' } } as const;
    const ok = compilePhrase(draft, FULL_VOCAB);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.rule.then).toEqual({ kind: 'highGround' });
    const closed = compilePhrase(draft, STARTING_VOCAB);
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.missing).toEqual(['space.highGround']);
  });

  it('карточка читает «держу высоту»', () => {
    const card = understandingCard({ name: 'Мара', lenses: ['plain'] }, [rule({ kind: 'highGround' })]);
    expect(card.lines[0]).toContain('держу высоту');
  });

  it('в LLM-схеме и валидации только при открытом словаре', () => {
    expect(JSON.stringify(buildCompileSchema(FULL_VOCAB, []))).toContain('space.highGround');
    expect(JSON.stringify(buildCompileSchema(STARTING_VOCAB, []))).not.toContain('space.highGround');
    const raw = {
      phrases: [{ condition: { id: 'always' }, preference: { id: 'space.highGround' }, weight: 1 }],
      uncertainty: [],
    };
    expect(validateOutput(raw, FULL_VOCAB, [], 4).ok).toBe(true);
    expect(validateOutput(raw, STARTING_VOCAB, [], 4).ok).toBe(false);
  });
});
