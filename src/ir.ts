import type { CombatUnit, LensId, Pos, Zone } from './types.js';
import { GRID_H, GRID_W, dist, posInZone, zoneDist } from './grid.js';
import { DEFAULT_AC } from './tuning.js';

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
 *   Действия:  shove (толкать — в шипы, в огонь, из строя)
 * План АОЕ:
 *   Условия:   underCharge (враги накатывают — дотянутся за свой ход)
 *   Действия:  barrage (накрыть скопление — гейт площадного каста носителя),
 *              preempt (бить на упреждение — манера ритуала: целить в проекцию),
 *              castRitual (замахиваться ритуалом — манера: ритуал, не залп)
 *   Простр.:   spread (держать интервал — пока у врага жив АОЕ-носитель)
 * План классов:
 *   Действия:  rage (впасть в ярость — гейт актива носителя: урон ×, входящий ×,
 *              до конца боя; слово решает КОГДА потратить),
 *              heal (лечить — гейт актива целителя; цель выбирает скоринг по нужде),
 *              bless (благословить — актив жреца; своего слова пока нет:
 *              жмётся врождённым правилом, словарь бережём для words-плана),
 *              feint (финт — актив трюкачки, тоже без слова: открыть врага
 *              под удары своих)
 * Темп:
 *   Действия:  wait (ждать — не сближаться и приберечь ход, пока до меня не
 *              докатилось; вторая половина замысла — отдельное правило с
 *              условием: «подожди, а ПОТОМ …»)
 * Вторая партия слов (план words):
 *   Условия:   enemyAdjacent (враг вплотную), allyAdjacent (союзник рядом),
 *              alone (я в отрыве), weOutnumber (нас больше), enemyShooters
 *              (у врага стрелки), enemyCasters (у врага заклинатель),
 *              enemyWavering (враг дрогнул — половина пала), lastEnemy (враг
 *              остался один), allyHurt (кто-то из наших ранен),
 *              enemiesClustered (враги скучились); плюс словами игрока стали
 *              hpAbove, firstBlood, leaderDown, wasHit
 *   Селекторы: strongest (самый здоровый), fastest (самый быстрый), healer
 *              (вражеский лекарь), caster (вражеский заклинатель), straggler
 *              (отбившийся от своих), tormentor (обидчик наших)
 *   Действия:  finish (добивать), focusFire (бить туда же); плюс слова-гейты
 *              bless и feint к уже существующим активам
 * План teamwork (внимание и цена дороги):
 *   Действия:  taunt (вызывать на себя — стойка провокации: пока держится,
 *              прочие цели дешевеют для восприимчивых врагов), lure (уводить
 *              от X — быть у врагов на виду, но подальше от подопечного).
 *              Пара слов складывается в «отвлекай врагов от X и уводи их в
 *              сторону»; сама подмена цели — правило мира, не слово
 * Слова рельефа (взаимодействие с картой):
 *   Простр.:   roughEdge (стеречь кромку — ждать у труднопроходной земли, не
 *              ступая на неё: пусть враг вязнет на подходе под выстрелами),
 *              outflank (обходить из-за спин — заходить врагу сбоку одной
 *              стороной, не выходя вперёд своих)
 * План teamwork, вторая волна (совместные действия):
 *   Ссылки:    AllyRef — свой по имени (как было) ИЛИ по роли: раненый,
 *              передовой, наш стрелок, наш крикун, ближайший свой. Роль
 *              читается в момент решения, себя не выбирает и подстановок не
 *              делает: некого — правило молчит
 *   Условия:   allyTaunting (наш держит вызов), allyEngaged (наш в контакте),
 *              guarded (меня прикрывают), allySurrounded (нашего обступили),
 *              alliesFocusing (наши навалились)
 *   Действия:  screen (заслонить от стрелков — телом порвать линию огня к
 *              подопечному), regroup (сомкнуть строй — зеркало интервала),
 *              swap (меняться местами со смежным своим — 1 AP платит только
 *              затевающий)
 * План teamwork, третья волна (канал метки и позиция относительно своих):
 *   Ссылки:    роли caster (наш заклинатель) и healer (наш лекарь) — маг с
 *              ритуалом и целитель ролью «наш стрелок» невыразимы
 *   Условия:   spreadThin (мы растянулись — кто-то из наших без соседа-своего)
 *   Действия:  mark (метить цель — стойка: мои удары вешают метку всей
 *              стороне, канал sel.marked), fallback (отходить за спины —
 *              отступать К своим, а не от врага в никуда), clearLine (не
 *              застить своим — не вставать на линию выстрела своих стрелков),
 *              pin (связывать боем — держать контакт с врагом, которого не
 *              держит никто из своих: разбирать толпу по одному)
 * Четвёртая партия слов (план words) — «чтение боя»: условия про землю и
 *   момент, селекторы про чужое внимание и контакт:
 *   Условия:   lull (затишье — ни один враг не дотянется до меня за свой
 *              ход; отрицание underCharge, гейт безопасного окна), onHighGround
 *              (я на высоте — читает террейн), cornered (меня прижали —
 *              свободных смежных клеток не осталось; ниша «отчаянно» и обмена),
 *              inFormation (строй сомкнут — зеркало spreadThin)
 *   Селекторы: heckler (вражеский крикун — кто держит стойку вызова; контра
 *              задире), unengaged (свободный враг — которого не держит
 *              вплотную никто из наших, кроме меня; пара к act.pin)
 *   Условиям рельефа нужен вид на землю — опциональный GroundView в
 *   evalCondition; не передан — условия рельефа молчат (нет арены — нет слова)
 * План objectives, волна 2 — слова задач боя (зоны, подопечные, трофей):
 *   Ссылки:    роли ward (подопечный задачи — юнит с тегом ward: обоз, чтец,
 *              старейшина) и carrier (наш носильщик — кто несёт трофей, тег
 *              carrier); обе дают защитным связкам якорь, переживающий смену
 *              сценария
 *   Условия:   inZone (я на рубеже — стою в зоне задачи), enemyInZone (враг
 *              на рубеже), timeShort (время на исходе — до дедлайна задачи
 *              ≤ TIME_SHORT_LEFT раундов), prizeHeld (трофей у наших — кто-то
 *              из своих несёт ношу). Зону и дедлайн читают из GroundView —
 *              без задачи слова молчат, как рельефные без арены
 *   Селекторы: intruder (прорывающийся — враг в зоне задачи или ближайший к
 *              ней: контра обороны рубежа и перехват гонца), ward — внутренний
 *              селектор врагов «бить подопечного» (слова игрока не имеет:
 *              подопечный — своя сторона)
 *   Действия:  holdLine (держать рубеж — стоять в зоне задачи), evacuate
 *              (уходить к выходу — пробиваться в зону задачи), carry (нести
 *              трофей — поднять ношу и доставить в зону)
 * Вложенность (глубокие чипсы): and — конъюнкция условий («если А: если Б —
 *   делай X» → одно правило с when = and[А, Б]), or — дизъюнкция («если А
 *   или Б»). «Или» одним правилом — не то же, что две фразы: при обоих
 *   истинных условиях or-правило горит один раз, две фразы — удвоенным весом.
 *   not — отрицание простого условия («если НЕ А»); в and/or входит наравне
 *   с простыми, но само комбинаторов внутрь не берёт.
 */

