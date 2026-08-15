import type { Rule } from './ir.js';
import type { Pos } from './types.js';
import type { UnitSpec } from './battle.js';
import {
  describeActive,
  describeAoe,
  describeDefenses,
  describePassives,
  describeWeapons,
  ruleRu,
} from './cards.js';
import { applyLens } from './lens.js';

/** Фабрики врагов. Новый враг = новый набор правил, не новый арт. */

const rule = (r: Omit<Rule, 'scope'>): Rule => ({ ...r, scope: 'self' });

/**
 * Разведка: видимые принципы врагов (после линзы характера — то, как враг
 * БУДЕТ себя вести) + площадное оружие носителя АОЕ. Показывается перед боем
 * у элиток и босса: бой становится задачей на контр-формулировку.
 */
export function foeIntel(specs: readonly UnitSpec[]): { name: string; lines: string[] }[] {
  return specs.map((s) => {
    // source искажённого линзой правила описывает уже не то, что враг будет
    // делать, — для таких строк печатаем перевод фактического поведения
    const lines = applyLens(s.lenses, s.rules).rules.map((r) =>
      r.marks?.some((m) => m.kind === 'reword' || m.kind === 'recondition')
        ? `${r.source} → ${ruleRu(r)}`
        : r.source,
    );
    if (s.weapons?.length) lines.push(`оружие: ${describeWeapons(s.weapons)}`);
    else if (s.aoe) lines.push(`оружие: ${describeAoe(s.aoe)}`);
    if (s.defenses) lines.push(`защита: ${describeDefenses(s.defenses)}`);
    if (s.active) lines.push(`актив: ${describeActive(s.active)}`);
    if (s.passives) lines.push(`пассив: ${describePassives(s.passives)}`);
    return { name: s.name, lines };
  });
}

export function grunt(n: number): UnitSpec {
  return {
    id: `grunt${n}`,
    name: `Рубака ${n}`,
    side: 'foe',
    maxHp: 36,
    defenses: { ac: 15, fort: 8, ref: 7, will: 6 },
    weapons: [{ name: 'ржавый тесак', dmg: 5, range: 1, dmgType: 'slashing', atkBonus: 9 }],
    speed: 4,
    move: 2,
    lenses: ['plain'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1.5, source: 'рубить ближайшего' }),
    ],
  };
}

export function packLeader(): UnitSpec {
  return {
    id: 'boss',
    name: 'Вожак',
    side: 'foe',
    maxHp: 56,
    defenses: { ac: 16, fort: 9, ref: 7, will: 7 },
    weapons: [{ name: 'зазубренный топор', dmg: 7, range: 1, dmgType: 'slashing' }],
    speed: 5,
    move: 2,
    tags: ['leader'],
    lenses: ['plain'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 2, source: 'вожак: добивать раненых' }),
    ],
  };
}

export function archer(n: number): UnitSpec {
  return {
    id: `archer${n}`,
    name: `Лучник ${n}`,
    side: 'foe',
    maxHp: 28,
    defenses: { ac: 14, fort: 6, ref: 8, will: 6 },
    weapons: [{ name: 'короткий лук', dmg: 5, range: 4, dmgType: 'piercing', atkBonus: 9 }],
    speed: 5,
    move: 1,
    lenses: ['plain'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 2, source: 'лучник: бить раненых' }),
      rule({ when: { kind: 'always' }, then: { kind: 'retreat' }, weight: 0.8, source: 'лучник: держать дистанцию' }),
    ],
  };
}

export function warChief(): UnitSpec {
  return {
    id: 'chief',
    name: 'Вождь',
    side: 'foe',
    maxHp: 68,
    defenses: { ac: 17, fort: 10, ref: 7, will: 8 },
    weapons: [{ name: 'топор вождя', dmg: 7, range: 1, dmgType: 'slashing', atkBonus: 9 }],
    speed: 5,
    move: 2,
    tags: ['leader'],
    lenses: ['fanatic'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 2, source: 'вождь: добивать раненых' }),
    ],
  };
}

