import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import { AP_COST, type Fighter, decide, makeCtx, scoreCandidate } from '../src/scoring.js';
import { ARENA_H, ARENA_W, type Tile } from '../src/terrain.js';
import { compilePhrase } from '../src/constructor.js';
import { CONCEPTS, COMMON_WORDS, RARE_WORDS, STARTING_VOCAB, type ConceptId } from '../src/vocab.js';
import { understandingCard } from '../src/cards.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import type { CombatUnit, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Слова рельефа: «стеречь кромку» (ждать у труднопроходной земли, не ступая
 * на неё) и «обходить из-за спин» (заходить врагу сбоку, не выходя вперёд
 * своих).
 */

const FULL_VOCAB = Object.keys(CONCEPTS) as ConceptId[];

const FREE = (): boolean => false;

/** Пустая схема 18×18 с точечными правками. */
function tilesWith(patch: (t: Tile[][]) => void): Tile[][] {
  const tiles = Array.from({ length: ARENA_H }, () => Array.from({ length: ARENA_W }, (): Tile => ({})));
  patch(tiles);
  return tiles;
}

/** Полоса бурелома x7–10 во всю высоту — как гать, но без просветов. */
const beltTiles = (): Tile[][] =>
  tilesWith((t) => {
    for (let y = 0; y < ARENA_H; y++) for (let x = 7; x <= 10; x++) t[y]![x] = { rough: true };
  });

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
    guard: 0,
    exposed: false,
    tags: [],
    lenses: ['plain'],
    ...over,
    compiled: applyLens(['plain'], rules),
  };
}

const rule = (then: Rule['then'], weight = 1.5): Rule => ({
  when: { kind: 'always' },
  then,
  weight,
  scope: 'self',
  source: 'тест',
});

describe('слово «стеречь кромку»', () => {
  it('стрелок подходит к кромке бурелома со стороны врага и не ступает на неё', () => {
    const tiles = beltTiles();
    const ctx = makeCtx(FREE, tiles);
    const self = fighter('s', 'party', { x: 3, y: 8 }, { range: 4, move: 2 }, [rule({ kind: 'roughEdge' })]);
    const enemy = fighter('e', 'foe', { x: 15, y: 8 }, { move: 0 });
    for (let round = 1; round <= 3; round++) {
      let ap = 3;
      while (ap > 0) {
        const d = decide(self, [self, enemy], round, FREE, ap, ctx);
        if (d.chosen.action !== 'move') break;
        self.pos = { ...d.chosen.to };
        ap -= AP_COST.move;
      }
    }
    expect(self.pos.x).toBe(6); // западная кромка: бурелом со стороны врага
    expect(ctx.roughAt(self.pos)).toBe(false);
  });

  it('стоящий в буреломе сходит на кромку, а не вглубь', () => {
    const tiles = beltTiles();
    const ctx = makeCtx(FREE, tiles);
    const self = fighter('s', 'party', { x: 8, y: 8 }, { range: 4 }, [rule({ kind: 'roughEdge' })]);
    const enemy = fighter('e', 'foe', { x: 15, y: 8 }, { move: 0 });
    const d = decide(self, [self, enemy], 1, FREE, 3, ctx);
    expect(d.chosen.action).toBe('move');
    expect(ctx.roughAt(d.chosen.to)).toBe(false);
    expect(d.chosen.to.x).toBeLessThan(7); // на свою сторону, не сквозь полосу к врагу
  });

  it('на арене без бурелома слово молчит', () => {
    const ctx = makeCtx(FREE, tilesWith(() => {}));
    const self = fighter('s', 'party', { x: 3, y: 8 }, { range: 4 }, [rule({ kind: 'roughEdge' })]);
    const enemy = fighter('e', 'foe', { x: 15, y: 8 }, { move: 0 });
    for (const to of [self.pos, { x: 4, y: 8 }, { x: 2, y: 8 }]) {
      const factors = scoreCandidate({ to, action: 'move' }, self, [self, enemy], self.compiled.rules, ctx);
      expect(factors.some((f) => f.label.startsWith('правило:'))).toBe(false);
    }
  });
});