export type Selector =
  | 'nearest'
  | 'weakest'
  | 'leader'
  | 'mostDangerous'
  | 'attacker'
  | 'marked'
  | 'shooter'
  | 'farthest'
  | 'strongest'
  | 'fastest'
  | 'healer'
  | 'caster'
  | 'straggler'
  | 'tormentor'
  | 'heckler'
  | 'unengaged'
  | 'intruder'
  | 'ward'
  | 'vulnerable'
  | 'armored';

/**
 * Роль своего вместо имени (план teamwork, вторая волна): принцип переживает
 * смену партии, а подопечный определяется по ходу боя. Разрешается строго —
 * отката «нет такого, возьми ближайшего» у ролей нет (в отличие от вражеских
 * селекторов): некого — правило молчит.
 */
export type AllyRole =
  | 'wounded'
  | 'frontman'
  | 'shooter'
  | 'taunter'
  | 'nearest'
  | 'caster'
  | 'healer'
  | 'ward'
  | 'carrier';

/** Ссылка на своего: имя героя (как было) или роль. */
export type AllyRef = string | { role: AllyRole };

/**
 * Как роль называется по-русски в трёх падежах — фразы конструктора,
 * карточка «как понял» и чипсы UI строятся из одной таблицы, чтобы приказ и
 * эхо совпадали слово в слово.
 */
export const ALLY_ROLE_RU: Record<AllyRole, { nom: string; gen: string; ins: string }> = {
  wounded: { nom: 'наш раненый', gen: 'нашего раненого', ins: 'нашим раненым' },
  frontman: { nom: 'передовой', gen: 'передового', ins: 'передовым' },
  shooter: { nom: 'наш стрелок', gen: 'нашего стрелка', ins: 'нашим стрелком' },
  taunter: { nom: 'наш крикун', gen: 'нашего крикуна', ins: 'нашим крикуном' },
  nearest: { nom: 'ближайший свой', gen: 'ближайшего своего', ins: 'ближайшим своим' },
  caster: { nom: 'наш заклинатель', gen: 'нашего заклинателя', ins: 'нашим заклинателем' },
  healer: { nom: 'наш лекарь', gen: 'нашего лекаря', ins: 'нашим лекарем' },
  ward: { nom: 'подопечный задачи', gen: 'подопечного задачи', ins: 'подопечным задачи' },
  carrier: { nom: 'наш носильщик', gen: 'нашего носильщика', ins: 'нашим носильщиком' },
};

/** «Время на исходе»: осталось не больше стольких раундов до дедлайна задачи. */
export const TIME_SHORT_LEFT = 2;

/** С какого раунда бой считается затянувшимся. */
export const BATTLE_DRAGS_ROUND = 5;

