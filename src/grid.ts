import type { Pos } from './types.js';

export const GRID_W = 8;
export const GRID_H = 8;

/** Дистанция Чебышёва: движение и смежность 8-направленные. */
export function dist(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function inBounds(p: Pos): boolean {
  return p.x >= 0 && p.x < GRID_W && p.y >= 0 && p.y < GRID_H;
}

export function posEq(a: Pos, b: Pos): boolean {
  return a.x === b.x && a.y === b.y;
}

export function posKey(p: Pos): string {
  return `${p.x},${p.y}`;
}

/** Клетки строго между a и b (Брезенхэм, концы не включаются). */
export function lineBetween(a: Pos, b: Pos): Pos[] {
  const pts: Pos[] = [];
  let x = a.x;
  let y = a.y;
  const dx = Math.abs(b.x - a.x);
  const dy = -Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1;
  const sy = a.y < b.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (x === b.x && y === b.y) break;
    if (!(x === a.x && y === a.y)) pts.push({ x, y });
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return pts;
}

/** Линия видимости: не блокируется, если ни одна промежуточная клетка не занята. */
export function hasLoS(a: Pos, b: Pos, isBlocked: (p: Pos) => boolean): boolean {
  return !lineBetween(a, b).some(isBlocked);
}

/**
 * Фланг: атакующий смежен с целью, и есть союзник атакующего, тоже смежный с целью,
 * с противоположной стороны (скалярное произведение направлений ≤ 0).
 */
export function isFlanking(attacker: Pos, target: Pos, allies: readonly Pos[]): boolean {
  if (dist(attacker, target) !== 1) return false;
  const v1 = { x: attacker.x - target.x, y: attacker.y - target.y };
  return allies.some((a) => {
    if (dist(a, target) !== 1 || posEq(a, attacker)) return false;
    const v2 = { x: a.x - target.x, y: a.y - target.y };
    return v1.x * v2.x + v1.y * v2.y <= 0;
  });
}

/**
 * Достижимые клетки BFS: нельзя входить в занятые; вход в зону контроля (ZoC)
 * останавливает движение — сквозь ZoC не пройти, но остановиться в ней можно.
 */
export function reachableTiles(
  from: Pos,
  move: number,
  isOccupied: (p: Pos) => boolean,
  isZoC: (p: Pos) => boolean,
): Pos[] {
  const visited = new Map<string, number>([[posKey(from), 0]]);
  const queue: Pos[] = [from];
  const out: Pos[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = visited.get(posKey(cur))!;
    if (d >= move) continue;
    if (isZoC(cur) && !posEq(cur, from)) continue; // зашёл в ZoC — дальше нельзя
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const next = { x: cur.x + dx, y: cur.y + dy };
        if (!inBounds(next) || visited.has(posKey(next)) || isOccupied(next)) continue;
        visited.set(posKey(next), d + 1);
        queue.push(next);
        out.push(next);
      }
    }
  }
  return out;
}