// ---- Поздние враги (фаза 4): играют новыми концептами того же IR ----

/** Шаман держится за спиной вожака (behindId — id юнита-щита в том же бою). */
export function shaman(behindId: string): UnitSpec {
  return {
    id: 'shaman',
    name: 'Шаман',
    side: 'foe',
    maxHp: 32,
    defenses: { ac: 14, fort: 6, ref: 7, will: 11 },
    // носитель АОЕ: залп 3×3 — первая причина держать интервал; ритуал 5×5
    // с перезарядкой 3 — телеграфированный, из него выходят или прикрываются
    weapons: [{
      name: 'посох духов',
      dmg: 4,
      range: 4,
      aoe: {
        blast: { range: 4, mult: 0.75, dmgType: 'void' },
        ritual: { range: 4, mult: 1.2, cooldown: 3, dmgType: 'mental' },
      },
    }],
    speed: 5,
    move: 1,
    lenses: ['plain'],
    rules: [
      rule({
        when: { kind: 'always' },
        then: { kind: 'behind', ref: { type: 'ally', id: behindId } },
        weight: 1.5,
        source: 'шаман: держаться за спинами',
      }),
      rule({ when: { kind: 'always' }, then: { kind: 'barrage' }, weight: 1.5, source: 'шаман: накрыть скопление' }),
    ],
  };
}

export function berserker(n: number): UnitSpec {
  return {
    id: `berserk${n}`,
    name: `Берсерк ${n}`,
    side: 'foe',
    maxHp: 44,
    defenses: { ac: 15, fort: 10, ref: 7, will: 4 },
    weapons: [{ name: 'шипастый цеп', dmg: 8, range: 1, dmgType: 'bludgeoning', atkBonus: 9 }],
    speed: 6,
    move: 3,
    lenses: ['fanatic'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'trade' }, weight: 2, source: 'берсерк: размен всегда выгоден' }),
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1.5, source: 'берсерк: рвать ближайшего' }),
    ],
  };
}

export function hunter(n: number): UnitSpec {
  return {
    id: `hunter${n}`,
    name: `Охотник ${n}`,
    side: 'foe',
    maxHp: 30,
    defenses: { ac: 15, fort: 7, ref: 10, will: 7 },
    weapons: [{ name: 'костяной лук', dmg: 6, range: 5, dmgType: 'piercing', atkBonus: 9 }],
    speed: 6,
    move: 2,
    lenses: ['plain'],
    rules: [
      rule({
        when: { kind: 'always' },
        then: { kind: 'attack', target: 'mostDangerous' },
        weight: 2,
        source: 'охотник: снимать самых опасных',
      }),
      rule({ when: { kind: 'always' }, then: { kind: 'avoidLineOfFire' }, weight: 1.2, source: 'охотник: не лезть под выстрел' }),
    ],
  };
}

// ---- План врагов: паттерны боёв (по мотивам pf2e) ----

/**
 * Масса: крыса-переросток (Giant Rat) — дешёвое тело стаи. Умирает от
 * полного удара с добором, но тел больше, чем у партии ходов; спавнятся
 * кучей у восточного края (явные точки — стая приходит толпой).
 */
const RAT_SPAWNS: readonly Pos[] = [
  { x: 15, y: 7 },
  { x: 16, y: 8 },
  { x: 15, y: 9 },
  { x: 16, y: 10 },
  { x: 15, y: 11 },
  { x: 16, y: 6 },
  { x: 16, y: 12 },
  { x: 17, y: 7 },
  { x: 17, y: 9 },
  { x: 17, y: 11 },
];