export type Condition =
  | { kind: 'always' }
  | { kind: 'hpBelow'; who: 'self' | { ally: AllyRef }; frac: number }
  /** Зеркало hpBelow — «пока цел»: для контекстных прочтений линз (план линз); слова игрока пока нет. */
  | { kind: 'hpAbove'; who: 'self' | { ally: AllyRef }; frac: number }
  | { kind: 'outnumbered' }
  | { kind: 'allyInDanger'; ally: AllyRef }
  | { kind: 'battleDrags' }
  | { kind: 'initiativeEdge' }
  | { kind: 'allyFallen' }
  | { kind: 'surrounded' }
  | { kind: 'underCharge' }
  // условия-триггеры плана линз (дрейф и контекстные прочтения);
  // слов игрока пока нет — открытие решает words-план, врагам можно сразу
  /** Кровь уже пролилась — кто-то в бою ранен или пал (любой стороной). */
  | { kind: 'firstBlood' }
  /** Вожак противника пал. */
  | { kind: 'leaderDown' }
  /** Меня уже били в этом бою (есть последний обидчик). */
  | { kind: 'wasHit' }
  // вторая партия слов (план words)
  /** Враг вплотную — хотя бы один смежен со мной. */
  | { kind: 'enemyAdjacent' }
  /** Плечом к плечу — рядом (смежно) стоит живой союзник. */
  | { kind: 'allyAdjacent' }
  /** Я в отрыве — ни одного живого союзника в двух клетках. */
  | { kind: 'alone' }
  /** Нас больше, чем врагов (зеркало outnumbered). */
  | { kind: 'weOutnumber' }
  /** У врага живы стрелки (дальность > 1). */
  | { kind: 'enemyShooters' }
  /** У врага жив носитель площадного оружия. */
  | { kind: 'enemyCasters' }
  /** Враг дрогнул: пала уже хотя бы половина вражеского отряда. */
  | { kind: 'enemyWavering' }
  /** Враг остался один. */
  | { kind: 'lastEnemy' }
  /** Кто-то из наших (кроме меня) ранен ниже половины. */
  | { kind: 'allyHurt' }
  /** Враги скучились: хотя бы двое стоят вплотную друг к другу. */
  | { kind: 'enemiesClustered' }
  // вторая волна teamwork: условия про то, что делают СВОИ
  /** Кто-то из своих держит стойку вызова. */
  | { kind: 'allyTaunting' }
  /** Кто-то из своих стоит вплотную к врагу. */
  | { kind: 'allyEngaged' }
  /** На мне живое чужое прикрытие — щит союзника или стена. */
  | { kind: 'guarded' }
  /** Кого-то из своих обступили: два и больше смежных врага. */
  | { kind: 'allySurrounded' }
  /** Наши навалились: кого-то из врагов уже бил кто-то из своих. */
  | { kind: 'alliesFocusing' }
  // третья волна teamwork
  /** Мы растянулись: кто-то из наших (включая меня) стоит без соседа-своего. */
  | { kind: 'spreadThin' }
  // четвёртая партия слов — «чтение боя»
  /** Затишье: ни один враг не дотянется до меня за свой ход (отрицание underCharge). */
  | { kind: 'lull' }
  /**
   * Оружие не берёт (план damage-types): ближайший враг держит или вовсе не
   * чувствует ВСЕ типы урона моего арсенала. Гейт для «сменить цель» и
   * «отойти»: слово о том, что драка бессмысленна именно этими руками.
   */
  | { kind: 'weaponFails' }
  /**
   * На мне тлеет (план damage-types, волна 6): длящийся урон любого типа —
   * огонь, яд, кровь. Гейт для «сбивать пламя» и «отходить».
   */
  | { kind: 'smoldering' }
  /** Я на высоте: моя клетка выше уровня поля (нужен GroundView, без него — молчит). */
  | { kind: 'onHighGround' }
  /** Меня прижали: свободных смежных клеток ≤ 1 (границы, камень, тела). */
  | { kind: 'cornered' }
  /** Строй сомкнут: каждый из наших со смежным своим (зеркало spreadThin). */
  | { kind: 'inFormation' }
  // план objectives, волна 2 — условия задач боя (зона и дедлайн из GroundView)
  /** Я на рубеже: стою в зоне задачи; без зоны молчит. */
  | { kind: 'inZone' }
  /** Враг на рубеже: хотя бы один живой враг в зоне задачи. */
  | { kind: 'enemyInZone' }
  /** Время на исходе: до дедлайна задачи ≤ TIME_SHORT_LEFT раундов; без таймера молчит. */
  | { kind: 'timeShort' }
  /** Трофей у наших: кто-то из своих (включая меня) несёт ношу (тег carrier). */
  | { kind: 'prizeHeld' }
  /**
   * Конъюнкция — глубокие чипсы: «если А: если Б — …». Из черновиков внутри
   * только простые условия и «или»; вложенные группы конструктор расплющивает сам.
   */
  | { kind: 'and'; conds: Condition[] }
  /** Дизъюнкция — «если А или Б»: горит, когда истинно хотя бы одно. */
  | { kind: 'or'; conds: Condition[] }
  /**
   * Отрицание — «если НЕ А»: та же грамматика, что «и»/«или», слова не стоит.
   * Из черновиков внутри только ПРОСТОЕ условие: `not` навешивается на атом,
   * а не на комбинатор, — «не (А и Б)» в языке не выражается.
   *
   * Инверсия буквальная: условие, молчащее без данных (нет высот на арене,
   * нет таймера у сценария), под отрицанием даёт true. «Я не на высоте» на
   * плоской арене — правда; но «пока время НЕ на исходе» в сценарии без
   * дедлайна горит всегда, и это осознанная цена простоты.
   */
  | { kind: 'not'; cond: Condition };

