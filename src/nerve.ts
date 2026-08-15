/**
 * Нерв (план nerve): seeded-разброс весов решения. Включается режимом
 * (`BattleSetup.nerve`), по умолчанию выключен — без него бой считается ровно
 * как раньше, побайтово.
 *
 * Источник разброса — **хеш** от (сид боя, юнит, раунд, остаток AP, метка
 * слагаемого), а не `rng()`: новый вызов rng сдвинул бы общую последовательность
 * боя и переписал броски урона (прецедент шипов). Хеш детерминирован так же,
 * но ничего не сдвигает: тот же seed + те же принципы = тот же бой.
 */

import type { CombatUnit } from './types.js';
import { situationHash } from './rng.js';
import { dist } from './grid.js';
import { NERVE_BLIND, NERVE_CROWD, NERVE_HURT } from './tuning.js';

/** Настройка режима в контексте решения. */
export interface NerveSpec {
  /** Амплитуда разброса при давлении 1; 0 — режим выключен. */
  amp: number;
  /** Сид боя — привязывает разброс к «тем же костям». */
  seed: number;
}

/**
 * Бросок разброса в [-1, 1] для одной метки одного решения. Распределение
 * треугольное (сумма двух половин хеша): обычно боец судит здраво, сильный
 * перекос редок.
 */
export function nerveRoll(
  seed: number,
  unitId: string,
  round: number,
  ap: number,
  label: string,
): number {
  const h = situationHash(seed, unitId, round, ap, label);
  const u1 = (h >>> 16) / 65536;
  const u2 = (h & 0xffff) / 65536;
  return u1 + u2 - 1;
}

/**
 * Давление ситуации в [0, 1]: насколько бойцу сейчас не до счёта. В затишье, на
 * полном здоровье и с сработавшим приказом — 0, и решение строго
 * детерминированное даже при включённом режиме.
 */
export function nervePressure(
  self: CombatUnit,
  units: readonly CombatUnit[],
  firedCount: number,
): number {
  const hurt = 1 - self.hp / self.maxHp;
  const contact = units.filter(
    (u) => u.alive && u.side !== self.side && dist(u.pos, self.pos) === 1,
  ).length;
  const crowd = Math.min(1, contact / 2);
  const blind = firedCount === 0 ? 1 : 0;
  const p = NERVE_HURT * hurt + NERVE_CROWD * crowd + NERVE_BLIND * blind;
  return Math.min(1, Math.max(0, p));
}