describe('слово «обходить из-за спин»', () => {
  it('смещает бойца вбок от оси «наши → враги»', () => {
    const ctx = makeCtx(FREE);
    const self = fighter('s', 'party', { x: 2, y: 8 }, {}, [rule({ kind: 'outflank' })]);
    const mate = fighter('m', 'party', { x: 3, y: 8 });
    const e1 = fighter('e1', 'foe', { x: 15, y: 8 }, { move: 0 });
    const e2 = fighter('e2', 'foe', { x: 15, y: 9 }, { move: 0 });
    const d = decide(self, [self, mate, e1, e2], 1, FREE, 3, ctx);
    expect(d.chosen.action).toBe('move');
    expect(d.chosen.to.y).toBe(11); // максимум бокового смещения за один шаг
  });

  it('клетка впереди своих штрафуется, за спинами — нет', () => {
    const ctx = makeCtx(FREE);
    const self = fighter('s', 'party', { x: 4, y: 8 }, {}, [rule({ kind: 'outflank' })]);
    const mate = fighter('m', 'party', { x: 3, y: 8 });
    const enemy = fighter('e', 'foe', { x: 10, y: 8 }, { move: 0 });
    const units = [self, mate, enemy];
    const fired = self.compiled.rules;
    const front = scoreCandidate({ to: { x: 6, y: 8 }, action: 'move' }, self, units, fired, ctx);
    const back = scoreCandidate({ to: { x: 2, y: 8 }, action: 'move' }, self, units, fired, ctx);
    expect(front.some((f) => f.label.startsWith('правило:') && f.value < 0)).toBe(true);
    expect(back.some((f) => f.label.startsWith('правило:'))).toBe(false);
  });

  it('без живых своих слово молчит', () => {
    const ctx = makeCtx(FREE);
    const self = fighter('s', 'party', { x: 2, y: 8 }, {}, [rule({ kind: 'outflank' })]);
    const enemy = fighter('e', 'foe', { x: 15, y: 8 }, { move: 0 });
    for (const to of [self.pos, { x: 2, y: 11 }, { x: 5, y: 8 }]) {
      const factors = scoreCandidate({ to, action: 'move' }, self, [self, enemy], self.compiled.rules, ctx);
      expect(factors.some((f) => f.label.startsWith('правило:'))).toBe(false);
    }
  });
});

describe('слова рельефа в словаре', () => {
  it('кромка — обычное, обход — редкое; компилируются при открытом словаре и закрыты в стартовом', () => {
    expect(COMMON_WORDS).toContain('space.roughEdge');
    expect(RARE_WORDS).toContain('space.outflank');
    for (const [word, kind] of [
      ['space.roughEdge', 'roughEdge'],
      ['space.outflank', 'outflank'],
    ] as const) {
      expect(STARTING_VOCAB).not.toContain(word);
      const draft = { condition: { id: 'always' }, preference: { id: word } } as const;
      const ok = compilePhrase(draft, FULL_VOCAB);
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.rule.then).toEqual({ kind });
      const closed = compilePhrase(draft, STARTING_VOCAB);
      expect(closed.ok).toBe(false);
      if (!closed.ok) expect(closed.missing).toEqual([word]);
    }
  });

  it('карточка читает оба слова', () => {
    const card = understandingCard({ name: 'Дарт', lenses: ['plain'] }, [
      rule({ kind: 'roughEdge' }),
      rule({ kind: 'outflank' }),
    ]);
    expect(card.lines[0]).toContain('стерегу кромку');
    expect(card.lines[1]).toContain('обхожу из-за спин');
  });

  it('в LLM-схеме и валидации только при открытом словаре', () => {
    for (const word of ['space.roughEdge', 'space.outflank'] as const) {
      expect(JSON.stringify(buildCompileSchema(FULL_VOCAB, []))).toContain(word);
      expect(JSON.stringify(buildCompileSchema(STARTING_VOCAB, []))).not.toContain(word);
      const raw = {
        phrases: [{ condition: { id: 'always' }, preference: { id: word }, weight: 1 }],
        uncertainty: [],
      };
      expect(validateOutput(raw, FULL_VOCAB, [], 4).ok).toBe(true);
      expect(validateOutput(raw, STARTING_VOCAB, [], 4).ok).toBe(false);
    }
  });
});
