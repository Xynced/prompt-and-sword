import { describe, expect, it } from 'vitest';
import { posKey } from '../src/grid.js';
import { applyLens } from '../src/lens.js';
import { type Fighter, decide, generateCandidates, isAttack, makeCtx, shoveDest } from '../src/scoring.js';
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
 * Толчок (план поля, шаг 6): 1 AP, сдвиг смежного врага ровно на 1 клетку
 * строго от толкающего, сам урона не наносит; опасность на клетке назначения
 * срабатывает немедленно. В стену/занятое/за край — не в кандидатах вовсе.
 * Без слова «толкать» в правилах толчков нет: инстинкты его не знают.
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

const blockedBy = (tiles: Pos[]) => {
  const set = new Set(tiles.map(posKey));
  return (p: Pos): boolean => set.has(posKey(p));
};

const shovesIn = (events: readonly BattleEvent[]): Extract<BattleEvent, { t: 'shove' }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: 'shove' }> => e.t === 'shove');

const hazardsIn = (events: readonly BattleEvent[]): Extract<BattleEvent, { t: 'hazard' }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: 'hazard' }> => e.t === 'hazard');

describe('кандидаты толчка', () => {
  const shoveRule = [rule({ kind: 'shove' })];

  it('смежный враг со свободной клеткой позади — кандидат; сдвиг строго от толкающего', () => {
    const self = fighter('s', 'party', { x: 5, y: 5 }, {}, shoveRule);
    const enemy = fighter('e', 'foe', { x: 6, y: 5 });
    const cands = generateCandidates(self, [self, enemy]);
    expect(cands.some((c) => c.action === 'shove' && c.targetId === 'e')).toBe(true);
    expect(shoveDest(self.pos, enemy.pos)).toEqual({ x: 7, y: 5 });
    expect(shoveDest({ x: 5, y: 4 }, { x: 6, y: 5 })).toEqual({ x: 7, y: 6 }); // диагональ
  });

  it('в стену, в занятое и за край поля — не в кандидатах', () => {
    const self = fighter('s', 'party', { x: 5, y: 5 }, {}, shoveRule);
    const enemy = fighter('e', 'foe', { x: 6, y: 5 });
    const walled = generateCandidates(self, [self, enemy], makeCtx(blockedBy([{ x: 7, y: 5 }])));
    expect(walled.some((c) => c.action === 'shove')).toBe(false);

    const ally = fighter('b', 'party', { x: 7, y: 5 });
    const occupied = generateCandidates(self, [self, enemy, ally]);
    expect(occupied.some((c) => c.action === 'shove')).toBe(false);

    const corner = fighter('s2', 'party', { x: 1, y: 0 }, {}, shoveRule);
    const edgeEnemy = fighter('e2', 'foe', { x: 0, y: 0 });
    const offBoard = generateCandidates(corner, [corner, edgeEnemy]);
    expect(offBoard.some((c) => c.action === 'shove')).toBe(false);
  });

  it('без слова «толкать» в правилах кандидатов нет', () => {
    const self = fighter('s', 'party', { x: 5, y: 5 }, {}, [rule({ kind: 'attack', target: 'nearest' })]);
    const enemy = fighter('e', 'foe', { x: 6, y: 5 });
    const cands = generateCandidates(self, [self, enemy]);
    expect(cands.some((c) => c.action === 'shove')).toBe(false);
  });
});

describe('толчок против атаки', () => {
  // теснина (сид 8): шипы y6 (x6–11), коридор y7–10
  const layout = pickTerrain(8);
  const blocked = (p: Pos): boolean => layout.tiles[p.y]?.[p.x]?.blocked === true;
  const bothRules = [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'shove' })];

  it('в шипы — толкает вместо атаки; на чистую клетку — бьёт', () => {
    const ctx = makeCtx(blocked, layout.tiles);
    // враг спиной к шипам: толчок ценнее удара
    const pusher = fighter('s', 'party', { x: 8, y: 8 }, {}, bothRules);
    const enemy = fighter('e', 'foe', { x: 8, y: 7 }, { move: 0 });
    expect(ctx.hazardAt(shoveDest(pusher.pos, enemy.pos))).toBe('spikes');
    expect(decide(pusher, [pusher, enemy], 1, blocked, 3, ctx).chosen.action).toBe('shove');

    // враг спиной к чистому коридору: обычная атака выгоднее
    const side = fighter('s2', 'party', { x: 7, y: 7 }, {}, bothRules);
    const enemy2 = fighter('e2', 'foe', { x: 8, y: 7 }, { move: 0 });
    expect(ctx.hazardAt(shoveDest(side.pos, enemy2.pos))).toBeUndefined();
    const d = decide(side, [side, enemy2], 1, blocked, 3, ctx);
    expect(isAttack(d.chosen.action)).toBe(true);
  });
});