/** Ссылка на позицию-якорь для пространственных предпочтений. */
export type PosRef = { type: 'ally'; id: AllyRef } | { type: 'enemy'; sel: Selector };

export type Preference =
  | { kind: 'attack'; target: Selector }
  | { kind: 'protect'; ally: AllyRef }
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
  | { kind: 'avoidHazard' }
  /** Стеречь кромку: ждать у труднопроходной земли, не ступая на неё. */
  | { kind: 'roughEdge' }
  /** Обходить из-за спин: заходить врагу сбоку, не выходя вперёд своих. */
  | { kind: 'outflank' }
  | { kind: 'shove' }
  | { kind: 'barrage' }
  | { kind: 'spread' }
  | { kind: 'preempt' }
  | { kind: 'castRitual' }
  | { kind: 'wait' }
  | { kind: 'rage' }
  | { kind: 'heal' }
  | { kind: 'bless' }
  | { kind: 'feint' }
  /**
   * Сбивать пламя (план damage-types, волна 6): гасить длящийся урон себе и
   * своим — помощь роняет DC ближайшей проверки.
   */
  | { kind: 'douse' }
  // вторая партия слов (план words): манеры выбора цели, а не «кого бить»
  /** Добивать: предпочитать удар, который снимает цель с поля. */
  | { kind: 'finish' }
  /** Бить туда же: наваливаться на врага, которого уже бил кто-то из своих. */
  | { kind: 'focusFire' }
  // внутрикомандное взаимодействие (план teamwork): не «кого бить», а «на кого
  // будет смотреть враг». Работают через доступность цели: провокатор уводит
  // внимание с прочих, а «уводить» ещё и тащит его самого прочь от подопечного
  /** Вызывать на себя: стойка провокации — пока держится, прочие цели дешевеют для врагов. */
  | { kind: 'taunt' }
  /**
   * Уводить от X: быть у врагов на виду, но подальше от подопечного. Внимания
   * само не забирает (это дело «вызывать на себя») — работает против тех, кто
   * бьёт ближайшего, и в связке с вызовом.
   */
  | { kind: 'lure'; ally: AllyRef }
  // вторая волна teamwork: действия, у которых смысл есть только рядом со своими
  /** Заслонить от стрелков: встать телом на линию огня к подопечному. */
  | { kind: 'screen'; ally: AllyRef }
  /** Сомкнуть строй: держаться плечом к плечу со своими (зеркало интервала). */
  | { kind: 'regroup' }
  /** Меняться местами: вытащить смежного своего из-под удара, встав на его клетку. */
  | { kind: 'swap'; ally: AllyRef }
  // третья волна teamwork: канал метки и позиция относительно своих
  /** Метить цель: стойка — мои удары вешают метку всей стороне (канал sel.marked). */
  | { kind: 'mark' }
  /** Отходить за спины: отступать к своим — за живой заслон, а не к краю карты. */
  | { kind: 'fallback' }
  /** Не застить своим: не вставать на линию выстрела своих стрелков. */
  | { kind: 'clearLine' }
  /** Связывать боем: держать контакт с врагом, которого не держит никто из своих. */
  | { kind: 'pin' }
  // план objectives, волна 2: слова задач боя
  /** Держать рубеж: стоять в зоне задачи и не отдавать её. */
  | { kind: 'holdLine' }
  /** Уходить к выходу: пробиваться в зону задачи — бой не главное. */
  | { kind: 'evacuate' }
  /** Нести трофей: поднять ношу задачи и доставить её в зону. */
  | { kind: 'carry' };

/**
 * Структурная пометка линзы: что характер сделал с правилом (план линз).
 * Заполняется в applyLens; source остаётся чистой формулировкой игрока,
 * а текст «как понял» строят из пометок карточка и журнал боя.
 */
export type LensMark =
  | { lens: LensId; kind: 'reword'; from: Preference }
  | { lens: LensId; kind: 'recondition'; from: Condition }
  | { lens: LensId; kind: 'reweight'; mult: number }
  /** Правило добавлено самой линзой, а не игроком. */
  | { lens: LensId; kind: 'instinct' };

export interface Rule {
  when: Condition;
  then: Preference;
  weight: number;
  scope: 'self';
  /** Откуда правило (формулировка принципа) — идёт в лог решений. */
  source: string;
  /** Следы линз; отсутствие поля = правило понято дословно. */
  marks?: LensMark[];
  /**
   * Фокус игрока (план nerve): приказ, за который боец держится. Кроме
   * повышенного веса он собирает бойца — режим нерва шатает его решения слабее.
   */
  focus?: boolean;
  /**
   * Врождённое правило способности героя (heroes.ts), а не слово игрока.
   * В режиме нерва приказ игрока перебивает врождённую тягу в большинстве
   * решений (OBEY_CHANCE) — пометка отличает, кого глушить.
   */
  innate?: true;
}

/**
 * Слово игрока, а не встроенное поведение: не врождённое правило способности
 * и не инстинкт, дописанный линзой. Правило, искажённое линзой (reword),
 * остаётся словом игрока — это его приказ, пусть и понятый по-своему.
 */