export function rat(n: number): UnitSpec {
  return {
    id: `rat${n}`,
    name: `Крыса ${n}`,
    side: 'foe',
    maxHp: 10,
    defenses: { ac: 14, fort: 5, ref: 6, will: 3 },
    // грязные зубы травят (план damage-types, волна 6): яд не складывается,
    // поэтому стая вешает одну отраву на героя, а не пять
    weapons: [
      { name: 'зубы', dmg: 4, range: 1, dmgType: 'piercing', atkBonus: 9, persist: { dmg: 1, type: 'poison' } },
    ],
    speed: 7,
    move: 3,
    // фанатик: голодная стая не знает страха — без линзы хилое тело под
    // обстрелом уходит в глухую оборону, и масса черепашится вместо накатывания
    lenses: ['fanatic'],
    spawn: { ...RAT_SPAWNS[(n - 1) % RAT_SPAWNS.length]! },
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1.5, source: 'крыса: вцепиться в ближайшего' }),
    ],
  };
}

/**
 * Застрельщики: кобольд-пращник (Kobold Warrior) — держит дистанцию, бьёт
 * камнем раненых; нож — на случай, когда прижали (кандидаты по каждому
 * оружию выбирают сами). Кайт игрока против него превращается в
 * перестрелку, контр — накатить и додавить. Линза труса срезана по замеру:
 * бегун при hp<30% наматывал круги по периметру и 3–8% боёв уходили в
 * ничью 30 раундов — а ничья в забеге равна поражению (рычаг из решения
 * пользователя: снять линзу; вернуть труса сможет механика «сбежал с поля»).
 */
export function slinger(n: number): UnitSpec {
  return {
    id: `slinger${n}`,
    name: `Пращник ${n}`,
    side: 'foe',
    maxHp: 16,
    defenses: { ac: 14, fort: 5, ref: 8, will: 5 },
    weapons: [
      { name: 'праща', dmg: 5, range: 4, dmgType: 'bludgeoning', atkBonus: 9 },
      { name: 'кривой нож', dmg: 3, range: 1, dmgType: 'piercing', atkBonus: 9 },
    ],
    speed: 6,
    move: 2,
    lenses: ['plain'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'standoff' }, weight: 1.2, source: 'пращник: держать дистанцию' }),
      rule({ when: { kind: 'always' }, then: { kind: 'behindCover' }, weight: 1.0, source: 'пращник: стрелять из-за камней' }),
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 1.5, source: 'пращник: камнем по раненым' }),
    ],
  };
}

/**
 * Задира (Goblin Heckler, план teamwork): гоблин-крикун при застрельщиках —
 * дразнит героев стойкой вызова и юлит под ударами (приманка), уводя удары
 * партии от строя пращников; те тем временем бьют камнями по раненым. Тот же
 * канал внимания, что у слова игрока «вызывать на себя», — механика
 * симметрична. Контр — дисциплинированные характеры: буквалист (provocable 0)
 * на выкрики не оборачивается, дуэлянт ведётся втрое слабее.
 */
export function heckler(): UnitSpec {
  return {
    id: 'heckler',
    name: 'Задира',
    side: 'foe',
    maxHp: 34,
    defenses: { ac: 15, fort: 8, ref: 7, will: 9 },
    weapons: [{ name: 'ржавый тесак', dmg: 4, range: 1, dmgType: 'slashing' }],
    speed: 7,
    move: 3,
    lenses: ['plain'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'taunt' }, weight: 1.6, source: 'задира: дразнить и звать на себя' }),
      rule({
        when: { kind: 'always' },
        then: { kind: 'lure', ally: 'slinger1' },
        weight: 1.0,
        source: 'задира: уводить от пращников',
      }),
      rule({ when: { kind: 'always' }, then: { kind: 'bait' }, weight: 0.8, source: 'задира: юлить под ударами' }),
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 0.8, source: 'задира: тычок исподтишка' }),
    ],
  };
}

/**
 * Умная элита: хобгоблин-латник (Hobgoblin Soldier, Formation) — дисциплина
 * вместо ярости: держит строй с напарником, фокусит раненых, прикрывается.
 * Меч для строя, метательное копьё — достать отходящего (второе оружие).
 */
