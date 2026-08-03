import { describe, expect, it } from 'vitest';
import { dist, hasLoS, isFlanking, lineBetween, posEq, reachableTiles } from '../src/grid.js';

describe('dist (Чебышёв)', () => {
  it('диагональ считается за 1', () => {
    expect(dist({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(1);
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 1 })).toBe(3);
    expect(dist({ x: 2, y: 2 }, { x: 2, y: 2 })).toBe(0);
  });
});

describe('lineBetween / hasLoS', () => {
  it('прямая линия по горизонтали', () => {
    const pts = lineBetween({ x: 0, y: 0 }, { x: 3, y: 0 });
    expect(pts).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
  });

  it('концы не включаются', () => {
    const pts = lineBetween({ x: 0, y: 0 }, { x: 2, y: 2 });
    expect(pts.some((p) => posEq(p, { x: 0, y: 0 }))).toBe(false);
    expect(pts.some((p) => posEq(p, { x: 2, y: 2 }))).toBe(false);
  });

  it('LoS блокируется юнитом между', () => {
    const blocker = { x: 2, y: 0 };
    expect(hasLoS({ x: 0, y: 0 }, { x: 4, y: 0 }, (p) => posEq(p, blocker))).toBe(false);
    expect(hasLoS({ x: 0, y: 0 }, { x: 4, y: 2 }, (p) => posEq(p, blocker))).toBe(true);
  });

  it('смежные клетки всегда видны', () => {
    expect(hasLoS({ x: 1, y: 1 }, { x: 2, y: 2 }, () => true)).toBe(true);
  });
});

describe('isFlanking', () => {
  const target = { x: 3, y: 3 };
  it('атакующий и союзник с противоположных сторон — фланг', () => {
    expect(isFlanking({ x: 2, y: 3 }, target, [{ x: 4, y: 3 }])).toBe(true);
    expect(isFlanking({ x: 2, y: 2 }, target, [{ x: 4, y: 4 }])).toBe(true);
  });
  it('перпендикулярные стороны — тоже фланг (dot = 0)', () => {
    expect(isFlanking({ x: 2, y: 3 }, target, [{ x: 3, y: 4 }])).toBe(true);
  });
  it('союзник с той же стороны — не фланг', () => {
    expect(isFlanking({ x: 2, y: 3 }, target, [{ x: 2, y: 2 }])).toBe(false);
  });
  it('атакующий не смежен — не фланг', () => {
    expect(isFlanking({ x: 1, y: 3 }, target, [{ x: 4, y: 3 }])).toBe(false);
  });
  it('союзник не смежен с целью — не фланг', () => {
    expect(isFlanking({ x: 2, y: 3 }, target, [{ x: 5, y: 3 }])).toBe(false);
  });
});

describe('reachableTiles', () => {
  it('включает стартовую клетку и уважает радиус', () => {
    const tiles = reachableTiles({ x: 0, y: 0 }, 1, () => false, () => false);
    expect(tiles.some((p) => posEq(p, { x: 0, y: 0 }))).toBe(true);
    expect(tiles.some((p) => posEq(p, { x: 1, y: 1 }))).toBe(true);
    expect(tiles.some((p) => posEq(p, { x: 2, y: 0 }))).toBe(false);
  });

  it('занятые клетки непроходимы', () => {
    const wall = (p: { x: number; y: number }): boolean => p.x === 1; // стена x=1
    const tiles = reachableTiles({ x: 0, y: 3 }, 3, wall, () => false);
    expect(tiles.some((p) => p.x >= 1)).toBe(false);
  });

  it('вход в ZoC останавливает движение', () => {
    const zoc = (p: { x: number; y: number }): boolean => p.x === 2;
    const tiles = reachableTiles({ x: 0, y: 3 }, 4, () => false, zoc);
    // в ZoC войти можно…
    expect(tiles.some((p) => p.x === 2)).toBe(true);
    // …но сквозь неё не пройти
    expect(tiles.some((p) => p.x >= 3)).toBe(false);
  });
});