export function isPlayerRule(r: Rule): boolean {
  return !r.innate && !(r.marks?.some((m) => m.kind === 'instinct') ?? false);
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

/**
 * Кто имеется в виду под ссылкой на своего (план teamwork, вторая волна).
 * Имя — как было; роль читается прямо сейчас, поэтому подопечный меняется по
 * ходу боя. Себя роль не выбирает никогда, подстановок не делает: некого —
 * undefined, и правило молчит. Тайбрейк по id — детерминизм.
 */
export function resolveAlly(
  ref: AllyRef,
  self: CombatUnit,
  units: readonly CombatUnit[],
): CombatUnit | undefined {
  if (typeof ref === 'string') {
    const u = byId(units, ref);
    return u && u.alive ? u : undefined;
  }
  const mates = alliesOf(self, units).filter((a) => a.id !== self.id);
  const best = (pool: readonly CombatUnit[], score: (u: CombatUnit) => number): CombatUnit | undefined =>
    pool.reduce<CombatUnit | undefined>((b, u) => {
      if (!b) return u;
      const s = score(u);
      const bs = score(b);
      return s < bs || (s === bs && u.id < b.id) ? u : b;
    }, undefined);
  switch (ref.role) {
    case 'wounded':
      // «раненый» — именно раненый: у целой партии подопечного нет
      return best(mates.filter((a) => a.hp < a.maxHp), (u) => u.hp / u.maxHp);
    case 'frontman': {
      const foes = enemiesOf(self, units);
      if (foes.length === 0) return undefined;
      return best(mates, (u) => Math.min(...foes.map((e) => dist(e.pos, u.pos))));
    }
    case 'shooter':
      return best(mates.filter((a) => a.range > 1), (u) => dist(u.pos, self.pos));
    case 'taunter':
      return best(mates.filter((a) => a.stance?.taunt), (u) => dist(u.pos, self.pos));
    case 'nearest':
      return best(mates, (u) => dist(u.pos, self.pos));
    case 'caster':
      return best(mates.filter((a) => a.aoe !== undefined), (u) => dist(u.pos, self.pos));
    case 'healer':
      return best(mates.filter((a) => a.active?.heal), (u) => dist(u.pos, self.pos));
    case 'ward':
      // подопечный задачи: обоз, чтец, старейшина — тег вешает бой из задачи
      return best(mates.filter((a) => a.tags?.includes('ward')), (u) => dist(u.pos, self.pos));
    case 'carrier':
      // носильщик трофея: тег живёт от поднятия до смерти или доставки
      return best(mates.filter((a) => a.tags?.includes('carrier')), (u) => dist(u.pos, self.pos));
  }
}

/**
 * Вид на землю для условий рельефа (четвёртая партия слов). ScoreCtx подходит
 * структурно; не передан (юнит-тесты, оценки вне арены) — условия рельефа
 * молчат: нет арены — нет слова, как у «стеречь кромку».
 */
export interface GroundView {
  heightAt: (p: Pos) => number;
  blocked: (p: Pos) => boolean;
  /** Зона задачи боя (план objectives, волна 2); нет задачи с зоной — зонные слова молчат. */
  zone?: Zone;
  /** Раунд-дедлайн задачи (ритуал, рассвет, рубеж); нет таймера — «время на исходе» молчит. */
  deadline?: number;
}

export function evalCondition(
  cond: Condition,
  self: CombatUnit,
  units: readonly CombatUnit[],
  round = 1,
  ground?: GroundView,
): boolean {
  switch (cond.kind) {
    case 'always':
      return true;
    case 'hpBelow': {
      const u = cond.who === 'self' ? self : resolveAlly(cond.who.ally, self, units);
      return !!u && u.alive && u.hp < cond.frac * u.maxHp;
    }
    case 'hpAbove': {
      // точный комплемент hpBelow: при равном frac активна ровно одна половина расщепления
      const u = cond.who === 'self' ? self : resolveAlly(cond.who.ally, self, units);
      return !!u && u.alive && u.hp >= cond.frac * u.maxHp;
    }
    case 'outnumbered':
      return enemiesOf(self, units).length > alliesOf(self, units).length;
    case 'allyInDanger': {
      const ally = resolveAlly(cond.ally, self, units);
      if (!ally || !ally.alive) return false;
      const adjEnemies = enemiesOf(self, units).filter((e) => dist(e.pos, ally.pos) === 1);
      return ally.hp < 0.5 * ally.maxHp || adjEnemies.length >= 2;
    }
    case 'battleDrags':
      return round >= BATTLE_DRAGS_ROUND;
    case 'initiativeEdge': {
      // «мы быстрее»: я хожу раньше своего ближайшего врага. Сравнение средних
      // скоростей сторон (как было) — константа матчапа: условие вырождалось
      // в always или мёртвый груз (аудит words). Пер-юнитная семантика даёт
      // окно «ударь до ответа» — гейт размена и отчаянного удара
      const nearest = resolveSelector('nearest', self, units);
      return nearest !== undefined && self.speed > nearest.speed;
    }
    case 'allyFallen':
      return units.some((u) => u.side === self.side && u.id !== self.id && !u.alive);
    case 'surrounded':
      return enemiesOf(self, units).filter((e) => dist(e.pos, self.pos) === 1).length >= 2;
    case 'underCharge':
      // враги накатывают: хотя бы один дотянется до меня за свой ход
      // (два шага + дальность — та же формула, что strikeReach в скоринге)
      return enemiesOf(self, units).some((e) => dist(e.pos, self.pos) <= e.move * 2 + e.range);
    case 'firstBlood':
      // выводимо из состояния: кровь пролилась = у кого-то не полное hp или кто-то пал
      return units.some((u) => !u.alive || u.hp < u.maxHp);
    case 'leaderDown':
      return units.some((u) => !u.alive && u.side !== self.side && u.tags?.includes('leader'));
    case 'wasHit':
      return self.lastAttackerId !== undefined;
    case 'enemyAdjacent':
      return enemiesOf(self, units).some((e) => dist(e.pos, self.pos) === 1);
    case 'allyAdjacent':
      return alliesOf(self, units).some((a) => a.id !== self.id && dist(a.pos, self.pos) === 1);
    case 'alone':
      return !alliesOf(self, units).some((a) => a.id !== self.id && dist(a.pos, self.pos) <= 2);
    case 'weOutnumber':
      return alliesOf(self, units).length > enemiesOf(self, units).length;
    case 'enemyShooters':
      return enemiesOf(self, units).some((e) => e.range > 1);
    case 'enemyCasters':
      return enemiesOf(self, units).some((e) => e.aoe !== undefined);
    case 'enemyWavering': {
      const fallen = units.filter((u) => u.side !== self.side && !u.alive).length;
      return fallen >= 1 && fallen >= enemiesOf(self, units).length;
    }
    case 'lastEnemy':
      return enemiesOf(self, units).length === 1;
    case 'allyHurt':
      return alliesOf(self, units).some((a) => a.id !== self.id && a.hp < 0.5 * a.maxHp);
    case 'enemiesClustered': {
      const es = enemiesOf(self, units);
      return es.some((e) => es.some((o) => o.id !== e.id && dist(e.pos, o.pos) === 1));
    }
    case 'allyTaunting':
      return alliesOf(self, units).some((a) => a.id !== self.id && a.stance?.taunt === true);
    case 'allyEngaged': {
      const es = enemiesOf(self, units);
      return alliesOf(self, units).some(
        (a) => a.id !== self.id && es.some((e) => dist(e.pos, a.pos) === 1),
      );
    }
    case 'guarded': {
      // чужое прикрытие живо, только пока щитоносец жив и рядом (та же
      // проверка, что у effectiveGuard) — своя оборона условием не считается
      const g = self.guardedBy;
      if (!g) return false;
      const protector = byId(units, g.id);
      return !!protector && protector.alive && dist(protector.pos, self.pos) <= 1;
    }
    case 'allySurrounded': {
      const es = enemiesOf(self, units);
      return alliesOf(self, units).some(
        (a) => a.id !== self.id && es.filter((e) => dist(e.pos, a.pos) === 1).length >= 2,
      );
    }
    case 'alliesFocusing': {
      // канал lastAttackerId — тот же, что у «бить туда же»; свои удары не в
      // счёт: условие про то, что делает команда, а не я
      const mates = alliesOf(self, units).filter((a) => a.id !== self.id);
      return enemiesOf(self, units).some((e) => mates.some((a) => e.lastAttackerId === a.id));
    }
    case 'spreadThin': {
      // строй разорван: кто-то из наших (включая меня) без смежного своего.
      // Одному рваться не от кого — у отряда из одного условие молчит
      const own = alliesOf(self, units);
      if (own.length < 2) return false;
      return own.some((u) => !own.some((o) => o.id !== u.id && dist(o.pos, u.pos) <= 1));
    }
    case 'smoldering':
      return (self.persist?.length ?? 0) > 0;
    case 'weaponFails': {
      // считаем по ближайшему живому врагу: тип, которым я его беру без
      // скидки, — есть? Значит, оружие берёт. Урон без типа берёт всегда
      const foes = units.filter((u) => u.alive && u.side !== self.side && !u.inert);
      if (foes.length === 0) return false;
      const target = foes.reduce((best, u) =>
        dist(u.pos, self.pos) < dist(best.pos, self.pos) ||
        (dist(u.pos, self.pos) === dist(best.pos, self.pos) && u.id < best.id)
          ? u
          : best,
      );
      // тип приёма перебивает оружейный, приём без своего типа наследует его
      const types = (self.weapons ?? []).flatMap((w) =>
        w.moves && w.moves.length > 0 ? w.moves.map((m) => m.dmgType ?? w.dmgType) : [w.dmgType],
      );
      if (types.length === 0 || types.some((t) => !t)) return false;
      return types.every(
        (t) => t && (target.defenses?.immune?.includes(t) || (target.defenses?.resist?.[t] ?? 0) > 0),
      );
    }
    case 'lull': {
      // затишье — точное отрицание «накатывают»: никто не дотянется за свой
      // ход; без врагов боя нет, условие молчит
      const es = enemiesOf(self, units);
      return es.length > 0 && !es.some((e) => dist(e.pos, self.pos) <= e.move * 2 + e.range);
    }
    case 'onHighGround':
      return (ground?.heightAt(self.pos) ?? 0) > 0;
    case 'cornered': {
      // свободных смежных клеток ≤ 1: границы поля, камень (если земля
      // известна) и тела обеих сторон
      let free = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const p = { x: self.pos.x + dx, y: self.pos.y + dy };
          if (p.x < 0 || p.y < 0 || p.x >= GRID_W || p.y >= GRID_H) continue;
          if (ground?.blocked(p)) continue;
          if (units.some((u) => u.alive && u.id !== self.id && u.pos.x === p.x && u.pos.y === p.y)) continue;
          free++;
        }
      }
      return free <= 1;
    }
    case 'inFormation': {
      // зеркало spreadThin: каждый из наших со смежным своим; у отряда из
      // одного строя нет — оба условия молчат
      const own = alliesOf(self, units);
      if (own.length < 2) return false;
      return own.every((u) => own.some((o) => o.id !== u.id && dist(o.pos, u.pos) <= 1));
    }
    case 'inZone':
      return !!ground?.zone && posInZone(self.pos, ground.zone);
    case 'enemyInZone': {
      const z = ground?.zone;
      return !!z && enemiesOf(self, units).some((e) => posInZone(e.pos, z));
    }
    case 'timeShort':
      // осталось ≤ TIME_SHORT_LEFT раундов до дедлайна задачи; без таймера молчит
      return ground?.deadline !== undefined && ground.deadline - round <= TIME_SHORT_LEFT;
    case 'prizeHeld':
      // «у наших» — включая меня: условие про судьбу ноши, а не про чужие руки
      return alliesOf(self, units).some((a) => a.tags?.includes('carrier'));
    case 'and':
      return cond.conds.every((c) => evalCondition(c, self, units, round, ground));
    case 'or':
      return cond.conds.some((c) => evalCondition(c, self, units, round, ground));
    case 'not':
      return !evalCondition(cond.cond, self, units, round, ground);
  }
}

