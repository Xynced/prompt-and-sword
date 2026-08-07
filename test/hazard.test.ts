import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import { AP_COST, type Fighter, apCostFor, decide, isMovement, makeCtx } from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { pickTerrain } from '../src/terrain.js';
import { HAZARD_DMG } from '../src/tuning.js';
import { compilePhrase } from '../src/constructor.js';
import { CONCEPTS, COMMON_WORDS, STARTING_VOCAB, type ConceptId } from '../src/vocab.js';
import { understandingCard } from '../src/cards.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import type { CombatUnit, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Опасные клетки и осторожный шаг (план поля, шаг 5): шипы бьют того, кто
 * закончил на них действие «шаг» (стояние и проход безопасны); урон
 * фиксированный, без rng. `carefulStep` — 1 AP (2 AP при move: 1), опасность
 * не срабатывает. Слово «обходить опасное» — CORE.
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

const hazardsIn = (events: readonly BattleEvent[]): Extract<BattleEvent, { t: 'hazard' }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: 'hazard' }> => e.t === 'hazard');

/**
 * Теснина (сид 8): шипы y6/y11 (x6–11), коридор y7–10. Враг на шипах (8,6),
 * чистые подходы к нему заняты буквалистами-заслонами — атаковать можно только
 * с шипов (7,6)/(9,6).
 */
function tesninaSpecs(attackerSpawn: Pos, attackerOver: Partial<UnitSpec> = {}): UnitSpec[] {
  const blocker = (n: number, spawn: Pos): UnitSpec => ({
    id: `b${n}`, name: `b${n}`, side: 'party', maxHp: 30, atk: 3, range: 1, speed: 8, move: 0,
    lenses: ['literalist'], rules: [], spawn,
  });
  return [
    {
      id: 'a', name: 'a', side: 'party', maxHp: 20, atk: 5, range: 1, speed: 9, move: 2,
      lenses: ['plain'], rules: [rule({ kind: 'attack', target: 'nearest' })], spawn: attackerSpawn,
      ...attackerOver,
    },
    blocker(1, { x: 7, y: 7 }),
    blocker(2, { x: 8, y: 7 }),
    blocker(3, { x: 9, y: 7 }),
    {
      id: 'e', name: 'e', side: 'foe', maxHp: 20, atk: 1, range: 1, speed: 1, move: 0,
      lenses: ['plain'], rules: [], spawn: { x: 8, y: 6 },
    },
  ];
}

describe('цены осторожного шага', () => {
  it('1 AP обычному, 2 AP медленному; остальные цены — константы', () => {
    const quick = fighter('q', 'party', { x: 0, y: 0 }, { move: 2 });
    const slow = fighter('s', 'party', { x: 0, y: 0 }, { move: 1 });
    expect(apCostFor('carefulStep', quick)).toBe(1);
    expect(apCostFor('carefulStep', slow)).toBe(2);
    expect(apCostFor('attack', slow)).toBe(AP_COST.attack);
    expect(apCostFor('move', slow)).toBe(AP_COST.move);
  });
});

describe('шипы в бою (теснина)', () => {
  it('бьют закончившего шаг на них — фиксированно и без rng; стояние безопасно', () => {
    const r = runBattle(8, tesninaSpecs({ x: 5, y: 8 }));
    expect(r.terrain.name).toBe('теснина');
    const hz = hazardsIn(r.events);
    // атакующий добрался до врага только через шипы — и заплатил ровно HAZARD_DMG
    const first = hz.find((e) => e.unit === 'a')!;
    expect(first.dmg).toBe(HAZARD_DMG);
    expect(first.hp).toBe(20 - HAZARD_DMG);
    // враг простоял на шипах весь бой — стояние не наказывается
    expect(hz.some((e) => e.unit === 'e')).toBe(false);
  });

  it('осторожный шаг снимает урон: с соседней клетки юнит заходит на шипы бесплатно', () => {
    const r = runBattle(8, tesninaSpecs({ x: 6, y: 7 }));
    expect(hazardsIn(r.events).length).toBe(0);
    expect(r.events.some((e) => e.t === 'decision' && e.action === 'carefulStep')).toBe(true);
    expect(r.events.some((e) => e.t === 'attack' && e.unit === 'a')).toBe(true);
  });

  it('медленный после осторожного шага не успевает на полный удар', () => {
    const layout = pickTerrain(8);
    const blocked = (p: Pos): boolean => layout.tiles[p.y]?.[p.x]?.blocked === true;
    const ctx = makeCtx(blocked, layout.tiles);
    const self = fighter('s', 'party', { x: 7, y: 7 }, { move: 1 }, [rule({ kind: 'attack', target: 'nearest' })]);
    const enemy = fighter('e', 'foe', { x: 8, y: 5 }, { move: 0 });
    // цель за шипами (8,6): бить можно только с них
    enemy.pos = { x: 8, y: 5 };
    const first = decide(self, [self, enemy], 1, blocked, 3, ctx);
    expect(first.chosen.action).toBe('carefulStep');
    self.pos = { ...first.chosen.to };
    const second = decide(self, [self, enemy], 1, blocked, 3 - apCostFor('carefulStep', self), ctx);
    expect(second.chosen.action).not.toBe('attack'); // на полный удар очков не осталось
  });
});

