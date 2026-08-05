import type { CombatUnit } from './types.js';
import { dist } from './grid.js';

/**
 * IR — промежуточное представление принципов. 12 концептов MVP:
 *   Условия:   hpBelow, outnumbered, allyInDanger   (+ always как часть грамматики)
 *   Селекторы: nearest, weakest, leader
 *   Действия:  attack, protect, holdPosition, retreat
 *   Простр.:   nearTo, behind
 * Поздний словарь (фаза 4):
 *   Условия:   battleDrags (бой затянулся), initiativeEdge (мы быстрее)
 *   Селекторы: mostDangerous, attacker (кто атаковал меня), marked (помеченный)
 *   Действия:  bait (приманка), trade (размен), coverRetreat (прикрывать отход),
 *              standoff (держать дистанцию)
 *   Простр.:   flank, avoidLineOfFire (вне линии огня), chokepoint (узкое место)
 * Глубокий словарь (фаза 6):
 *   Условия:   allyFallen (кто-то из наших пал), surrounded (меня окружили)
 *   Селекторы: shooter (стрелок), farthest (самый дальний)
 *   Действия:  brace (глухая оборона)
 *   Простр.:   awayFrom (держаться подальше от)
 * Манера удара (экономика хода):
 *   Действия:  strikeOften (бить часто), strikeHard (бить наверняка),
 *              strikeDesperate (бить отчаянно) — говорят, ЧЕМ бить; кого
 *              бить, по-прежнему решает отдельное правило attack
 * План поля:
 *   Простр.:   highGround (держать высоту), behindCover (за укрытием),
 *              avoidHazard (обходить опасное)
 */

export type Selector =
  | 'nearest'
  | 'weakest'
  | 'leader'
  | 'mostDangerous'
  | 'attacker'
  | 'marked'
  | 'shooter'
  | 'farthest';

/** С какого раунда бой считается затянувшимся. */
export const BATTLE_DRAGS_ROUND = 5;

export type Condition =
  | { kind: 'always' }
  | { kind: 'hpBelow'; who: 'self' | { ally: string }; frac: number }
  | { kind: 'outnumbered' }
  | { kind: 'allyInDanger'; ally: string }
  | { kind: 'battleDrags' }
  | { kind: 'initiativeEdge' }
  | { kind: 'allyFallen' }
  | { kind: 'surrounded' };

/** Ссылка на позицию-якорь для пространственных предпочтений. */
export type PosRef = { type: 'ally'; id: string } | { type: 'enemy'; sel: Selector };

export type Preference =
  | { kind: 'attack'; target: Selector }
  | { kind: 'protect'; ally: string }
  | { kind: 'holdPosition' }
  | { kind: 'retreat' }
  | { kind: 'nearTo'; ref: PosRef }
  | { kind: 'behind'; ref: PosRef }
  | { kind: 'bait' }
  | { kind: 'trade' }
  | { kind: 'coverRetreat' }
  | { kind: 'standoff' }
  | { kind: 'flank' }
  | { kind: 'avoidLineOfFire' }
  | { kind: 'chokepoint' }
  | { kind: 'brace' }
  | { kind: 'awayFrom'; ref: PosRef }
  // манера удара: не «кого бить», а «чем бить» — тратится ли ход на много
  // дешёвых замахов, на один полный или на отчаянный размен
  | { kind: 'strikeOften' }
  | { kind: 'strikeHard' }
  | { kind: 'strikeDesperate' }
  | { kind: 'highGround' }
  | { kind: 'behindCover' }
  | { kind: 'avoidHazard' };

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
  round = 1,
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
    case 'battleDrags':
      return round >= BATTLE_DRAGS_ROUND;
    case 'initiativeEdge': {
      const avg = (us: readonly CombatUnit[]): number =>
        us.length === 0 ? 0 : us.reduce((s, u) => s + u.speed, 0) / us.length;
      const enemies = enemiesOf(self, units);
      return enemies.length > 0 && avg(alliesOf(self, units)) > avg(enemies);
    }
    case 'allyFallen':
      return units.some((u) => u.side === self.side && u.id !== self.id && !u.alive);
    case 'surrounded':
      return enemiesOf(self, units).filter((e) => dist(e.pos, self.pos) === 1).length >= 2;
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
    case 'mostDangerous':
      return pick((u) => -u.atk);
    case 'attacker':
      // кто атаковал меня последним; пока не били — ближайший
      return enemies.find((u) => u.id === self.lastAttackerId) ?? pick((u) => dist(u.pos, self.pos));
    case 'marked':
      // помеченный игроком перед боем; метки нет (или помеченный пал) — ближайший
      return enemies.find((u) => u.tags.includes('marked')) ?? pick((u) => dist(u.pos, self.pos));
    case 'shooter': {
      // ближайший вражеский стрелок; стрелков нет — просто ближайший
      const shooters = enemies.filter((u) => u.range > 1);
      if (shooters.length === 0) return pick((u) => dist(u.pos, self.pos));
      return shooters.reduce((best, u) => {
        const s = dist(u.pos, self.pos);
        const bs = dist(best.pos, self.pos);
        return s < bs || (s === bs && u.id < best.id) ? u : best;
      });
    }
    case 'farthest':
      return pick((u) => -dist(u.pos, self.pos));
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
    case 'bait':
      return 'приманка';
    case 'trade':
      return 'размен';
    case 'coverRetreat':
      return 'прикрывать отход';
    case 'standoff':
      return 'держать дистанцию';
    case 'flank':
      return 'заходить во фланг';
    case 'avoidLineOfFire':
      return 'вне линии огня';
    case 'chokepoint':
      return 'узкое место';
    case 'brace':
      return 'глухая оборона';
    case 'awayFrom':
      return `подальше от(${p.ref.type === 'ally' ? p.ref.id : p.ref.sel})`;
    case 'strikeOften':
      return 'бить часто';
    case 'strikeHard':
      return 'бить наверняка';
    case 'strikeDesperate':
      return 'бить отчаянно';
    case 'highGround':
      return 'держать высоту';
    case 'behindCover':
      return 'за укрытием';
    case 'avoidHazard':
      return 'обходить опасное';
  }
}
