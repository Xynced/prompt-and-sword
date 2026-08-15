/**
 * Seeded PRNG (mulberry32) и seeded-хеш. Единственные источники случайности
 * в боевом ядре.
 *
 * Разница между ними принципиальная. Поток `rng()` хорош там, где розыгрыш
 * один на бой (расстановка): каждый вызов сдвигает последовательность, поэтому
 * лишний вызов переписывает всё, что случится дальше. Хеш от ключа ситуации
 * (сид, юнит, раунд, остаток AP, метка) ничего не сдвигает: бросок привязан
 * к тому, **кто, когда и по кому** его делает, — и остаётся тем же, сколько бы
 * бросков ни случилось рядом. На нём стоят нерв (план nerve) и броски атаки со
 * спасбросками (план damage-types): партия без смены приказов играется
 * побайтово так же, а спарринг «те же кости» остаётся честным сравнением.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Детерминированный Фишер-Йейтс. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/** Смешение 32-битного состояния с числом. */
export function mix(h: number, x: number): number {
  const m = Math.imul(h ^ x, 0x9e3779b1) >>> 0;
  return (m ^ (m >>> 15)) >>> 0;
}

/** Смешение состояния со строкой (id юнита, метка слагаемого). */
export function mixStr(h: number, s: string): number {
  let acc = h;
  for (let i = 0; i < s.length; i++) acc = mix(acc, s.charCodeAt(i));
  return mix(acc, s.length);
}

/**
 * Хеш ключа ситуации: сид боя + кто + когда + сколько очков хода осталось +
 * метка. Одинаковый ключ — одинаковое число, соседние ключи независимы.
 */
export function situationHash(
  seed: number,
  unitId: string,
  round: number,
  ap: number,
  label: string,
): number {
  let h = mix(seed >>> 0, 0x6d2b79f5);
  h = mixStr(h, unitId);
  h = mix(h, round);
  h = mix(h, ap);
  return mixStr(h, label);
}
