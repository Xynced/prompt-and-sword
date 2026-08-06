import type { Rule } from './ir.js';
import type { PhraseDraft } from './constructor.js';
import type { Pos, WeaponSpec } from './types.js';
import { type Rng, shuffle } from './rng.js';

/**
 * Пул героев забега. Партия из 3 выбирается детерминированно сидом:
 * 1 передовой (якорь строя) + 2 любых других — каждый забег
 * читает приказы другой состав.
 *
 * Способность — врождённое правило архетипа. Добавляется к приказам ДО линз,
 * поэтому характер искажает и её (у фанатика «Чутьё» Лии превращается
 * в «не отступать»). В карточке «как понял» помечается «· способность».
 *
 * План классов: герой = вариант класса pf2e; урон и дальность живут на
 * оружии (`weapons`, 1–3 штуки), у героя остаются hp/инициатива/шаг.
 * Площадные формы — в `WeaponSpec.aoe`; каст гейтится словом.
 */

export type HeroRole = 'front' | 'melee' | 'ranged';

export interface HeroArchetype {
  id: string;
  name: string;
  role: HeroRole;
  stats: { maxHp: number; speed: number; move: number };
  /** Оружие варианта класса; у мастера — несколько, выбирает по ситуации. */
  weapons: WeaponSpec[];
  ability: { name: string; desc: string };
  /** Врождённые правила способности; в source — префикс «способность:». */
  innate: Rule[];
}

const r = (rule: Omit<Rule, 'scope'>): Rule => ({ ...rule, scope: 'self' });

export const HERO_POOL: readonly HeroArchetype[] = [
  {
    // воин-щитоносец: щит любит бить наверняка и не любит открываться
    id: 'grom',
    name: 'Гром',
    role: 'front',
    stats: { maxHp: 80, speed: 5, move: 2 },
    weapons: [{ name: 'меч и щит', dmg: 8, range: 1, affinity: { attack: 1, selflessAttack: -1 } }],
    ability: { name: 'Оплот', desc: 'сам встаёт между врагом и самым раненым из своих' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'coverRetreat' }, weight: 0.9, source: 'способность: Оплот' }),
    ],
  },
  {
    // следопыт-охотник
    id: 'dart',
    name: 'Дарт',
    role: 'ranged',
    stats: { maxHp: 48, speed: 6, move: 2 },
    weapons: [{ name: 'длинный лук', dmg: 6, range: 5 }],
    ability: { name: 'Подранок', desc: 'не может не добить раненого' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 0.8, source: 'способность: Подранок' }),
    ],
  },
  {
    id: 'lia',
    name: 'Лия',
    role: 'ranged',
    stats: { maxHp: 40, speed: 4, move: 1 },
    // волшебница-эвокер: залп и ритуал — оба раз в бой; без слова «накрыть
    // скопление» оружие молчит. Дальность ритуала 6 (не 4): с move 1 Лия
    // кастует по бегущим издали, и центр должен дотягиваться до скопления,
    // а не цеплять его краем зоны
    weapons: [
      {
        name: 'жезл',
        dmg: 8,
        range: 4,
        aoe: {
          blast: { range: 4, mult: 0.75, usesPerBattle: 1 },
          ritual: { range: 6, mult: 1.2, usesPerBattle: 1 },
        },
      },
    ],
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
    // паладин-бастион
    id: 'skala',
    name: 'Скала',
    role: 'front',
    stats: { maxHp: 96, speed: 3, move: 1 },
    weapons: [{ name: 'щит-башня', dmg: 5, range: 1 }],
    ability: { name: 'Глыба', desc: 'где поставили — там и стоит' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'holdPosition' }, weight: 0.8, source: 'способность: Глыба' }),
    ],
  },
  {
    // плут «в спину»: кинжалы любят частые уколы
    id: 'tessa',
    name: 'Тесса',
    role: 'melee',
    stats: { maxHp: 44, speed: 7, move: 3 },
    weapons: [{ name: 'кинжалы', dmg: 7, range: 1, affinity: { weakAttack: 1 } }],
    ability: { name: 'Из-за спины', desc: 'заходит сбоку и бьёт вдвоём' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'flank' }, weight: 1.2, source: 'способность: Из-за спины' }),
    ],
  },
  {
    // монах-копейщик: длинное копьё умеет бить волной по линии — оружие есть
    // всегда, но без слова «накрыть скопление» волна не случается
    id: 'zhalo',
    name: 'Жало',
    role: 'melee',
    stats: { maxHp: 60, speed: 5, move: 2 },
    weapons: [{ name: 'копьё ци', dmg: 6, range: 2, aoe: { line: { len: 4, mult: 0.75 } } }],
    ability: { name: 'Выпад', desc: 'колет в размен, когда укол того стоит' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'trade' }, weight: 0.9, source: 'способность: Выпад' }),
    ],
  },
  {
    // варвар
    id: 'ulv',
    name: 'Ульв',
    role: 'front',
    stats: { maxHp: 68, speed: 6, move: 2 },
    weapons: [{ name: 'секира', dmg: 9, range: 1 }],
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
    // следопыт-тень: тяжёлый арбалет бьёт наверняка, частить им не выйдет
    id: 'mara',
    name: 'Мара',
    role: 'ranged',
    stats: { maxHp: 36, speed: 6, move: 1 },
    weapons: [{ name: 'тяжёлый арбалет', dmg: 7, range: 6, affinity: { attack: 1, weakAttack: -1 } }],
    ability: { name: 'Скрадывание', desc: 'не выходит на линию вражеского выстрела' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'avoidLineOfFire' }, weight: 1, source: 'способность: Скрадывание' }),
    ],
  },
  {
    // воин-мастер оружия: три оружия, выбирает по ситуации — копьё держит
    // строй на расстоянии, меч частит, молот ломает наверняка
    id: 'yar',
    name: 'Яр',
    role: 'front',
    stats: { maxHp: 56, speed: 5, move: 2 },
    weapons: [
      { name: 'копьё', dmg: 6, range: 2 },
      { name: 'меч', dmg: 7, range: 1, affinity: { weakAttack: 1 } },
      { name: 'молот', dmg: 8, range: 1, affinity: { weakAttack: -1 } },
    ],
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