describe('толчок в бою (теснина)', () => {
  const pusher = (rules: Rule[]): UnitSpec => ({
    id: 'a', name: 'a', side: 'party', maxHp: 40, atk: 5, range: 1, speed: 9, move: 2,
    lenses: ['plain'], rules, spawn: { x: 8, y: 8 },
  });
  const dummy: UnitSpec = {
    id: 'e', name: 'e', side: 'foe', maxHp: 20, atk: 1, range: 1, speed: 1, move: 0,
    lenses: ['plain'], rules: [], spawn: { x: 8, y: 7 },
  };

  it('толчок в шипы: опасность срабатывает немедленно, повторный толчок в стену не предлагается', () => {
    const r = runBattle(8, [pusher([rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'shove' })]), dummy]);
    expect(r.terrain.name).toBe('теснина');
    const shoves = shovesIn(r.events);
    expect(shoves.length).toBeGreaterThan(0);
    expect(shoves[0]!.to).toEqual({ x: 8, y: 6 }); // строго от толкающего, на шипы
    // сразу за толчком — срабатывание шипов по цели
    const at = r.events.indexOf(shoves[0]!);
    const next = r.events[at + 1]!;
    expect(next.t).toBe('hazard');
    if (next.t === 'hazard') {
      expect(next.unit).toBe('e');
      expect(next.dmg).toBe(HAZARD_DMG);
      expect(next.hp).toBe(20 - HAZARD_DMG);
    }
    // за шипами стена (8,5): второй толчок туда не проходит и не предлагается
    expect(shoves.length).toBe(1);
  });

  it('чистый толчок урона не наносит', () => {
    const clean = runBattle(8, [
      { ...pusher([rule({ kind: 'shove' })]), spawn: { x: 6, y: 7 } },
      { ...dummy, spawn: { x: 7, y: 7 } }, // спиной к чистому коридору
    ]);
    expect(shovesIn(clean.events).length).toBeGreaterThan(0);
    expect(hazardsIn(clean.events).length).toBe(0);
  });

  it('без слова толчков в логе нет', () => {
    const r = runBattle(8, [pusher([rule({ kind: 'attack', target: 'nearest' })]), dummy]);
    expect(shovesIn(r.events).length).toBe(0);
  });
});

describe('слово «толкать»', () => {
  it('в DEEP-пуле; компилируется при открытом словаре и закрыт в стартовом', () => {
    // по аудиту слов толчок мёртв на текущих аренах (дельта ≈ 0) — обычное, ждёт переработки
    expect(COMMON_WORDS).toContain('act.shove');
    expect(STARTING_VOCAB).not.toContain('act.shove');
    const draft = { condition: { id: 'always' }, preference: { id: 'act.shove' } } as const;
    const ok = compilePhrase(draft, FULL_VOCAB);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.rule.then).toEqual({ kind: 'shove' });
    const closed = compilePhrase(draft, STARTING_VOCAB);
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.missing).toEqual(['act.shove']);
  });

  it('карточка читает «толкаю»; схема и валидация — только при открытом словаре', () => {
    const card = understandingCard({ name: 'Гром', lenses: ['plain'] }, [rule({ kind: 'shove' })]);
    expect(card.lines[0]).toContain('толкаю');
    expect(JSON.stringify(buildCompileSchema(FULL_VOCAB, []))).toContain('act.shove');
    expect(JSON.stringify(buildCompileSchema(STARTING_VOCAB, []))).not.toContain('act.shove');
    const raw = {
      phrases: [{ condition: { id: 'always' }, preference: { id: 'act.shove' }, weight: 1 }],
      uncertainty: [],
    };
    expect(validateOutput(raw, FULL_VOCAB, [], 4).ok).toBe(true);
    expect(validateOutput(raw, STARTING_VOCAB, [], 4).ok).toBe(false);
  });
});