/**
 * Разрешение селектора по врагам. Детерминированный тайбрейк по id.
 * `ground` нужен только зонным селекторам (intruder) — без него они падают в
 * «ближайшего», как все контр-селекторы без своей цели.
 */
export function resolveSelector(
  sel: Selector,
  self: CombatUnit,
  units: readonly CombatUnit[],
  ground?: GroundView,
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
    case 'strongest':
      return pick((u) => -u.hp);
    case 'fastest':
      return pick((u) => -u.speed);
    case 'healer': {
      // ближайший вражеский лекарь (актив исцеления); лекарей нет — ближайший
      const healers = enemies.filter((u) => u.active?.heal);
      if (healers.length === 0) return pick((u) => dist(u.pos, self.pos));
      return healers.reduce((best, u) => {
        const s = dist(u.pos, self.pos);
        const bs = dist(best.pos, self.pos);
        return s < bs || (s === bs && u.id < best.id) ? u : best;
      });
    }
    case 'caster': {
      // ближайший вражеский носитель площадного оружия; нет — ближайший
      const casters = enemies.filter((u) => u.aoe);
      if (casters.length === 0) return pick((u) => dist(u.pos, self.pos));
      return casters.reduce((best, u) => {
        const s = dist(u.pos, self.pos);
        const bs = dist(best.pos, self.pos);
        return s < bs || (s === bs && u.id < best.id) ? u : best;
      });
    }
    case 'straggler':
      // отбившийся: враг, до чьего ближайшего своего дальше всего; врагу без
      // своих отбиваться не от кого — он и есть отряд (и единственный кандидат)
      return pick((u) => {
        const own = enemies.filter((o) => o.id !== u.id);
        return own.length === 0 ? -Infinity : -Math.min(...own.map((o) => dist(o.pos, u.pos)));
      });
    case 'tormentor': {
      // обидчик наших: чей удар последним получил кто-то из живых своих
      // (канал lastAttackerId — тот же, что у кары Зари); никого — ближайший
      const guilty = enemies.filter((e) =>
        units.some((a) => a.alive && a.side === self.side && a.lastAttackerId === e.id),
      );
      if (guilty.length === 0) return pick((u) => dist(u.pos, self.pos));
      return guilty.reduce((best, u) => {
        const s = dist(u.pos, self.pos);
        const bs = dist(best.pos, self.pos);
        return s < bs || (s === bs && u.id < best.id) ? u : best;
      });
    }
    case 'heckler': {
      // вражеский крикун: ближайший враг в стойке вызова; крикунов нет —
      // ближайший (контр-слово к задире)
      const hecklers = enemies.filter((u) => u.stance?.taunt === true);
      if (hecklers.length === 0) return pick((u) => dist(u.pos, self.pos));
      return hecklers.reduce((best, u) => {
        const s = dist(u.pos, self.pos);
        const bs = dist(best.pos, self.pos);
        return s < bs || (s === bs && u.id < best.id) ? u : best;
      });
    }
    case 'unengaged': {
      // свободный: враг, которого не держит вплотную никто из наших. Мой
      // собственный контакт не в счёт — иначе цель «освобождалась» бы от
      // меня же каждый ход и селектор гонял бы бойца по кругу
      const mates = units.filter((a) => a.alive && a.side === self.side && a.id !== self.id);
      const free = enemies.filter((e) => !mates.some((a) => dist(a.pos, e.pos) === 1));
      if (free.length === 0) return pick((u) => dist(u.pos, self.pos));
      return free.reduce((best, u) => {
        const s = dist(u.pos, self.pos);
        const bs = dist(best.pos, self.pos);
        return s < bs || (s === bs && u.id < best.id) ? u : best;
      });
    }
    case 'vulnerable': {
      // уязвимый (план damage-types): враг, которого мой урон берёт лучше
      // прочих — по слабостям и сопротивлениям к типу моего оружия. Считаем
      // по лучшему типу, какой у меня есть: у мастера трёх оружий это
      // «чем-нибудь из арсенала», у однооружейного — «моим единственным».
      // Все одинаковы (или типов нет вовсе) — ближайший
      const edge = (u: CombatUnit): number => {
        let best = 0;
        for (const w of self.weapons ?? []) {
          for (const t of [w.dmgType, ...(w.moves ?? []).map((m) => m.dmgType)]) {
            if (!t) continue;
            if (u.defenses?.immune?.includes(t)) continue;
            best = Math.max(best, (u.defenses?.weak?.[t] ?? 0) - (u.defenses?.resist?.[t] ?? 0));
          }
        }
        return best;
      };
      const bestEdge = Math.max(...enemies.map(edge));
      if (bestEdge <= 0) return pick((u) => dist(u.pos, self.pos));
      const soft = enemies.filter((u) => edge(u) === bestEdge);
      return soft.reduce((best, u) => {
        const s = dist(u.pos, self.pos);
        const bs = dist(best.pos, self.pos);
        return s < bs || (s === bs && u.id < best.id) ? u : best;
      });
    }
    case 'armored': {
      // бронированный (план damage-types): враг с самым высоким КБ. Слово
      // двустороннее — им и назначают цель («вали латника, пока строй цел»),
      // и уводят от неё («держаться подальше от бронированного»)
      const acOfUnit = (u: CombatUnit): number => u.defenses?.ac ?? DEFAULT_AC;
      const topAc = Math.max(...enemies.map(acOfUnit));
      const heavy = enemies.filter((u) => acOfUnit(u) === topAc);
      return heavy.reduce((best, u) => {
        const s = dist(u.pos, self.pos);
        const bs = dist(best.pos, self.pos);
        return s < bs || (s === bs && u.id < best.id) ? u : best;
      });
    }
    case 'intruder': {
      // прорывающийся: враг в зоне задачи, а нет таких — ближайший к ней
      // (тайбрейк — кто ближе ко мне); без зоны — просто ближайший
      const z = ground?.zone;
      if (!z) return pick((u) => dist(u.pos, self.pos));
      return pick((u) => zoneDist(u.pos, z) * 1000 + dist(u.pos, self.pos));
    }
    case 'ward': {
      // внутренний селектор врагов сценария: бить подопечного задачи
      const wards = enemies.filter((u) => u.tags.includes('ward'));
      if (wards.length === 0) return pick((u) => dist(u.pos, self.pos));
      return wards.reduce((best, u) => {
        const s = dist(u.pos, self.pos);
        const bs = dist(best.pos, self.pos);
        return s < bs || (s === bs && u.id < best.id) ? u : best;
      });
    }
  }
}

