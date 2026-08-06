import type { Rule } from './ir.js';
import type { PhraseDraft } from './constructor.js';
import type { AoeSpec, Pos } from './types.js';
import { type Rng, shuffle } from './rng.js';

/**
 * Пул героев забега. Партия из 3 выбирается детерминированно сидом:
 * 1 передовой (range 1, якорь строя) + 2 любых других — каждый забег
 * читает приказы другой состав.
 *
 * Способность — врождённое правило архетипа. Добавляется к приказам ДО линз,
 * поэтому характер искажает и её (у фанатика «Чутьё» Лии превращается
 * в «не отступать»). В карточке «как понял» помечается «· способность».
 */

export type HeroRole = 'front' | 'melee' | 'ranged';

export interface HeroArchetype {
  id: string;
  name: string;
  role: HeroRole;
  stats: { maxHp: number; atk: number; range: number; speed: number; move: number };
  ability: { name: string; desc: string };
  /** Врождённые правила способности; в source — префикс «способность:». */
  innate: Rule[];
  /** Площадное оружие носителя (план АОЕ); использование гейтится словом «накрыть скопление». */
  aoe?: AoeSpec;
}

const r = (rule: Omit<Rule, 'scope'>): Rule => ({ ...rule, scope: 'self' });

export const HERO_POOL: readonly HeroArchetype[] = [
  {
    id: 'grom',
    name: 'Гром',
    role: 'front',
    stats: { maxHp: 80, atk: 8, range: 1, speed: 5, move: 2 },
    ability: { name: 'Оплот', desc: 'сам встаёт между врагом и самым раненым из своих' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'coverRetreat' }, weight: 0.9, source: 'способность: Оплот' }),
    ],
  },
  {
    id: 'dart',
    name: 'Дарт',
    role: 'ranged',
    stats: { maxHp: 48, atk: 6, range: 5, speed: 6, move: 2 },
    ability: { name: 'Подранок', desc: 'не может не добить раненого' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 0.8, source: 'способность: Подранок' }),
    ],
  },
  {
    id: 'lia',
    name: 'Лия',
    role: 'ranged',
    stats: { maxHp: 40, atk: 8, range: 4, speed: 4, move: 1 },
    ability: { name: 'Чутьё', desc: 'отходит сама, когда дело пахнет жареным' },
    innate: [
      r({
        when: { kind: 'hpBelow', who: 'self', frac: 0.4 },
        then: { kind: 'retreat' },
        weight: 1.5,
        source: 'способность: Чутьё',
      }),
    ],
  },
  {
    id: 'skala',
    name: 'Скала',
    role: 'front',
    stats: { maxHp: 96, atk: 5, range: 1, speed: 3, move: 1 },
    ability: { name: 'Глыба', desc: 'где поставили — там и стоит' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'holdPosition' }, weight: 0.8, source: 'способность: Глыба' }),
    ],
  },
  {
    id: 'tessa',
    name: 'Тесса',
    role: 'melee',
    stats: { maxHp: 44, atk: 7, range: 1, speed: 7, move: 3 },
    ability: { name: 'Из-за спины', desc: 'заходит сбоку и бьёт вдвоём' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'flank' }, weight: 1.2, source: 'способность: Из-за спины' }),
    ],
  },
  {
    id: 'zhalo',
    name: 'Жало',
    role: 'melee',
    stats: { maxHp: 60, atk: 6, range: 2, speed: 5, move: 2 },
    ability: { name: 'Выпад', desc: 'колет в размен, когда укол того стоит' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'trade' }, weight: 0.9, source: 'способность: Выпад' }),
    ],
    // спеллблейд: длинное копьё умеет бить волной по линии — оружие есть
    // всегда, но без слова «накрыть скопление» волна не случается
    aoe: { line: { len: 4, mult: 0.75 } },
  },
  {
    id: 'ulv',
    name: 'Ульв',
    role: 'front',
    stats: { maxHp: 68, atk: 9, range: 1, speed: 6, move: 2 },
    ability: { name: 'Ярость', desc: 'если бой затянулся — бросается на ближайшего' },
    innate: [
      r({
        when: { kind: 'battleDrags' },
        then: { kind: 'attack', target: 'nearest' },
        weight: 2,
        source: 'способность: Ярость',
      }),
    ],
  },
  {
    id: 'mara',
    name: 'Мара',
    role: 'ranged',
    stats: { maxHp: 36, atk: 7, range: 6, speed: 6, move: 1 },
    ability: { name: 'Скрадывание', desc: 'не выходит на линию вражеского выстрела' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'avoidLineOfFire' }, weight: 1, source: 'способность: Скрадывание' }),
    ],
  },
  {
    id: 'yar',
    name: 'Яр',
    role: 'front',
    stats: { maxHp: 56, atk: 7, range: 1, speed: 5, move: 2 },
    ability: { name: 'Вызов', desc: 'признаёт только самого опасного противника' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'mostDangerous' }, weight: 0.9, source: 'способность: Вызов' }),
    ],
  },
];

const POOL_BY_ID = new Map(HERO_POOL.map((h) => [h.id, h]));

export function heroArchetype(id: string): HeroArchetype {
  const arch = POOL_BY_ID.get(id);
  if (!arch) throw new Error(`Неизвестный архетип героя: ${id}`);
  return arch;
}

/** Точки спавна партии по слоту: [0] — передовой, [1]–[2] — задняя линия. */
export const PARTY_SPAWNS: readonly Pos[] = [
  { x: 2, y: 8 },
  { x: 1, y: 4 },
  { x: 1, y: 13 },
];

/** Партия забега: 1 передовой + 2 других, детерминированно от rng. */
export function pickParty(rng: Rng): HeroArchetype[] {
  const front = shuffle(HERO_POOL.filter((h) => h.role === 'front'), rng)[0]!;
  const rest = shuffle(HERO_POOL.filter((h) => h.id !== front.id), rng).slice(0, 2);
  return [front, ...rest];
}

/**
 * Стартовые принципы архетипа — наивный дефолт из нищего стартового словаря
 * (атаковать/ближайший/отступать): все рубят ближайшего. Урок первого боя —
 * переписать это в кайт.
 */
export function defaultPhrasesFor(_arch: HeroArchetype, _party: readonly HeroArchetype[]): PhraseDraft[] {
  return [{ condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.nearest' } }];
}
