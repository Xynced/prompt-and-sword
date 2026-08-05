import { describe, expect, it } from 'vitest';
import { hasTerrainCover, posKey } from '../src/grid.js';
import { applyLens } from '../src/lens.js';
import { AP_COST, type Fighter, decide, makeCtx } from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { pickTerrain } from '../src/terrain.js';
import { TERRAIN_COVER } from '../src/tuning.js';
import { compilePhrase } from '../src/constructor.js';
import { CONCEPTS, CORE_WORDS, STARTING_VOCAB, type ConceptId } from '../src/vocab.js';
import { understandingCard } from '../src/cards.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import type { CombatUnit, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Каменное укрытие (план поля, шаг 3): гибрид Q-2 — камень, ортогонально
 * смежный цели со стороны стрелка, режет урон вдвое (не запрещает выстрел);
 * камень, смежный обоим, — всегда укрытие. Стрелок с высоты 2 бьёт поверх.
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

const attacksIn = (events: readonly BattleEvent[]): Extract<BattleEvent, { t: 'attack' }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: 'attack' }> => e.t === 'attack');

describe('геометрия гибрида', () => {
  const target = { x: 5, y: 5 };

  it('камень, смежный цели со стороны стрелка, — укрытие; с других сторон — нет', () => {
    const rock = blockedBy([{ x: 4, y: 5 }]); // к западу от цели
    expect(hasTerrainCover({ x: 2, y: 5 }, target, rock)).toBe(true); // стрелок с запада
    expect(hasTerrainCover({ x: 8, y: 5 }, target, rock)).toBe(false); // с востока камень не закрывает
    expect(hasTerrainCover({ x: 5, y: 2 }, target, rock)).toBe(false); // перпендикуляр: dot = 0
  });

  it('диагональный камень прикрывает свою сторону; смежный обоим — всегда укрытие', () => {
    const rock = blockedBy([{ x: 4, y: 4 }]); // по диагонали (северо-запад) от цели
    expect(hasTerrainCover({ x: 3, y: 4 }, target, rock)).toBe(true); // смежен обоим
    expect(hasTerrainCover({ x: 2, y: 4 }, target, rock)).toBe(true); // северо-западная сторона
    expect(hasTerrainCover({ x: 8, y: 5 }, target, rock)).toBe(false); // с востока — нет
  });

  it('вплотную укрытия нет', () => {
    const rock = blockedBy([{ x: 4, y: 5 }]);
    expect(hasTerrainCover({ x: 4, y: 4 }, target, rock)).toBe(false); // дист 1
  });
});

describe('укрытие в расчёте урона', () => {
  it('выстрел в укрытую цель слабее вдвое', () => {
    // сид 11 → «поляна» с камнем (7,5); цель (8,5) за ним от стрелка с запада
    const shooter = (spawn: Pos): UnitSpec => ({
      id: 'a', name: 'a', side: 'party', maxHp: 40, atk: 5, range: 4, speed: 9, move: 0,
      lenses: ['plain'], rules: [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'strikeHard' })], spawn,
    });
    const dummy = (spawn: Pos): UnitSpec => ({
      id: 'e', name: 'e', side: 'foe', maxHp: 40, atk: 5, range: 1, speed: 1, move: 0,
      lenses: ['plain'], rules: [], spawn,
    });
    const covered = runBattle(11, [shooter({ x: 4, y: 5 }), dummy({ x: 8, y: 5 })]);
    expect(covered.terrain.name).toBe('поляна');
    const clear = runBattle(11, [shooter({ x: 4, y: 7 }), dummy({ x: 8, y: 7 })]);
    const a = attacksIn(covered.events)[0]!;
    const b = attacksIn(clear.events)[0]!;
    expect(a.unit).toBe('a');
    expect(a.dmg).toBe(Math.max(1, Math.round(b.dmg * TERRAIN_COVER)));
    expect(a.dmg).toBeLessThan(b.dmg);
  });

  it('стрелок с высоты 2 бьёт поверх укрытия', () => {
    // «курган» (сид 6): камень (5,4), вершина 2×2 в центре (8..9, 8..9)
    const layout = pickTerrain(6);
    expect(layout.name).toBe('курган');
    const blocked = (p: Pos): boolean => layout.tiles[p.y]?.[p.x]?.blocked === true;
    const ctx = makeCtx(blocked, layout.tiles);
    const target = { x: 4, y: 4 }; // к западу от камня (5,4)
    expect(ctx.coverFrom({ x: 8, y: 4 }, target)).toBe(TERRAIN_COVER); // с равнины цель укрыта
    expect(ctx.coverFrom({ x: 8, y: 8 }, target)).toBe(0); // с вершины укрытия нет
  });
});