export function resolvePosRef(
  ref: PosRef,
  self: CombatUnit,
  units: readonly CombatUnit[],
): CombatUnit | undefined {
  if (ref.type === 'ally') return resolveAlly(ref.id, self, units);
  return resolveSelector(ref.sel, self, units);
}

/** Отладочное имя ссылки на своего: имя героя или роль. */
const refName = (ref: AllyRef): string => (typeof ref === 'string' ? ref : ref.role);

export function describePreference(p: Preference): string {
  switch (p.kind) {
    case 'attack':
      return `атаковать(${p.target})`;
    case 'protect':
      return `защищать(${refName(p.ally)})`;
    case 'holdPosition':
      return 'держать позицию';
    case 'retreat':
      return 'отступать';
    case 'nearTo':
      return `рядом с(${p.ref.type === 'ally' ? refName(p.ref.id) : p.ref.sel})`;
    case 'behind':
      return `позади(${p.ref.type === 'ally' ? refName(p.ref.id) : p.ref.sel})`;
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
      return `подальше от(${p.ref.type === 'ally' ? refName(p.ref.id) : p.ref.sel})`;
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
    case 'roughEdge':
      return 'стеречь кромку';
    case 'outflank':
      return 'обходить из-за спин';
    case 'shove':
      return 'толкать';
    case 'barrage':
      return 'накрыть скопление';
    case 'spread':
      return 'держать интервал';
    case 'preempt':
      return 'бить на упреждение';
    case 'castRitual':
      return 'замахиваться ритуалом';
    case 'wait':
      return 'ждать';
    case 'rage':
      return 'впасть в ярость';
    case 'heal':
      return 'лечить';
    case 'bless':
      return 'благословить';
    case 'feint':
      return 'финтить';
    case 'douse':
      return 'сбивать пламя';
    case 'finish':
      return 'добивать';
    case 'focusFire':
      return 'бить туда же';
    case 'taunt':
      return 'вызывать на себя';
    case 'lure':
      return `уводить от(${refName(p.ally)})`;
    case 'screen':
      return `заслонить(${refName(p.ally)})`;
    case 'regroup':
      return 'сомкнуть строй';
    case 'swap':
      return `меняться местами(${refName(p.ally)})`;
    case 'mark':
      return 'метить цель';
    case 'fallback':
      return 'отходить за спины';
    case 'clearLine':
      return 'не застить своим';
    case 'pin':
      return 'связывать боем';
    case 'holdLine':
      return 'держать рубеж';
    case 'evacuate':
      return 'уходить к выходу';
    case 'carry':
      return 'нести трофей';
  }
}
