import { describe, expect, it } from 'vitest';
import { type EntryCost, distanceField, posKey, reachableTiles } from '../src/grid.js';
import { applyLens } from '../src/lens.js';
import { AP_COST, type Fighter, decide, makeCtx } from '../src/scoring.js';
import { ARENA_H, ARENA_W, type Tile } from '../src/terrain.js';
import type { CombatUnit, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Труднопроходимость и взвешенный обход (план поля, шаг 4): вход в бурелом и
 * подъём в гору — 2 очка движения, спуск обычный; юнит с move: 1 всё равно
 * проходит свою одну клетку (гарантия минимального шага).
 */

const FREE = (): boolean => false;

/** Пустая схема 18×18 с точечными правками. */
function tilesWith(patch: (t: Tile[][]) => void): Tile[][] {
  const tiles = Array.from({ length: ARENA_H }, () => Array.from({ length: ARENA_W }, (): Tile => ({})));
  patch(tiles);
  return tiles;
}

/** Цена входа как в makeCtx — для юнит-тестов grid без контекста скоринга. */
function costOf(tiles: Tile[][]): EntryCost {
  const h = (p: Pos): number => tiles[p.y]?.[p.x]?.height ?? 0;
  return (from, to) => {
    const t = tiles[to.y]?.[to.x];
    return t?.rough || (t?.height ?? 0) > h(from) ? 2 : 1;
  };
}

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

const attackRule: Rule = {
  when: { kind: 'always' },
  then: { kind: 'attack', target: 'nearest' },
  weight: 2,
  scope: 'self',
  source: 'тест',
};

const has = (cells: Pos[], p: Pos): boolean => cells.some((c) => c.x === p.x && c.y === p.y);

describe('взвешенная достижимость', () => {
  it('вход в бурелом стоит 2: move 2 проходит одну клетку бурелома, не две', () => {
    const tiles = tilesWith((t) => {
      for (let x = 6; x <= 9; x++) t[5]![x] = { rough: true };
    });
    const cells = reachableTiles({ x: 5, y: 5 }, 2, FREE, FREE, costOf(tiles));
    expect(has(cells, { x: 6, y: 5 })).toBe(true); // первый бурелом: 2 очка
    expect(has(cells, { x: 7, y: 5 })).toBe(false); // второй: 2 + 2 > 2
  });

  it('move 3 по бурелому: клетка бурелома + одна обычная', () => {
    // колонна бурелома во всю высоту — по диагонали не обойти
    const tiles = tilesWith((t) => {
      for (let y = 0; y < ARENA_H; y++) t[y]![6] = { rough: true };
    });
    const cells = reachableTiles({ x: 5, y: 5 }, 3, FREE, FREE, costOf(tiles));
    expect(has(cells, { x: 7, y: 5 })).toBe(true); // 2 (бурелом) + 1 = 3
    expect(has(cells, { x: 8, y: 5 })).toBe(false); // дальше очков нет
  });

  it('гарантия минимального шага: move 1 входит в соседний бурелом, но не дальше', () => {
    const tiles = tilesWith((t) => {
      for (let x = 6; x <= 9; x++) for (let y = 4; y <= 6; y++) t[y]![x] = { rough: true };
    });
    const cells = reachableTiles({ x: 5, y: 5 }, 1, FREE, FREE, costOf(tiles));
    expect(has(cells, { x: 6, y: 5 })).toBe(true); // одну клетку — всегда
    expect(has(cells, { x: 7, y: 5 })).toBe(false);
  });

  it('подъём стоит 2, спуск обычный', () => {
    const tiles = tilesWith((t) => {
      for (let y = 0; y < ARENA_H; y++) for (let x = 8; x < ARENA_W; x++) t[y]![x] = { height: 1 };
    });
    // с равнины: подъём на (8,5) — 2 очка, дальше по плато очков нет
    const up = reachableTiles({ x: 7, y: 5 }, 2, FREE, FREE, costOf(tiles));
    expect(has(up, { x: 8, y: 5 })).toBe(true);
    expect(has(up, { x: 9, y: 5 })).toBe(false); // 2 + 1 > 2
    // с холма вниз: обе клетки за 2 очка
    const down = reachableTiles({ x: 8, y: 5 }, 2, FREE, FREE, costOf(tiles));
    expect(has(down, { x: 7, y: 5 })).toBe(true);
    expect(has(down, { x: 6, y: 5 })).toBe(true); // 1 + 1 = 2
  });

  it('поле дистанций асимметрично: в гору дороже, чем с горы', () => {
    const tiles = tilesWith((t) => {
      for (let y = 0; y < ARENA_H; y++) for (let x = 8; x < ARENA_W; x++) t[y]![x] = { height: 1 };
    });
    const toHill = distanceField({ x: 8, y: 5 }, FREE, costOf(tiles));
    expect(toHill.get(posKey({ x: 6, y: 5 }))).toBe(3); // 1 + подъём 2
    const toPlain = distanceField({ x: 6, y: 5 }, FREE, costOf(tiles));
    expect(toPlain.get(posKey({ x: 8, y: 5 }))).toBe(2); // спуск 1 + 1
  });
});

describe('тяга к цели и болото', () => {
  it('отряд огибает болото по чистому коридору, а не идёт напрямик', () => {
    // болото x 7–10 на всех рядах, кроме чистого коридора y ≤ 5
    const tiles = tilesWith((t) => {
      for (let y = 6; y < ARENA_H; y++) for (let x = 7; x <= 10; x++) t[y]![x] = { rough: true };
    });
    const ctx = makeCtx(FREE, tiles);
    const self = fighter('s', 'party', { x: 5, y: 9 }, { move: 2 }, [attackRule]);
    const enemy = fighter('e', 'foe', { x: 13, y: 9 }, { move: 0 });
    const visited: Pos[] = [];
    for (let round = 1; round <= 3; round++) {
      let ap = 3;
      while (ap > 0) {
        const d = decide(self, [self, enemy], round, FREE, ap, ctx);
        if (d.chosen.action !== 'move') break;
        self.pos = { ...d.chosen.to };
        visited.push({ ...self.pos });
        ap -= AP_COST.move;
      }
    }
    // дошёл до цели через коридор, а не по прямой через 4 клетки бурелома
    expect(visited.some((p) => p.y <= 6)).toBe(true);
    expect(Math.max(Math.abs(self.pos.x - 13), Math.abs(self.pos.y - 9))).toBeLessThanOrEqual(1);
  });
});