export function soldier(n: number, buddyId: string): UnitSpec {
  return {
    id: `soldier${n}`,
    name: `Латник ${n}`,
    side: 'foe',
    maxHp: 42,
    defenses: { ac: 17, fort: 9, ref: 5, will: 7, resist: { slashing: 2 } },
    weapons: [
      { name: 'меч и щит', dmg: 5, range: 1, dmgType: 'slashing', atkBonus: 9, affinity: { attack: 1 } },
      { name: 'метательное копьё', dmg: 4, range: 3, dmgType: 'piercing', atkBonus: 9 },
    ],
    speed: 5,
    move: 2,
    lenses: ['plain'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 1.8, source: 'латник: добивать раненых' }),
      rule({
        when: { kind: 'always' },
        then: { kind: 'nearTo', ref: { type: 'ally', id: buddyId } },
        weight: 1.2,
        source: 'латник: держать строй',
      }),
      rule({ when: { kind: 'always' }, then: { kind: 'behindCover' }, weight: 0.8, source: 'латник: из-за щита' }),
    ],
  };
}

/**
 * Сержант (Hobgoblin General): голос строя — боевой клич (bless, канал
 * Радима) поднимает урон латника до конца боя; сам ломает самых опасных.
 * Убить сержанта до клича — контр, ради которого он и носит тег вожака.
 */
export function sergeant(): UnitSpec {
  return {
    id: 'sergeant',
    name: 'Сержант',
    side: 'foe',
    maxHp: 52,
    defenses: { ac: 17, fort: 10, ref: 5, will: 8, resist: { slashing: 2 } },
    weapons: [{ name: 'палаш', dmg: 7, range: 1, dmgType: 'slashing', atkBonus: 9 }],
    speed: 5,
    move: 2,
    tags: ['leader'],
    lenses: ['plain'],
    active: { bless: { dmgMult: 1.25, range: 5, usesPerBattle: 1 } },
    rules: [
      // клич — ответ на падение латника: убей сержанта первым, и клича не
      // будет; убей латника первым — второй станет вдвое злее. Порядок целей
      // и есть головоломка элитки, условие видно в разведке
      // вес 4: клич жмётся раз в бой, а звучит в разгаре рубки — при 2.0
      // премия проигрывала жирной атаке и клич не звучал вовсе (урок ярости)
      rule({ when: { kind: 'allyFallen' }, then: { kind: 'bless' }, weight: 4, source: 'сержант: клич мести, когда падает латник' }),
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'mostDangerous' }, weight: 1.5, source: 'сержант: ломать опасных' }),
      rule({ when: { kind: 'always' }, then: { kind: 'trade' }, weight: 0.8, source: 'сержант: размен по уставу' }),
    ],
  };
}

/**
 * Стая: волк (Wolf) — травля флангами: укус со стороны больнее (sneak,
 * канал Тессы), Knockdown из pf2e читается толчком «сбить с ног».
 */
const WOLF_SPAWNS: readonly Pos[] = [
  { x: 15, y: 6 },
  { x: 15, y: 9 },
  { x: 15, y: 12 },
  { x: 16, y: 8 },
];

export function wolf(n: number): UnitSpec {
  return {
    id: `wolf${n}`,
    name: `Волк ${n}`,
    side: 'foe',
    maxHp: 32,
    defenses: { ac: 15, fort: 8, ref: 9, will: 5 },
    weapons: [{ name: 'клыки', dmg: 5, range: 1, dmgType: 'piercing', atkBonus: 9 }],
    speed: 7,
    move: 3,
    lenses: ['plain'],
    passives: { sneak: { flankMult: 2.0 } },
    spawn: { ...WOLF_SPAWNS[(n - 1) % WOLF_SPAWNS.length]! },
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'flank' }, weight: 1.3, source: 'волк: обойти со стороны' }),
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 1.8, source: 'волк: резать слабых' }),
      rule({ when: { kind: 'always' }, then: { kind: 'shove' }, weight: 0.8, source: 'волк: сбить с ног' }),
    ],
  };
}

