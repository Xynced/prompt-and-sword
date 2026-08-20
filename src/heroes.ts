import type { Rule } from './ir.js';
import type { PhraseDraft } from './constructor.js';
import type {
  ActiveSpec,
  Defenses,
  PassiveSpec,
  Pos,
  ReactionKind,
  ShieldSpec,
  WeaponSpec,
} from './types.js';
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
  /** Подпись варианта класса («щитоносец», «мастер оружия») — в шапке карточки героя. */
  title: string;
  role: HeroRole;
  stats: { maxHp: number; speed: number; move: number };
  /** Оружие варианта класса; у мастера — несколько, выбирает по ситуации. */
  weapons: WeaponSpec[];
  /** Классовый актив (ярость, стена…); использование гейтится словом/правилом. */
  active?: ActiveSpec;
  /** Классовые пассивы — всегда включены, слов не требуют. */
  passives?: PassiveSpec;
  /**
   * Защиты варианта класса (план damage-types): КБ против ударов и три
   * спасброска. Разброс — вкус роли: латник держит удар, но не уворачивается,
   * маг наоборот; Воля высока у веры и низка у зверья и берсерков.
   */
  defenses?: Defenses;
  /** Щит варианта класса (план armor): бонус к КБ на подъёме и блок по твёрдости. */
  shield?: ShieldSpec;
  /** Реакция класса (план reactions): что герой делает в чужой ход; одна на раунд. */
  reaction?: ReactionKind;
  ability: { name: string; desc: string };
  /** Врождённые правила способности; в source — префикс «способность:». */
  innate: Rule[];
}

const r = (rule: Omit<Rule, 'scope' | 'innate'>): Rule => ({ ...rule, scope: 'self', innate: true });

