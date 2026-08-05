import type { Pos } from './types.js';

export const GRID_W = 18;
export const GRID_H = 18;

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
 * Каменное укрытие (гибрид): камень даёт цели укрытие от выстрела, если он
 * смежен цели и лежит со стороны стрелка (скалярное произведение направлений
 * > 0); камень, смежный и стрелку, и цели, — всегда укрытие (он же латает
 * диагональную щель Брезенхэма). Вплотную (дист ≤ 1) укрытия нет.
 *
 * Согласовано с LoS: камень, смежный цели, для выстрела не стена, а укрытие
 * (см. canAttackFrom) — любой «мягкий» камень на линии обязан давать укрытие,
 * иначе выстрел сквозь него шёл бы в полную силу.
 */
export function hasTerrainCover(shooter: Pos, target: Pos, isBlocked: (p: Pos) => boolean): boolean {
  if (dist(shooter, target) <= 1) return false;
  const vx = shooter.x - target.x;
  const vy = shooter.y - target.y;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const rock = { x: target.x + dx, y: target.y + dy };
      if (!isBlocked(rock)) continue;
      if (dist(rock, shooter) === 1) return true; // смежен обоим
      if (dx * vx + dy * vy > 0) return true; // со стороны стрелка
    }
  }
  return false;
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
 * Цена входа в клетку `to` из клетки `from`, в очках движения. По умолчанию
 * всё по 1; труднопроходимость и подъём делают вход дороже (план поля).
 */
export type EntryCost = (from: Pos, to: Pos) => number;
const UNIT_COST: EntryCost = () => 1;

/**
 * Поле дистанций от точки по проходимым клеткам (обход террейна): значение —
 * цена пути ИЗ клетки К точке `from` в очках движения (юнит идёт к цели, поэтому
 * при развороте рёбра цена входа считается в направлении юнита — подъём и спуск
 * несимметричны). Бакетная Дейкстра; при единичных ценах совпадает с BFS.
 * Ключ — posKey; заблокированные и отрезанные клетки в карте отсутствуют.
 */
export function distanceField(
  from: Pos,
  isBlocked: (p: Pos) => boolean,
  entryCost: EntryCost = UNIT_COST,
): Map<string, number> {
  const field = new Map<string, number>([[posKey(from), 0]]);
  const buckets: Pos[][] = [[from]];
  for (let d = 0; d < buckets.length; d++) {
    for (const cur of buckets[d] ?? []) {
      if (field.get(posKey(cur)) !== d) continue; // устаревшая запись
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const next = { x: cur.x + dx, y: cur.y + dy };
          if (!inBounds(next) || isBlocked(next)) continue;
          // юнит шагает next → cur, значит платит за вход в cur со стороны next
          const nd = d + entryCost(next, cur);
          const k = posKey(next);
          const old = field.get(k);
          if (old !== undefined && old <= nd) continue;
          field.set(k, nd);
          (buckets[nd] ??= []).push(next);
        }
      }
    }
  }
  return field;
}

/**
 * Достижимые за один шаг клетки (взвешенно): нельзя входить в занятые; вход в
 * зону контроля (ZoC) останавливает движение — сквозь ZoC не пройти, но
 * остановиться в ней можно. Гарантия минимального шага: соседняя клетка
 * достижима всегда, даже если вход дороже всего запаса, — но съедает его
 * целиком (юнит с move: 1 всё равно проходит свою одну клетку бурелома).
 */
export function reachableTiles(
  from: Pos,
  move: number,
  isOccupied: (p: Pos) => boolean,
  isZoC: (p: Pos) => boolean,
  entryCost: EntryCost = UNIT_COST,
): Pos[] {
  const best = new Map<string, number>([[posKey(from), 0]]);
  const out: Pos[] = [from];
  const inOut = new Set<string>([posKey(from)]);
  const buckets: Pos[][] = [[from]];
  for (let d = 0; d < buckets.length; d++) {
    for (const cur of buckets[d] ?? []) {
      if (best.get(posKey(cur)) !== d) continue; // устаревшая запись
      if (d >= move) continue; // очки движения кончились
      if (isZoC(cur) && !posEq(cur, from)) continue; // зашёл в ZoC — дальше нельзя
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const next = { x: cur.x + dx, y: cur.y + dy };
          if (!inBounds(next) || isOccupied(next)) continue;
          // гарантия минимального шага — цена первого входа не выше запаса
          const nd = posEq(cur, from) ? Math.min(d + entryCost(cur, next), move) : d + entryCost(cur, next);
          if (nd > move) continue;
          const k = posKey(next);
          const old = best.get(k);
          if (old !== undefined && old <= nd) continue;
          best.set(k, nd);
          (buckets[nd] ??= []).push(next);
          if (!inOut.has(k)) {
            inOut.add(k);
            out.push(next);
          }
        }
      }
    }
  }
  return out;
}