/**
 * Ближники + лекарь: гнолл-налётчик (Kholo Hunter) — свитч-хиттер: лук на
 * подходе, топор в упор (кандидаты по каждому оружию выбирают сами), чует
 * слабых. Кайт его не выключает — он стреляет в ответ.
 */
export function raider(n: number): UnitSpec {
  return {
    id: `raider${n}`,
    name: `Налётчик ${n}`,
    side: 'foe',
    maxHp: 30,
    defenses: { ac: 16, fort: 9, ref: 7, will: 6 },
    weapons: [
      { name: 'костяной лук', dmg: 5, range: 4, dmgType: 'piercing', atkBonus: 9 },
      { name: 'щербатый топор', dmg: 6, range: 1, dmgType: 'slashing', atkBonus: 9 },
    ],
    speed: 6,
    move: 3,
    lenses: ['plain'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 1.8, source: 'налётчик: чуять слабых' }),
      rule({ when: { kind: 'always' }, then: { kind: 'flank' }, weight: 1.0, source: 'налётчик: заходить сбоку' }),
    ],
  };
}

/**
 * Костоправ (Kholo Cultist) — первый вражеский лекарь: держится за спинами
 * налётчиков и латает их (heal — канал Ивы). Замер: фокусить его сквозь
 * топоры дороже, чем перерубить фронт (он ещё и лечит себя под фокусом) —
 * лекарь работает налогом на время и глушит мету добивания: «бей раненых»
 * вязнет в перелечке, «руби ближайшего» строем — короче и дешевле.
 */
export function bonesetter(behindId: string): UnitSpec {
  return {
    id: 'bonesetter',
    name: 'Костоправ',
    side: 'foe',
    maxHp: 30,
    defenses: { ac: 14, fort: 7, ref: 7, will: 10 },
    weapons: [{ name: 'кривой посох', dmg: 4, range: 3, dmgType: 'bludgeoning' }],
    speed: 5,
    move: 2,
    lenses: ['plain'],
    active: { heal: { amount: 10, range: 4, usesPerBattle: 4 } },
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'heal' }, weight: 1.5, source: 'костоправ: латать рваные раны' }),
      rule({
        when: { kind: 'always' },
        then: { kind: 'behind', ref: { type: 'ally', id: behindId } },
        weight: 1.2,
        source: 'костоправ: держаться за спинами',
      }),
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 0.8, source: 'костоправ: посохом по раненым' }),
    ],
  };
}

/**
 * Танк + кастеры: огр (Ogre Warrior) — стена мяса на пути к артиллерии:
 * медленный, закрывает проход телом, вышвыривает тех, кто протискивается.
 * «Руби ближайшего» упирается в его 100 hp, пока сзади жгут.
 */
export function ogre(): UnitSpec {
  return {
    id: 'ogre',
    name: 'Огр',
    side: 'foe',
    maxHp: 90,
    defenses: { ac: 15, fort: 12, ref: 4, will: 4 },
    weapons: [{ name: 'дубина-бревно', dmg: 10, range: 1, dmgType: 'bludgeoning', atkBonus: 10 }],
    speed: 2,
    move: 1,
    lenses: ['plain'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'chokepoint' }, weight: 1.2, source: 'огр: закрыть проход тушей' }),
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1.8, source: 'огр: крушить ближайшего' }),
      rule({ when: { kind: 'always' }, then: { kind: 'shove' }, weight: 1.0, source: 'огр: вышвырнуть с дороги' }),
    ],
  };
}

/**
 * Поджигатель (Goblin Pyro) — стеклянная артиллерия за спиной огра: жжёт
 * залпом каждое скопление (blast без лимита, канал шамана). Пока огр-пробка
 * жив, до поджигателя не дотянуться — держи интервал или прорывайся.
 */