export const HERO_POOL: readonly HeroArchetype[] = [
  {
    // воин-щитоносец (кит приёмов, план weapon-moves): рискового темпа нет
    // вовсе — щит не открывается (жёстче прежней мягкой аффинности); толчок
    // щитом расталкивает строй, удар из-за щита расчётлив — не ловит рипост
    id: 'grom',
    name: 'Гром',
    class: 'воин',
    title: 'щитоносец',
    role: 'front',
    stats: { maxHp: 80, speed: 5, move: 2 },
    defenses: { ac: 18, fort: 10, ref: 6, will: 7 },
    weapons: [
      {
        name: 'меч и щит',
        dmg: 8,
        range: 1,
        dmgType: 'slashing',
        atkBonus: 9,
        moves: [
          { id: 'shieldJab', name: 'щитом в грудь', slot: 'weakAttack', mult: 0.55, push: true, dmgType: 'bludgeoning' },
          { id: 'guardCut', name: 'удар из-за щита', slot: 'attack', mult: 0.95, sure: true },
          { id: 'trueCut', name: 'верный рубящий', slot: 'attack', mult: 1 },
        ],
      },
    ],
    // щит держит союзника крепче общего прикрытия; «Стена» кроет весь строй —
    // гейт защитными правилами, своего слова не нужно
    active: { wall: { usesPerBattle: 1 } },
    passives: { shieldwall: { ac: 3 } },
    // щит (план armor): поднятый даёт +2 к КБ и гасит 3 урона раз в раунд;
    // 10 вмятин — и щит разваливается, дальше Гром воюет одним мечом
    shield: { ac: 2, hardness: 3, hp: 10 },
    // реакция воина (план reactions): уходящий из-под щита ловит удар
    reaction: 'reactiveStrike',
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
    title: 'охотник',
    role: 'ranged',
    stats: { maxHp: 48, speed: 6, move: 2 },
    defenses: { ac: 16, fort: 7, ref: 10, will: 7 },
    // кит приёмов (план weapon-moves, волна 2): лук — темп и манёвр, без
    // пирса (бронебойность — вкус арбалета Мары); сдвоенный рассеивает урон
    // по двум, выстрел с отходом выводит из-под ответа
    weapons: [
      {
        name: 'длинный лук',
        dmg: 6,
        range: 5,
        dmgType: 'piercing',
        atkBonus: 9,
        moves: [
          { id: 'quickShot', name: 'быстрый выстрел', slot: 'weakAttack', mult: 0.6 },
          { id: 'aimedShot', name: 'прицельный выстрел', slot: 'attack', mult: 1 },
          { id: 'splitShot', name: 'сдвоенный выстрел', slot: 'attack', mult: 0.45, twin: true },
          { id: 'partingShot', name: 'выстрел с отходом', slot: 'attack', mult: 0.7, stepBack: true },
          // подранок в буквальном смысле (волна 6): кровь идёт, пока рану не зажмут
          { id: 'ribShot', name: 'стрела под ребро', slot: 'attack', mult: 0.55, persist: { dmg: 1 } },
          { id: 'pointBlank', name: 'выстрел в упор', slot: 'selflessAttack', mult: 1.4, expose: true },
        ],
      },
    ],
    // метит добычу самим выстрелом: его цель — «помеченная» для всей партии.
    // Актив «кого метить» не нужен: ответ уже в его атаках (решение шага 3).
    // «Град стрел» (план action-economy, волна 6) — hunter's edge flurry
    // pf2e: лестница MAP мягче на две ступени, поэтому третий выстрел за ход
    // у него ещё имеет смысл, а «сдвоенный» уходит двумя бросками по одному
    // штрафу — стрелок-волюмщик против стрелка-снайпера Мары
    passives: { markOnHit: true, flurry: true },
    reaction: 'disruptPrey',
    ability: { name: 'Подранок', desc: 'не может не добить раненого — и метит добычу для своих' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 0.8, source: 'способность: Подранок' }),
    ],
  },
  {
    id: 'lia',
    name: 'Лия',
    class: 'волшебница',
    title: 'эвокер',
    role: 'ranged',
    stats: { maxHp: 40, speed: 4, move: 1 },
    defenses: { ac: 15, fort: 6, ref: 7, will: 10 },
    // волшебница-эвокер: залп и ритуал — оба раз в бой; без слова «накрыть
    // скопление» оружие молчит. Дальность ритуала 6 (не 4): с move 1 Лия
    // кастует по бегущим издали, и центр должен дотягиваться до скопления,
    // а не цеплять его краем зоны
    // кит приёмов (план weapon-moves, волна 3): у стекла нет рискового темпа —
    // маг не открывается; прожигающий луч пробивает укрытия — противострелковый
    weapons: [
      {
        name: 'жезл',
        dmg: 8,
        dmgType: 'electricity',
        atkBonus: 9,
        range: 4,
        aoe: {
          blast: { range: 4, mult: 0.75, usesPerBattle: 1, dmgType: 'fire' },
          ritual: { range: 6, mult: 1.2, usesPerBattle: 1, dmgType: 'fire' },
        },
        moves: [
          { id: 'liaSpark', name: 'искра', slot: 'weakAttack', mult: 0.55 },
          { id: 'liaRay', name: 'прицельный луч', slot: 'attack', mult: 1 },
          { id: 'liaBurn', name: 'прожигающий луч', slot: 'attack', mult: 0.8, pierce: 0.5, dmgType: 'fire' },
        ],
      },
    ],
    reaction: 'arcaneShield',
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
    title: 'бастион',
    role: 'front',
    stats: { maxHp: 96, speed: 3, move: 1 },
    defenses: { ac: 19, fort: 11, ref: 5, will: 8 },
    // кит приёмов (план weapon-moves, волна 3): башня толкает и давит; удар
    // кромкой расчётлив (не ловит рипост), рискового темпа у бастиона нет
    weapons: [
      {
        name: 'щит-башня',
        dmg: 5,
        dmgType: 'bludgeoning',
        atkBonus: 9,
        range: 1,
        moves: [
          { id: 'skalaShove', name: 'толчок щитом', slot: 'weakAttack', mult: 0.4, push: true },
          { id: 'skalaEdge', name: 'удар кромкой', slot: 'attack', mult: 0.9, sure: true },
          { id: 'skalaLean', name: 'навалиться', slot: 'attack', mult: 1.1 },
          { id: 'skalaCrush', name: 'всем весом', slot: 'attack', mult: 1.9, ap: 3, push: true },
        ],
      },
    ],
    passives: { steadfast: true },
    // щит-башня: гасит больше и держится дольше — на нём бастион и стоит
    shield: { ac: 2, hardness: 4, hp: 14 },
    reaction: 'retributiveStrike',
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
    title: 'в спину',
    role: 'melee',
    stats: { maxHp: 44, speed: 7, move: 3 },
    defenses: { ac: 16, fort: 6, ref: 11, will: 6 },
    // кит приёмов (план weapon-moves, волна 2): кинжалы живут быстрым темпом —
    // град в окружении (райдер gang) и метательный нож на три клетки; «серия»
    // — весь ход в одну цель без риска
    weapons: [
      {
        name: 'кинжалы',
        dmg: 7,
        dmgType: 'piercing',
        atkBonus: 9,
        range: 1,
        agile: true,
        moves: [
          { id: 'flurryJab', name: 'град уколов', slot: 'weakAttack', mult: 0.65, gang: 0.15 },
          { id: 'knifeThrow', name: 'метнуть нож', slot: 'weakAttack', mult: 0.55, range: 3 },
          { id: 'liverStab', name: 'в печень', slot: 'attack', mult: 1 },
          // яд на клинке (волна 6): сам укол колющий, тлеет ядом — и
          // сопротивление яду гасит именно тление, а не удар
          { id: 'poisonBlade', name: 'яд на клинке', slot: 'attack', mult: 0.6, persist: { dmg: 1, type: 'poison' } },
          { id: 'daggerFlow', name: 'серия', slot: 'attack', mult: 1.6, ap: 3 },
          { id: 'heartPierce', name: 'в самое сердце', slot: 'selflessAttack', mult: 1.5, expose: true },
        ],
      },
    ],
    passives: { sneak: { offGuard: 3 } },
    reaction: 'nimbleDodge',
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
    title: 'копейщик',
    role: 'melee',
    stats: { maxHp: 60, speed: 5, move: 2 },
    defenses: { ac: 17, fort: 8, ref: 10, will: 8 },
    // кит приёмов (план weapon-moves, волна 2): длинное копьё колет с двух
    // клеток, древко толкает в упор; пригвождающий — рисковый укол на всю
    // длину; волна клинка остаётся пятым действием (гейт словом каста)
    weapons: [
      {
        name: 'копьё ци',
        dmg: 6,
        dmgType: 'piercing',
        atkBonus: 9,
        range: 2,
        aoe: { line: { len: 4, mult: 0.75, dmgType: 'sonic' } },
        moves: [
          // та же школа, что у Юны, но копьём и на две клетки: множитель на удар
          // ниже (0.3 против 0.4) — за дистанцию платят уроном
          { id: 'chiJab', name: 'укол ци', slot: 'weakAttack', mult: 0.3, pair: true },
          { id: 'lunge', name: 'выпад', slot: 'attack', mult: 1 },
          { id: 'shaftPush', name: 'оттолкнуть древком', slot: 'weakAttack', mult: 0.4, push: true, range: 1, dmgType: 'bludgeoning' },
          { id: 'pinThrust', name: 'пригвождающий', slot: 'selflessAttack', mult: 1.4, expose: true },
        ],
      },
    ],
    reaction: 'deflectArrow',
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
    title: 'берсерк',
    role: 'front',
    stats: { maxHp: 68, speed: 6, move: 2 },
    defenses: { ac: 16, fort: 10, ref: 7, will: 5 },
    // кит приёмов (план weapon-moves, волна 3): секира рубит и рискует
    // «сплеча»; обух добирает и отгоняет (пуш живёт у шипов)
    weapons: [
      {
        name: 'секира',
        dmg: 9,
        dmgType: 'slashing',
        atkBonus: 9,
        range: 1,
        moves: [
          { id: 'ulvJab', name: 'тычок обухом', slot: 'weakAttack', mult: 0.6, dmgType: 'bludgeoning' },
          { id: 'ulvShove', name: 'отогнать плашмя', slot: 'weakAttack', mult: 0.4, push: true, dmgType: 'bludgeoning' },
          { id: 'ulvCut', name: 'рубящий', slot: 'attack', mult: 1 },
          { id: 'ulvAllOut', name: 'сплеча', slot: 'selflessAttack', mult: 1.6, expose: true },
        ],
      },
    ],
    active: { rage: { dmgMult: 1.3, vulnMult: 1.2 } },
    reaction: 'noEscape',
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
    title: 'тень',
    role: 'ranged',
    stats: { maxHp: 36, speed: 6, move: 1 },
    defenses: { ac: 16, fort: 7, ref: 10, will: 6 },
    // кит приёмов (план weapon-moves, волна 2): арбалет не частит вовсе —
    // быстрый темп живёт на засапожном ноже; болты бронебойные (пирс),
    // «выцелить» — весь ход в один расчётливый выстрел
    weapons: [
      {
        name: 'тяжёлый арбалет',
        dmg: 7,
        dmgType: 'piercing',
        atkBonus: 9,
        range: 6,
        moves: [
          { id: 'heavyBolt', name: 'тяжёлый болт', slot: 'attack', mult: 1.1, pierce: 0.3 },
          { id: 'kneeBolt', name: 'болт в колено', slot: 'attack', mult: 0.7, push: true },
          { id: 'deadEye', name: 'выцелить', slot: 'attack', mult: 1.8, ap: 3, sure: true },
          { id: 'pointBolt', name: 'болт в упор', slot: 'selflessAttack', mult: 1.5, expose: true },
        ],
      },
      {
        name: 'засапожный нож',
        agile: true,
        dmg: 5,
        dmgType: 'piercing',
        atkBonus: 9,
        range: 1,
        moves: [{ id: 'bootKnife', name: 'укол ножом', slot: 'weakAttack', mult: 0.6 }],
      },
    ],
    passives: { shadow: { mult: 1.25 } },
    reaction: 'disruptPrey',
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
    title: 'целительница',
    role: 'ranged',
    stats: { maxHp: 44, speed: 5, move: 2 },
    defenses: { ac: 15, fort: 7, ref: 6, will: 10 },
    // кит приёмов (план weapon-moves, волна 3): посох в упор бьёт и
    // отталкивает, «свет» достаёт на всю длину посоха; рискового темпа нет
    weapons: [
      {
        name: 'ясеневый посох',
        dmg: 5,
        dmgType: 'bludgeoning',
        atkBonus: 9,
        range: 3,
        moves: [
          { id: 'ivaJab', name: 'тычок', slot: 'weakAttack', mult: 0.6, range: 1 },
          { id: 'ivaPush', name: 'оттолкнуть', slot: 'weakAttack', mult: 0.4, push: true, range: 1 },
          { id: 'ivaStrike', name: 'удар посохом', slot: 'attack', mult: 1, range: 1 },
          { id: 'ivaLight', name: 'свет', slot: 'attack', mult: 0.8 },
        ],
      },
    ],
    active: { heal: { amount: 10, range: 4, usesPerBattle: 2 } },
    reaction: 'succor',
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
    title: 'воитель веры',
    role: 'front',
    stats: { maxHp: 72, speed: 4, move: 2 },
    defenses: { ac: 16, fort: 9, ref: 6, will: 10 },
    // кит приёмов (план weapon-moves, волна 3): молот не частит — быстрого
    // темпа нет; оглушающий отталкивает, «с замахом» — весь ход в один удар
    weapons: [
      {
        name: 'молот-благовест',
        dmg: 7,
        dmgType: 'bludgeoning',
        atkBonus: 9,
        range: 1,
        moves: [
          { id: 'radimStrike', name: 'удар', slot: 'attack', mult: 1 },
          { id: 'radimStun', name: 'оглушающий', slot: 'attack', mult: 0.8, push: true },
          { id: 'radimHaul', name: 'с замахом', slot: 'attack', mult: 2, ap: 3 },
          { id: 'radimSmite', name: 'карающий', slot: 'selflessAttack', mult: 1.45, expose: true },
        ],
      },
    ],
    active: { bless: { dmgMult: 1.25, range: 3, usesPerBattle: 1 } },
    reaction: 'succor',
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
    title: 'секироносец',
    role: 'front',
    stats: { maxHp: 64, speed: 5, move: 2 },
    defenses: { ac: 16, fort: 10, ref: 7, will: 6 },
    // кит приёмов (план weapon-moves, волна 3): двуручник не частит вовсе —
    // быстрого темпа нет; пролом ломает щиты, «замах с оттяжкой» — весь ход
    // в один страшный удар; росчерк остаётся пятым действием (гейт словом)
    weapons: [
      {
        name: 'двуручная секира',
        dmg: 9,
        dmgType: 'slashing',
        atkBonus: 9,
        range: 1,
        aoe: { line: { len: 2, mult: 0.75, dmgType: 'slashing' } },
        moves: [
          { id: 'rykCut', name: 'рубящий', slot: 'attack', mult: 1 },
          { id: 'rykBreak', name: 'пролом щитов', slot: 'attack', mult: 0.9, pierce: 0.3 },
          { id: 'rykHaul', name: 'замах с оттяжкой', slot: 'attack', mult: 2.1, ap: 3 },
          { id: 'rykAllOut', name: 'сплеча', slot: 'selflessAttack', mult: 1.6, expose: true },
        ],
      },
    ],
    reaction: 'noEscape',
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
    title: 'трюкачка',
    role: 'melee',
    stats: { maxHp: 42, speed: 8, move: 3 },
    defenses: { ac: 16, fort: 6, ref: 11, will: 7 },
    // кит приёмов (план weapon-moves, волна 2): полный темп — три разных
    // ножа (чистый, подсечка-толчок, отскок), общий с Тессой профиль — росчерк
    // в окружении и «в печень» (пересечение класса — ровно два)
    weapons: [
      {
        name: 'парные ножи',
        dmg: 6,
        dmgType: 'piercing',
        atkBonus: 9,
        range: 1,
        agile: true,
        moves: [
          // парный приём (план action-economy, волна 6): два ножа — два
          // удара в одном действии, оба по текущему MAP (pf2e Twin Feint).
          // Райдер толпы снят: приём и так вдвое, а «град в окружении»
          // остаётся почерком Тессы — пересечение в классе падает до одного
          { id: 'twinSlash', name: 'двойной росчерк', slot: 'weakAttack', mult: 0.35, pair: true },
          { id: 'liverStab', name: 'в печень', slot: 'attack', mult: 1 },
          { id: 'legSweep', name: 'подсечка', slot: 'attack', mult: 0.6, push: true, dmgType: 'bludgeoning' },
          { id: 'hopSting', name: 'отскок с уколом', slot: 'attack', mult: 0.7, stepBack: true },
        ],
      },
    ],
    active: { feint: {} },
    reaction: 'nimbleDodge',
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
    title: 'контролёр',
    role: 'ranged',
    stats: { maxHp: 38, speed: 5, move: 2 },
    defenses: { ac: 15, fort: 6, ref: 8, will: 9 },
    // кит приёмов (план weapon-moves, волна 3): контролёр ближней зоны —
    // плеть бьёт на 2, жар отталкивает (дистанционный толчок, срезанный в
    // плане классов, теперь бесплатен — райдер push готов); искра добирает
    // издали, полымя держит пространство
    weapons: [
      {
        name: 'гримуар пламени',
        dmg: 6,
        dmgType: 'fire',
        atkBonus: 9,
        range: 4,
        aoe: { ritual: { range: 5, mult: 0.8, cooldown: 4, pulses: 3, dmgType: 'fire' } },
        moves: [
          { id: 'vestaSpark', name: 'искра', slot: 'weakAttack', mult: 0.55 },
          { id: 'vestaRepel', name: 'отпугнуть жаром', slot: 'weakAttack', mult: 0.4, push: true, range: 2 },
          { id: 'vestaLash', name: 'жгучая плеть', slot: 'attack', mult: 0.9, range: 2 },
          // носитель горения (план damage-types, волна 6): удар слабее плети,
          // но оставляет огонь — и по уже горящему приём ничего не добавляет,
          // поэтому Веста сама разносит пламя по строю, а не жжёт одного
          { id: 'vestaIgnite', name: 'поджечь', slot: 'attack', mult: 0.5, range: 2, persist: { dmg: 1 } },
          { id: 'vestaWildLash', name: 'плеть наотмашь', slot: 'selflessAttack', mult: 1.4, expose: true, range: 2 },
        ],
      },
    ],
    reaction: 'arcaneShield',
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
    title: 'шквал',
    role: 'melee',
    stats: { maxHp: 52, speed: 7, move: 3 },
    defenses: { ac: 17, fort: 9, ref: 10, will: 8 },
    // кит приёмов (план weapon-moves, волна 2): weakMult 0.55 переехал в
    // «шквал»; ладонь бури толкает, «уход с ударом» — бей-беги, «серия
    // дыхания» — весь ход в одну цель. Чистого полного удара нет намеренно:
    // при шквале 0.55 он мёртв по экономике (2×0.55 > 1.0) — вместо него
    // рисковый «глаз бури»
    weapons: [
      {
        name: 'кулаки бури',
        dmg: 7,
        dmgType: 'bludgeoning',
        atkBonus: 9,
        range: 1,
        agile: true,
        moves: [
          // Flurry of Blows (план action-economy, волна 6): два удара за одно
          // очко хода, оба по текущему MAP. Множитель — на удар, поэтому
          // приём стоит 0.8 против общих 0.6 быстрого темпа: волюм монахини
          // теперь в самом приёме, а не в повышенном weakMult
          { id: 'squall', name: 'шквал', slot: 'weakAttack', mult: 0.4, pair: true },
          { id: 'stormEye', name: 'глаз бури', slot: 'selflessAttack', mult: 1.5, expose: true },
          { id: 'stormPalm', name: 'ладонь бури', slot: 'attack', mult: 0.65, push: true },
          { id: 'breathChain', name: 'серия дыхания', slot: 'attack', mult: 1.7, ap: 3 },
          { id: 'driftStrike', name: 'уход с ударом', slot: 'attack', mult: 0.7, stepBack: true },
        ],
      },
    ],
    reaction: 'deflectArrow',
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
    title: 'карательница',
    role: 'front',
    stats: { maxHp: 68, speed: 5, move: 2 },
    defenses: { ac: 17, fort: 9, ref: 6, will: 9 },
    // кит приёмов (план weapon-moves, волна 3): «свет зари» достаёт на 2,
    // «рассечь строй» крепче в толпе своих, «воздаяние» — рисковый удар
    // мстительницы (пассив «Кара» умножает его по обидчику)
    weapons: [
      {
        name: 'клинок зари',
        dmg: 8,
        dmgType: 'slashing',
        atkBonus: 9,
        range: 1,
        moves: [
          { id: 'zaryaJab', name: 'укол', slot: 'weakAttack', mult: 0.6, dmgType: 'piercing' },
          { id: 'zaryaTrue', name: 'верный удар', slot: 'attack', mult: 1 },
          { id: 'zaryaLight', name: 'свет зари', slot: 'attack', mult: 0.7, range: 2 },
          { id: 'zaryaCleave', name: 'рассечь строй', slot: 'attack', mult: 0.85, gang: 0.1 },
          { id: 'zaryaSmite', name: 'воздаяние', slot: 'selflessAttack', mult: 1.5, expose: true },
        ],
      },
    ],
    passives: { retribution: { mult: 1.25 } },
    reaction: 'retributiveStrike',
    ability: { name: 'Кара', desc: 'обидчик своих получает сполна' },
    innate: [
      r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'attacker' }, weight: 0.9, source: 'способность: Кара' }),
    ],
  },
  {
    // воин-мастер оружия (кит приёмов, план weapon-moves): у каждого оружия
    // своя ниша, доминации нет — копьё единственное достаёт на 2, меч даёт
    // лучший быстрый укол в упор, молот пробивает укрытия и щиты (пирс) и
    // единственный умеет рискнуть «сплеча»
    id: 'yar',
    name: 'Яр',
    class: 'воин',
    title: 'мастер оружия',
    role: 'front',
    stats: { maxHp: 56, speed: 5, move: 2 },
    defenses: { ac: 17, fort: 10, ref: 7, will: 6 },
    weapons: [
      {
        name: 'копьё',
        dmg: 6,
        range: 2,
        dmgType: 'piercing',
        atkBonus: 9,
        moves: [
          { id: 'spearJab', name: 'укол копьём', slot: 'weakAttack', mult: 0.6 },
          { id: 'spearSweep', name: 'отмах древком', slot: 'attack', mult: 0.9 },
        ],
      },
      {
        name: 'меч',
        dmg: 7,
        range: 1,
        dmgType: 'slashing',
        atkBonus: 9,
        moves: [{ id: 'swordFlurry', name: 'серия уколов', slot: 'weakAttack', mult: 0.65 }],
      },
      {
        name: 'молот',
        dmg: 8,
        range: 1,
        dmgType: 'bludgeoning',
        atkBonus: 9,
        moves: [
          { id: 'hammerBreak', name: 'пролом', slot: 'attack', mult: 1.05, pierce: 0.3 },
          { id: 'hammerAllOut', name: 'сплеча', slot: 'selflessAttack', mult: 1.55, expose: true },
        ],
      },
    ],
    reaction: 'reactiveStrike',
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