describe('стрелок и укрытая цель', () => {
  it('меняет позицию на чистый угол, а не стреляет в камень', () => {
    const rock = { x: 8, y: 4 }; // к северу от цели: закрывает северные подходы
    const blocked = blockedBy([rock]);
    const ctx = makeCtx(blocked);
    const self = fighter('s', 'party', { x: 5, y: 3 }, { range: 4, move: 2, atk: 4 }, [rule({ kind: 'attack', target: 'nearest' })]);
    // цель способна отвечать: иначе «отчаянный удар» в укрытие бесплатен
    const enemy = fighter('e', 'foe', { x: 8, y: 5 }, { move: 2, atk: 8, speed: 1 });
    expect(ctx.coverFrom(self.pos, enemy.pos)).toBe(TERRAIN_COVER); // сейчас цель укрыта

    const first = decide(self, [self, enemy], 1, blocked, 3, ctx);
    expect(first.chosen.action).toBe('move');
    expect(ctx.coverFrom(first.chosen.to, enemy.pos)).toBe(0); // угол чистый
    self.pos = { ...first.chosen.to };
    const second = decide(self, [self, enemy], 1, blocked, 3 - AP_COST.move, ctx);
    expect(second.chosen.targetId).toBe('e'); // и стреляет уже в полную силу
  });

  it('без укрытия с той же клетки стреляет сразу', () => {
    const ctx = makeCtx();
    const self = fighter('s', 'party', { x: 5, y: 3 }, { range: 4, move: 2, atk: 4 }, [rule({ kind: 'attack', target: 'nearest' })]);
    const enemy = fighter('e', 'foe', { x: 8, y: 5 }, { move: 2, atk: 8, speed: 1 });
    const first = decide(self, [self, enemy], 1, () => false, 3, ctx);
    expect(first.chosen.action).not.toBe('move');
    expect(first.chosen.targetId).toBe('e');
  });
});

describe('слово «за укрытием»', () => {
  it('принцип заводит бойца за камень от вражеского стрелка', () => {
    const rock = { x: 7, y: 5 };
    const blocked = blockedBy([rock]);
    const ctx = makeCtx(blocked);
    const self = fighter('s', 'party', { x: 5, y: 5 }, { move: 2 }, [rule({ kind: 'behindCover' }, 1.5)]);
    const enemy = fighter('e', 'foe', { x: 14, y: 5 }, { range: 5, move: 0 });
    expect(ctx.coverFrom(enemy.pos, self.pos)).toBe(0); // старт — в чистом поле
    let ap = 3;
    while (ap > 0) {
      const d = decide(self, [self, enemy], 1, blocked, ap, ctx);
      if (d.chosen.action !== 'move') break;
      self.pos = { ...d.chosen.to };
      ap -= AP_COST.move;
    }
    expect(ctx.coverFrom(enemy.pos, self.pos)).toBe(TERRAIN_COVER);
  });

  it('в CORE-пуле; компилируется при открытом словаре и закрыт в стартовом', () => {
    expect(CORE_WORDS).toContain('space.behindCover');
    expect(STARTING_VOCAB).not.toContain('space.behindCover');
    const draft = { condition: { id: 'always' }, preference: { id: 'space.behindCover' } } as const;
    const ok = compilePhrase(draft, FULL_VOCAB);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.rule.then).toEqual({ kind: 'behindCover' });
    const closed = compilePhrase(draft, STARTING_VOCAB);
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.missing).toEqual(['space.behindCover']);
  });

  it('карточка читает «держусь за укрытием»', () => {
    const card = understandingCard({ name: 'Лия', lenses: ['plain'] }, [rule({ kind: 'behindCover' })]);
    expect(card.lines[0]).toContain('держусь за укрытием');
  });

  it('в LLM-схеме и валидации только при открытом словаре', () => {
    expect(JSON.stringify(buildCompileSchema(FULL_VOCAB, []))).toContain('space.behindCover');
    expect(JSON.stringify(buildCompileSchema(STARTING_VOCAB, []))).not.toContain('space.behindCover');
    const raw = {
      phrases: [{ condition: { id: 'always' }, preference: { id: 'space.behindCover' }, weight: 1 }],
      uncertainty: [],
    };
    expect(validateOutput(raw, FULL_VOCAB, [], 4).ok).toBe(true);
    expect(validateOutput(raw, STARTING_VOCAB, [], 4).ok).toBe(false);
  });
});