export function pyro(n: number): UnitSpec {
  return {
    id: `pyro${n}`,
    name: `Поджигатель ${n}`,
    side: 'foe',
    maxHp: 18,
    defenses: { ac: 14, fort: 6, ref: 9, will: 6, resist: { fire: 3 } },
    weapons: [{
      name: 'горшки с огнём',
      dmg: 4,
      range: 4,
      // залп поджигает не увернувшихся (волна 6): спасбросок решает не только
      // урон, но и займётся ли на жертве огонь
      aoe: { blast: { range: 4, mult: 0.7, dmgType: 'fire', persist: { dmg: 1 } } },
    }],
    speed: 6,
    move: 2,
    lenses: ['plain'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'barrage' }, weight: 1.5, source: 'поджигатель: горшком по скоплению' }),
      rule({
        when: { kind: 'always' },
        then: { kind: 'behind', ref: { type: 'ally', id: 'ogre' } },
        weight: 1.2,
        source: 'поджигатель: прятаться за огром',
      }),
    ],
  };
}

/**
 * Ритуалист (план objectives, сценарий «сорвать ритуал») — сам почти не
 * дерётся: прячется за огром и тянет время. Бой ведётся задачей killBefore:
 * жив к дедлайну — дочитал, поражение. Тег leader — чтобы контр («вали
 * вожака») и дефолт бота выражались стартовым словом.
 */
export function ritualist(behindId: string): UnitSpec {
  return {
    id: 'ritualist',
    name: 'Ритуалист',
    side: 'foe',
    maxHp: 34,
    defenses: { ac: 14, fort: 6, ref: 7, will: 11 },
    weapons: [{ name: 'жертвенный серп', dmg: 4, range: 1, dmgType: 'slashing' }],
    speed: 6,
    move: 2,
    tags: ['leader'],
    lenses: ['plain'],
    rules: [
      rule({
        when: { kind: 'always' },
        then: { kind: 'behind', ref: { type: 'ally', id: behindId } },
        weight: 2,
        source: 'ритуалист: прятаться за огром и читать',
      }),
      rule({ when: { kind: 'always' }, then: { kind: 'retreat' }, weight: 1.2, source: 'ритуалист: не подпускать к себе' }),
    ],
  };
}

/**
 * Засада: бугбер-душегуб (Bugbear Thug) — быстрый охотник на тыл: обтекает
 * фронт, режет хрупких, из-за угла бьёт больнее (sneak). С волками —
 * загонная охота; контр — телохранитель и спина к камню.
 */
export function thug(): UnitSpec {
  return {
    id: 'thug',
    name: 'Душегуб',
    side: 'foe',
    maxHp: 44,
    defenses: { ac: 16, fort: 9, ref: 7, will: 6 },
    weapons: [{ name: 'шипастая дубина', dmg: 7, range: 1, dmgType: 'bludgeoning', atkBonus: 9 }],
    speed: 6,
    move: 3,
    lenses: ['plain'],
    passives: { sneak: { flankMult: 1.75 } },
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 1.8, source: 'душегуб: резать хрупких' }),
      rule({ when: { kind: 'always' }, then: { kind: 'flank' }, weight: 1.3, source: 'душегуб: из-за угла' }),
    ],
  };
}

/**
 * Таймер: тролль (Troll, Regeneration) — зарастает быстрее, чем вялый
 * размазанный урон успевает ранить: единственный носитель пассива regen.
 * Фанатик — прёт напролом, разменов не боится (регенерация окупит).
 * Контр — фокус всем строем: превысить зарастание и свалить.
 */
export function troll(): UnitSpec {
  return {
    id: 'troll',
    name: 'Тролль',
    side: 'foe',
    maxHp: 72,
    defenses: { ac: 16, fort: 12, ref: 6, will: 5, weak: { fire: 3, acid: 3 } },
    weapons: [{ name: 'когтистые лапы', dmg: 8, range: 1, dmgType: 'slashing', atkBonus: 10 }],
    speed: 4,
    move: 2,
    lenses: ['fanatic'],
    passives: { regen: { amount: 8 } },
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1.5, source: 'тролль: рвать ближайшего' }),
      rule({ when: { kind: 'always' }, then: { kind: 'trade' }, weight: 1.5, source: 'тролль: раны зарастут' }),
    ],
  };
}