describe('слово «обходить опасное»', () => {
  it('стоящий на шипах уходит на чистую клетку', () => {
    const layout = pickTerrain(8);
    const blocked = (p: Pos): boolean => layout.tiles[p.y]?.[p.x]?.blocked === true;
    const ctx = makeCtx(blocked, layout.tiles);
    const self = fighter('s', 'party', { x: 7, y: 6 }, { move: 2 }, [rule({ kind: 'avoidHazard' }, 1.5)]);
    const enemy = fighter('e', 'foe', { x: 16, y: 8 }, { move: 0 });
    expect(ctx.hazardAt(self.pos)).toBe('spikes');
    const d = decide(self, [self, enemy], 1, blocked, 3, ctx);
    expect(isMovement(d.chosen.action)).toBe(true);
    expect(ctx.hazardAt(d.chosen.to)).toBeUndefined();
  });

  it('не даёт закончить шаг на шипах даже ради удара', () => {
    const layout = pickTerrain(8);
    const blocked = (p: Pos): boolean => layout.tiles[p.y]?.[p.x]?.blocked === true;
    const ctx = makeCtx(blocked, layout.tiles);
    const specsCtxUnits = tesninaSpecs({ x: 5, y: 8 });
    const self = fighter('a', 'party', { x: 5, y: 8 }, { move: 2 }, [
      rule({ kind: 'attack', target: 'nearest' }),
      rule({ kind: 'avoidHazard' }),
    ]);
    const others = specsCtxUnits
      .slice(1)
      .map((s) => fighter(s.id, s.side, s.spawn!, { move: s.move, range: s.range, atk: s.atk }));
    const d = decide(self, [self, ...others], 1, blocked, 3, ctx);
    expect(ctx.hazardAt(d.chosen.to)).toBeUndefined();
  });

  it('в CORE-пуле; компилируется при открытом словаре и закрыт в стартовом', () => {
    expect(COMMON_WORDS).toContain('space.avoidHazard');
    expect(STARTING_VOCAB).not.toContain('space.avoidHazard');
    const draft = { condition: { id: 'always' }, preference: { id: 'space.avoidHazard' } } as const;
    const ok = compilePhrase(draft, FULL_VOCAB);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.rule.then).toEqual({ kind: 'avoidHazard' });
    const closed = compilePhrase(draft, STARTING_VOCAB);
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.missing).toEqual(['space.avoidHazard']);
  });

  it('карточка читает «обхожу опасное»; схема и валидация — только при открытом словаре', () => {
    const card = understandingCard({ name: 'Гром', lenses: ['plain'] }, [rule({ kind: 'avoidHazard' })]);
    expect(card.lines[0]).toContain('обхожу опасное');
    expect(JSON.stringify(buildCompileSchema(FULL_VOCAB, []))).toContain('space.avoidHazard');
    expect(JSON.stringify(buildCompileSchema(STARTING_VOCAB, []))).not.toContain('space.avoidHazard');
    const raw = {
      phrases: [{ condition: { id: 'always' }, preference: { id: 'space.avoidHazard' }, weight: 1 }],
      uncertainty: [],
    };
    expect(validateOutput(raw, FULL_VOCAB, [], 4).ok).toBe(true);
    expect(validateOutput(raw, STARTING_VOCAB, [], 4).ok).toBe(false);
  });
});
