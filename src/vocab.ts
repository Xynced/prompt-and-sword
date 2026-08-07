/**
 * Словарь концептов — главная ось прогрессии. Конструктор принципов
 * может использовать только открытые концепты.
 */

export type ConceptId =
  | 'cond.hpBelow'
  | 'cond.outnumbered'
  | 'cond.allyInDanger'
  | 'sel.nearest'
  | 'sel.weakest'
  | 'sel.leader'
  | 'act.attack'
  | 'act.protect'
  | 'act.holdPosition'
  | 'act.retreat'
  | 'space.nearTo'
  | 'space.behind'
  // поздний словарь (фаза 4) — качественно новые стратегии
  | 'cond.battleDrags'
  | 'cond.initiativeEdge'
  | 'sel.mostDangerous'
  | 'sel.attacker'
  | 'sel.marked'
  | 'act.bait'
  | 'act.trade'
  | 'act.coverRetreat'
  | 'act.standoff'
  | 'space.flank'
  | 'space.lineOfFire'
  | 'space.chokepoint'
  // глубокий словарь (фаза 6) — ещё один слой тактики
  | 'cond.allyFallen'
  | 'cond.surrounded'
  | 'sel.shooter'
  | 'sel.farthest'
  | 'act.brace'
  | 'space.awayFrom'
  // манера удара (экономика хода) — не «кого бить», а «чем бить»
  | 'act.strikeOften'
  | 'act.strikeHard'
  | 'act.strikeDesperate'
  // поле и ландшафт (план поля)
  | 'space.highGround'
  | 'space.behindCover'
  | 'space.avoidHazard'
  | 'act.shove'
  // площадные атаки (план АОЕ)
  | 'space.spread'
  | 'act.barrage'
  | 'act.preempt'
  | 'cond.underCharge'
  | 'act.castRitual'
  // классы (план классов) — слова активов
  | 'act.rage'
  | 'act.heal';

export type ConceptCategory = 'condition' | 'selector' | 'action' | 'space';

export interface ConceptMeta {
  id: ConceptId;
  label: string;
  category: ConceptCategory;
}

export const CONCEPTS: Record<ConceptId, ConceptMeta> = {
  'cond.hpBelow': { id: 'cond.hpBelow', label: 'HP ниже X', category: 'condition' },
  'cond.outnumbered': { id: 'cond.outnumbered', label: 'врагов больше, чем нас', category: 'condition' },
  'cond.allyInDanger': { id: 'cond.allyInDanger', label: 'союзник в опасности', category: 'condition' },
  'sel.nearest': { id: 'sel.nearest', label: 'ближайший', category: 'selector' },
  'sel.weakest': { id: 'sel.weakest', label: 'слабейший', category: 'selector' },
  'sel.leader': { id: 'sel.leader', label: 'вожак', category: 'selector' },
  'act.attack': { id: 'act.attack', label: 'атаковать', category: 'action' },
  'act.protect': { id: 'act.protect', label: 'защищать', category: 'action' },
  'act.holdPosition': { id: 'act.holdPosition', label: 'держать позицию', category: 'action' },
  'act.retreat': { id: 'act.retreat', label: 'отступать', category: 'action' },
  'space.nearTo': { id: 'space.nearTo', label: 'рядом с', category: 'space' },
  'space.behind': { id: 'space.behind', label: 'позади', category: 'space' },
  'cond.battleDrags': { id: 'cond.battleDrags', label: 'бой затянулся', category: 'condition' },
  'cond.initiativeEdge': { id: 'cond.initiativeEdge', label: 'мы быстрее', category: 'condition' },
  'sel.mostDangerous': { id: 'sel.mostDangerous', label: 'самый опасный', category: 'selector' },
  'sel.attacker': { id: 'sel.attacker', label: 'кто атаковал меня', category: 'selector' },
  'sel.marked': { id: 'sel.marked', label: 'помеченный', category: 'selector' },
  'act.bait': { id: 'act.bait', label: 'приманка', category: 'action' },
  'act.trade': { id: 'act.trade', label: 'размен', category: 'action' },
  'act.coverRetreat': { id: 'act.coverRetreat', label: 'прикрывать отход', category: 'action' },
  'act.standoff': { id: 'act.standoff', label: 'держать дистанцию', category: 'action' },
  'space.flank': { id: 'space.flank', label: 'заходить во фланг', category: 'space' },
  'space.lineOfFire': { id: 'space.lineOfFire', label: 'вне линии огня', category: 'space' },
  'space.chokepoint': { id: 'space.chokepoint', label: 'узкое место', category: 'space' },
  'cond.allyFallen': { id: 'cond.allyFallen', label: 'кто-то из наших пал', category: 'condition' },
  'cond.surrounded': { id: 'cond.surrounded', label: 'меня окружили', category: 'condition' },
  'sel.shooter': { id: 'sel.shooter', label: 'стрелок', category: 'selector' },
  'sel.farthest': { id: 'sel.farthest', label: 'самый дальний', category: 'selector' },
  'act.brace': { id: 'act.brace', label: 'глухая оборона', category: 'action' },
  'space.awayFrom': { id: 'space.awayFrom', label: 'держаться подальше от', category: 'space' },
  'act.strikeOften': { id: 'act.strikeOften', label: 'бить часто', category: 'action' },
  'act.strikeHard': { id: 'act.strikeHard', label: 'бить наверняка', category: 'action' },
  'act.strikeDesperate': { id: 'act.strikeDesperate', label: 'бить отчаянно', category: 'action' },
  'space.highGround': { id: 'space.highGround', label: 'держать высоту', category: 'space' },
  'space.behindCover': { id: 'space.behindCover', label: 'за укрытием', category: 'space' },
  'space.avoidHazard': { id: 'space.avoidHazard', label: 'обходить опасное', category: 'space' },
  'act.shove': { id: 'act.shove', label: 'толкать', category: 'action' },
  'space.spread': { id: 'space.spread', label: 'держать интервал', category: 'space' },
  'act.barrage': { id: 'act.barrage', label: 'накрыть скопление', category: 'action' },
  'act.preempt': { id: 'act.preempt', label: 'бить на упреждение', category: 'action' },
  'cond.underCharge': { id: 'cond.underCharge', label: 'враги накатывают', category: 'condition' },
  'act.castRitual': { id: 'act.castRitual', label: 'замахиваться ритуалом', category: 'action' },
  'act.rage': { id: 'act.rage', label: 'впасть в ярость', category: 'action' },
  'act.heal': { id: 'act.heal', label: 'лечить', category: 'action' },
};

