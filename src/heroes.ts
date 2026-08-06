import type { Rule } from './ir.js';
import type { PhraseDraft } from './constructor.js';
import type { ActiveSpec, PassiveSpec, Pos, WeaponSpec } from './types.js';
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
  /** Базовый класс pf2e («воин», «следопыт»…) — виден в карточках UI. */
  class: string;
  role: HeroRole;
  stats: { maxHp: number; speed: number; move: number };
  /** Оружие варианта класса; у мастера — несколько, выбирает по ситуации. */
  weapons: WeaponSpec[];
  /** Классовый актив (ярость, стена…); использование гейтится словом/правилом. */
  active?: ActiveSpec;
  /** Классовые пассивы — всегда включены, слов не требуют. */
  passives?: PassiveSpec;
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
    class: 'воин',
    role: 'front',
    stats: { maxHp: 80, speed: 5, move: 2 },
    weapons: [{ name: 'меч и щит', dmg: 8, range: 1, affinity: { attack: 1, selflessAttack: -1 } }],
    // щит держит союзника крепче общего прикрытия; «Стена» кроет весь строй —
    // гейт защитными правилами, своего слова не нужно
    active: { wall: { usesPerBattle: 1 } },
    passives: { shieldwall: { cover: 0.4 } },
    ability: { name: 'Оплот', desc: 'сам встаёт между врагом и самым раненым из своих' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'coverRetreat' }, weight: 0.9, source: 'способность: Оплот' }),
    ],
  },
  {
    // следопыт-охотник
    id: 'dart',
    name: 'Дарт',
    class: 'следопыт',
    role: 'ranged',
    stats: { maxHp: 48, speed: 6, move: 2 },
    weapons: [{ name: 'длинный лук', dmg: 6, range: 5 }],
    // метит добычу самим выстрелом: его цель — «помеченная» для всей партии.
    // Актив «кого метить» не нужен: ответ уже в его атаках (решение шага 3)
    passives: { markOnHit: true },
    ability: { name: 'Подранок', desc: 'не может не добить раненого — и метит добычу для своих' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 0.8, source: 'способность: Подранок' }),
    ],
  },
  {
    id: 'lia',
    name: 'Лия',
    class: 'волшебница',
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
    class: 'паладин',
    role: 'front',
    stats: { maxHp: 96, speed: 3, move: 1 },
    weapons: [{ name: 'щит-башня', dmg: 5, range: 1 }],
    passives: { steadfast: true },
    ability: { name: 'Глыба', desc: 'где поставили — там и стоит; глухая оборона даётся дёшево' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'holdPosition' }, weight: 0.8, source: 'способность: Глыба' }),
    ],
  },
  {
    // плут «в спину»: кинжалы любят частые уколы
    id: 'tessa',
    name: 'Тесса',
    class: 'плутовка',
    role: 'melee',
    stats: { maxHp: 44, speed: 7, move: 3 },
    weapons: [{ name: 'кинжалы', dmg: 7, range: 1, affinity: { weakAttack: 1 } }],
    passives: { sneak: { flankMult: 1.75 } },
    ability: { name: 'Из-за спины', desc: 'заходит сбоку и бьёт вдвоём — в спину больнее прочих' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'flank' }, weight: 1.2, source: 'способность: Из-за спины' }),
    ],
  },
  {
    // монах-копейщик: длинное копьё умеет бить волной по линии — оружие есть
    // всегда, но без слова «накрыть скопление» волна не случается
    id: 'zhalo',
    name: 'Жало',
    class: 'монах',
    role: 'melee',
    stats: { maxHp: 60, speed: 5, move: 2 },
    weapons: [{ name: 'копьё ци', dmg: 6, range: 2, aoe: { line: { len: 4, mult: 0.75 } } }],
    ability: { name: 'Выпад', desc: 'колет в размен, когда укол того стоит' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'trade' }, weight: 0.9, source: 'способность: Выпад' }),
    ],
  },
  {
    // варвар: единственный носитель актива ярости (план классов). Врождённое
    // правило само вводит его в ярость на затяжке; слово «впасть в ярость»
    // позволяет игроку выбрать момент раньше и лучше
    id: 'ulv',
    name: 'Ульв',
    class: 'варвар',
    role: 'front',
    stats: { maxHp: 68, speed: 6, move: 2 },
    weapons: [{ name: 'секира', dmg: 9, range: 1 }],
    active: { rage: { dmgMult: 1.3, vulnMult: 1.2 } },
    ability: { name: 'Ярость', desc: 'если бой затянулся — впадает в ярость' },
    innate: [
      r({
        when: { kind: 'battleDrags' },
        then: { kind: 'rage' },
        weight: 2,
        source: 'способность: Ярость',
      }),
    ],
  },
  {
    // следопыт-тень: тяжёлый арбалет бьёт наверняка, частить им не выйдет
    id: 'mara',
    name: 'Мара',
    class: 'следопыт',
    role: 'ranged',
    stats: { maxHp: 36, speed: 6, move: 1 },
    weapons: [{ name: 'тяжёлый арбалет', dmg: 7, range: 6, affinity: { attack: 1, weakAttack: -1 } }],
    passives: { shadow: { mult: 1.25 } },
    ability: { name: 'Скрадывание', desc: 'не выходит на линию вражеского выстрела — и бьёт из тени больнее' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'avoidLineOfFire' }, weight: 1, source: 'способность: Скрадывание' }),
    ],
  },
  {
    // жрица-целительница (волна 2): первый «hp вверх» в симе. Врождённое
    // правило лечит и без слова игрока; слово «лечить» (CORE) позволяет
    // условить («если врагов больше — лечи») и усилить весом
    id: 'iva',
    name: 'Ива',
    class: 'жрица',
    role: 'ranged',
    stats: { maxHp: 44, speed: 5, move: 2 },
    weapons: [{ name: 'ясеневый посох', dmg: 5, range: 3 }],
    active: { heal: { amount: 10, range: 4, usesPerBattle: 2 } },
    ability: { name: 'Милосердие', desc: 'не бросит раненого — лечит, кому хуже всех' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'heal' }, weight: 1.2, source: 'способность: Милосердие' }),
    ],
  },
  {
    // боевой жрец (волна 2): благословение — длящийся бафф канала ярости.
    // Своего слова у благословения пока нет (словарь бережём, решит план
    // words) — жмётся врождённым правилом, цель выбирает скоринг
    id: 'radim',
    name: 'Радим',
    class: 'жрец',
    role: 'front',
    stats: { maxHp: 72, speed: 4, move: 2 },
    weapons: [{ name: 'молот-благовест', dmg: 7, range: 1, affinity: { attack: 1 } }],
    active: { bless: { dmgMult: 1.25, range: 3, usesPerBattle: 1 } },
    ability: { name: 'Благовест', desc: 'благословляет самого ударного из своих' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'bless' }, weight: 1.2, source: 'способность: Благовест' }),
    ],
  },
  {
    // варвар-секироносец (волна 2): двуручник с коротким «росчерком» —
    // мгновенная линия 1×2 рубит двоих в замесе; гейт словом «накрыть
    // скопление», как у Жала. Тяжёлое железо не для мелких замахов
    id: 'ryk',
    name: 'Рык',
    class: 'варвар',
    role: 'front',
    stats: { maxHp: 64, speed: 5, move: 2 },
    weapons: [
      {
        name: 'двуручная секира',
        dmg: 9,
        range: 1,
        affinity: { attack: 1, selflessAttack: 1, weakAttack: -1 },
        aoe: { line: { len: 2, mult: 0.75 } },
      },
    ],
    ability: { name: 'Росчерк', desc: 'широкий взмах достаёт двоих, вставших в линию' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'trade' }, weight: 0.9, source: 'способность: Росчерк' }),
    ],
  },
  {
    // плутовка-трюкачка (волна 2): финт открывает врага под удары своих —
    // связка «финт → все бьют». Слова у финта нет (прецедент благословения):
    // жмётся врождённым правилом, цену выбора несёт скоринг
    id: 'lisa',
    name: 'Лиса',
    class: 'плутовка',
    role: 'melee',
    stats: { maxHp: 42, speed: 8, move: 3 },
    weapons: [{ name: 'парные ножи', dmg: 6, range: 1, affinity: { weakAttack: 1 } }],
    active: { feint: {} },
    ability: { name: 'Трюк', desc: 'обманным выпадом открывает врага под удары своих' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'feint' }, weight: 1.2, source: 'способность: Трюк' }),
    ],
  },
  {
    // волшебница-контролёр (волна 2): без залпа; «полымя» — ритуал, зона
    // которого жжёт три хода подряд: из неё выбегают, её обходят — контроль
    // пространства, а не разовый урон. Гейт теми же словами каста
    id: 'vesta',
    name: 'Веста',
    class: 'волшебница',
    role: 'ranged',
    stats: { maxHp: 38, speed: 5, move: 2 },
    weapons: [
      {
        name: 'гримуар пламени',
        dmg: 6,
        range: 4,
        aoe: { ritual: { range: 5, mult: 0.8, cooldown: 4, pulses: 3 } },
      },
    ],
    ability: { name: 'Полымя', desc: 'выжигает зону, которая горит три хода подряд' },
    innate: [
      r({
        when: { kind: 'hpBelow', who: 'self', frac: 0.4 },
        then: { kind: 'retreat' },
        weight: 1.5,
        source: 'способность: Полымя',
      }),
    ],
  },
  {
    // монахиня-шквал (волна 2): кулаки бьют слабым ударом крепче общего
    // (0.55 против 0.45) — волюм-боец, которому «бить часто» родной язык
    id: 'yuna',
    name: 'Юна',
    class: 'монахиня',
    role: 'melee',
    stats: { maxHp: 52, speed: 7, move: 3 },
    weapons: [{ name: 'кулаки бури', dmg: 7, range: 1, weakMult: 0.55, affinity: { weakAttack: 1 } }],
    ability: { name: 'Шквал', desc: 'град быстрых ударов вместо одного тяжёлого' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'strikeOften' }, weight: 1.2, source: 'способность: Шквал' }),
    ],
  },
  {
    // паладин-карательница (волна 2): пассив «Кара» — бьёт больнее того, кто
    // поднял руку на её своих (канал lastAttackerId); врождённо мстит и за себя
    id: 'zarya',
    name: 'Заря',
    class: 'паладин',
    role: 'front',
    stats: { maxHp: 68, speed: 5, move: 2 },
    weapons: [{ name: 'клинок зари', dmg: 8, range: 1, affinity: { attack: 1 } }],
    passives: { retribution: { mult: 1.25 } },
    ability: { name: 'Кара', desc: 'обидчик своих получает сполна' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'attacker' }, weight: 0.9, source: 'способность: Кара' }),
    ],
  },
  {
    // воин-мастер оружия: три оружия, выбирает по ситуации — копьё держит
    // строй на расстоянии, меч частит, молот ломает наверняка
    id: 'yar',
    name: 'Яр',
    class: 'воин',
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
