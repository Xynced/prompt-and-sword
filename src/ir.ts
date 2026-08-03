import type { CombatUnit } from './types.js';
import { dist } from './grid.js';

/**
 * IR — промежуточное представление принципов. 12 концептов MVP:
 *   Условия:   hpBelow, outnumbered, allyInDanger   (+ always как часть грамматики)
 *   Селекторы: nearest, weakest, leader
 *   Действия:  attack, protect, holdPosition, retreat
 *   Простр.:   nearTo, behind
 */

export type Selector = 'nearest' | 'weakest' | 'leader';

export type Condition =
  | { kind: 'always' }
  | { kind: 'hpBelow'; who: 'self' | { ally: string }; frac: number }
  | { kind: 'outnumbered' }
  | { kind: 'allyInDanger'; ally: string };

/** Ссылка на позицию-якорь для пространственных предпочтений. */
export type PosRef = { type: 'ally'; id: string } | { type: 'enemy'; sel: Selector };

export type Preference =
  | { kind: 'attack'; target: Selector }
  | { kind: 'protect'; ally: string }
  | { kind: 'holdPosition' }
  | { kind: 'retreat' }
  | { kind: 'nearTo'; ref: PosRef }
  | { kind: 'behind'; ref: PosRef };

export interface Rule {
  when: Condition;
  then: Preference;
  weight: number;
  scope: 'self';
  /** Откуда правило (текст принципа / пометка линзы) — идёт в лог решений. */
  source: string;
}

export type CompiledPrinciple = Rule[];

// ---- Оценка против состояния боя ----

const byId = (units: readonly CombatUnit[], id: string): CombatUnit | undefined =>
  units.find((u) => u.id === id);

export function enemiesOf(self: CombatUnit, units: readonly CombatUnit[]): CombatUnit[] {
  return units.filter((u) => u.alive && u.side !== self.side);
}

export function alliesOf(self: CombatUnit, units: readonly CombatUnit[]): CombatUnit[] {
  return units.filter((u) => u.alive && u.side === self.side);
}

export function evalCondition(
  cond: Condition,
  self: CombatUnit,
  units: readonly CombatUnit[],
): boolean {
  switch (cond.kind) {
    case 'always':
      return true;
    case 'hpBelow': {
      const u = cond.who === 'self' ? self : byId(units, cond.who.ally);
      return !!u && u.alive && u.hp < cond.frac * u.maxHp;
    }
    case 'outnumbered':
      return enemiesOf(self, units).length > alliesOf(self, units).length;
    case 'allyInDanger': {
      const ally = byId(units, cond.ally);
      if (!ally || !ally.alive) return false;
      const adjEnemies = enemiesOf(self, units).filter((e) => dist(e.pos, ally.pos) === 1);
      return ally.hp < 0.5 * ally.maxHp || adjEnemies.length >= 2;
    }
  }
}

/** Разрешение селектора по врагам. Детерминированный тайбрейк по id. */
export function resolveSelector(
  sel: Selector,
  self: CombatUnit,
  units: readonly CombatUnit[],
): CombatUnit | undefined {
  const enemies = enemiesOf(self, units);
  if (enemies.length === 0) return undefined;
  const pick = (score: (u: CombatUnit) => number): CombatUnit =>
    enemies.reduce((best, u) => {
      const s = score(u);
      const bs = score(best);
      return s < bs || (s === bs && u.id < best.id) ? u : best;
    });
  switch (sel) {
    case 'nearest':
      return pick((u) => dist(u.pos, self.pos));
    case 'weakest':
      return pick((u) => u.hp);
    case 'leader':
      return enemies.find((u) => u.tags.includes('leader')) ?? pick((u) => dist(u.pos, self.pos));
  }
}

export function resolvePosRef(
  ref: PosRef,
  self: CombatUnit,
  units: readonly CombatUnit[],
): CombatUnit | undefined {
  if (ref.type === 'ally') {
    const u = byId(units, ref.id);
    return u && u.alive ? u : undefined;
  }
  return resolveSelector(ref.sel, self, units);
}

export function describePreference(p: Preference): string {
  switch (p.kind) {
    case 'attack':
      return `атаковать(${p.target})`;
    case 'protect':
      return `защищать(${p.ally})`;
    case 'holdPosition':
      return 'держать позицию';
    case 'retreat':
      return 'отступать';
    case 'nearTo':
      return `рядом с(${p.ref.type === 'ally' ? p.ref.id : p.ref.sel})`;
    case 'behind':
      return `позади(${p.ref.type === 'ally' ? p.ref.id : p.ref.sel})`;
  }
}