/**
 * Стартовый словарь — скромный, но уже выразительный: есть условие,
 * два селектора и три действия. Остальное добывается в бою (трофеи)
 * и в скриптории.
 */
export const STARTING_VOCAB: ConceptId[] = [
  'act.attack',
  'sel.nearest',
  'act.retreat',
  'cond.hpBelow',
  'sel.weakest',
  'act.holdPosition',
];

/**
 * Обычные слова (план words): умеренная ровная польза — по аудиту
 * (`pnpm sim words-audit`) средняя дельта winrate в пределах +4пп и нет боя,
 * где слово решает в одиночку. Трофеи обычных боёв; в скриптории — первая
 * колонка. Часть пула по аудиту мертва (манеры удара, приманка, «самый
 * дальний», «узкое место»…) — кандидаты на переработку, см. plans/words.md.
 */
export const COMMON_WORDS: ConceptId[] = [
  'cond.allyInDanger',
  'sel.leader',
  'act.protect',
  'act.trade',
  'act.coverRetreat',
  // контр-слово против артиллерии: наиву даёт +5пп, кайт-мете вредит
  'sel.shooter',
  // техника безопасности и страховка от АОЕ, а не стратегия
  'space.avoidHazard',
  'space.spread',
  'space.highGround',
  // «затянулся → лечить» +17пп на боссе — живое условие для пар
  'cond.battleDrags',
  // переработка words: «я быстрее ближайшего» — окно «ударь до ответа»
  'cond.initiativeEdge',
  'sel.attacker',
  // переработка words: приманка — стойка уклонения (в строе босс +18пп, наиву
  // всё ещё ловушка), фланг умеет манёвр, «подальше» остановлен капом
  'act.bait',
  'space.flank',
  'space.awayFrom',
  // остаточно слабые после переработки: «наверняка» (стойка-пирс без брони в
  // контенте), «отчаянно» (уязвимость в толпе), толчок (мало шипастых арен),
  // «узкое место» (щель пока только на частоколе), укрытие/линия огня
  // (инстинкт делает это сам) — кандидаты следующей итерации плана
  'act.strikeHard',
  'act.strikeDesperate',
  'act.shove',
  'space.lineOfFire',
  'space.chokepoint',
  'space.behindCover',
];

/**
 * Изъяты из обращения (план words, аудит): в наградах и лавках не выпадают,
 * но CONCEPTS/IR их знают — импортированные билды со старым словарём работают.
 * «самый дальний» — вредный приказ при любом использовании (−8…−17пп);
 * «наши пали» — реакция на смерть опаздывает всегда (все пары в минус), у
 * врагов и линз условие живёт (клич сержанта, дрейф мстителя).
 */
export const RETIRED_WORDS: ConceptId[] = ['sel.farthest', 'cond.allyFallen'];

/**
 * Редкие слова (план words): по аудиту у каждого есть бой, где оно решает
 * (пик ≥ +10…40пп), либо это гейт актива/АОЕ — событие для правильной партии.
 * Трофеи элитных боёв; в скриптории — вторая колонка.
 */
export const RARE_WORDS: ConceptId[] = [
  // «врагов больше → глухая оборона» переворачивает урок (+23пп)
  'cond.outnumbered',
  // сильнейшее условие аудита: «окружили → оборона» +8пп всюду, урок +40пп
  'cond.surrounded',
  // гейт-условие ритуала: «накатывают → замах» +28пп на массе
  'cond.underCharge',
  // лучший селектор аудита: +9пп средней, решает дуэль
  'sel.mostDangerous',
  // фокус-огонь: метка перед боем + слово = +7пп, механика целиком
  'sel.marked',
  // строй: «рядом с передовым» урок +22пп, «позади» +20пп — ранние бои решает
  'space.nearTo',
  'space.behind',
  // обоюдоострое: безусловно −23пп, «если окружили/босс» +41пп — слово-решение
  'act.brace',
  // стойка волюма (переработка words): слабый удар крепче — из худших слов
  // аудита (−9пп) в сильнейшие (+6пп, урок +19пп)
  'act.strikeOften',
  // слово онбординга: контр-формулировка урока, выдаётся поражением
  'act.standoff',
  // гейт актива целителя (Ива): +6пп и +9пп живучести
  'act.heal',
  // гейт актива ярости (Ульв): выбор момента — пик на жирных врагах
  'act.rage',
  // гейт площадного каста: масса крыс +11пп у носителей залпа/линии
  'act.barrage',
  // манера ритуала: целить в проекцию движения — крысы +32пп
  'act.preempt',
  // манера каста: тратить ход на замах — крысы +28пп
  'act.castRitual',
];

/** Всё, что не в старте: открывается трофеями боёв, в скриптории и у книжника. */
export const UNLOCKABLE: ConceptId[] = [...COMMON_WORDS, ...RARE_WORDS];