/**
 * Дуэль: орк-поединщик (по мотивам Orc Brute) — признаёт только достойного:
 * идёт на самого опасного героя и вызывает его на размен. Линза дуэлянта —
 * характер как правило: слабых не добивает, в спину не бьёт, вполсилы не
 * машет. Клеймор для полновесных ударов, чекан — когда нужен частый.
 */
export function duelist(): UnitSpec {
  return {
    id: 'duelist',
    name: 'Поединщик',
    side: 'foe',
    maxHp: 76,
    defenses: { ac: 18, fort: 9, ref: 11, will: 8 },
    weapons: [
      { name: 'клеймор', dmg: 9, range: 1, dmgType: 'slashing', atkBonus: 10, affinity: { attack: 1, weakAttack: -1 } },
      { name: 'чекан', dmg: 7, range: 1, dmgType: 'bludgeoning', atkBonus: 10, affinity: { weakAttack: 1 } },
    ],
    speed: 5,
    move: 2,
    lenses: ['duelist'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'mostDangerous' }, weight: 2, source: 'поединщик: вызвать опаснейшего' }),
      rule({ when: { kind: 'always' }, then: { kind: 'trade' }, weight: 1.2, source: 'поединщик: честный размен' }),
    ],
  };
}

/** Финальный босс забега. Ходит со свитой (шаман за спиной, охотник в тылу). */
export function warlord(): UnitSpec {
  return {
    id: 'warlord',
    name: 'Вождь орды',
    side: 'foe',
    // 132 (было 120): ритуал съедает треть его ходов, а фанатик жжёт и свою
    // свиту — без компенсации узел босса мягчел с 43 до ~55% (план АОЕ, шаг 8)
    maxHp: 132,
    defenses: { ac: 18, fort: 12, ref: 8, will: 10 },
    // dmg 9: с пулом героев и способностями (партия сильнее фиксированной
    // тройки фазы 5) наив на 52/8 добрался до ~46% — босс переставал быть
    // задачей на контр-формулировку; здесь наив ~35%.
    // Ритуал «дыхание орды»: рейд-механика финала — замах виден за ход, из
    // зоны выходят, медленные прикрываются; перезарядка 3 задаёт ритм боя.
    // mult 2.0: телеграфированный удар обязан быть страшным — при 1.2 босс
    // менял треть своих ходов на щекотку и мягчел (замер шага 5 плана АОЕ)
    weapons: [{
      name: 'обсидиановый топор',
      dmg: 9,
      range: 1,
      dmgType: 'slashing',
      atkBonus: 10,
      aoe: { ritual: { range: 4, mult: 2.0, cooldown: 3, dmgType: 'void' } },
    }],
    speed: 6,
    move: 2,
    tags: ['leader'],
    lenses: ['fanatic'],
    rules: [
      rule({
        when: { kind: 'always' },
        then: { kind: 'attack', target: 'mostDangerous' },
        weight: 2,
        source: 'вождь орды: ломать самых опасных',
      }),
      rule({ when: { kind: 'always' }, then: { kind: 'trade' }, weight: 1.5, source: 'вождь орды: крови не жалеть' }),
      // вес 1.0 (не 1.5): при 1.5 вождь менял на замахи треть ходов и мягчел —
      // дыхание должно накрывать настоящие скопления, а не заменять топор
      rule({ when: { kind: 'always' }, then: { kind: 'barrage' }, weight: 1.0, source: 'вождь орды: дыхание орды' }),
      // упреждение: партия научилась выходить из зоны — вождь целит туда,
      // куда выходят (шаг 5 плана АОЕ, лечит «босс помягчел» из шага 3)
      rule({ when: { kind: 'always' }, then: { kind: 'preempt' }, weight: 1.0, source: 'вождь орды: бить на упреждение' }),
    ],
  };
}
