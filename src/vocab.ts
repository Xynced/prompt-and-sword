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
  // слова рельефа: пользоваться местностью, а не только не страдать от неё
  | 'space.roughEdge'
  | 'space.outflank'
  // площадные атаки (план АОЕ)
  | 'space.spread'
  | 'act.barrage'
  | 'act.preempt'
  | 'cond.underCharge'
  | 'act.castRitual'
  // классы (план классов) — слова активов
  | 'act.rage'
  | 'act.heal'
  // темп: не «где» и не «кого», а «когда»
  | 'act.wait'
  // вторая партия слов (план words) — условия под глубокие чипсы «и»
  | 'cond.hpAbove'
  | 'cond.firstBlood'
  | 'cond.leaderDown'
  | 'cond.wasHit'
  | 'cond.enemyAdjacent'
  | 'cond.allyAdjacent'
  | 'cond.alone'
  | 'cond.weOutnumber'
  | 'cond.enemyShooters'
  | 'cond.enemyCasters'
  | 'cond.enemyWavering'
  | 'cond.lastEnemy'
  | 'cond.allyHurt'
  | 'cond.enemiesClustered'
  | 'sel.strongest'
  | 'sel.fastest'
  | 'sel.healer'
  | 'sel.caster'
  | 'sel.straggler'
  | 'sel.tormentor'
  | 'act.finish'
  | 'act.focusFire'
  // слова-гейты к уже существующим активам (прецедент rage/heal)
  | 'act.bless'
  | 'act.feint'
  // внутрикомандное взаимодействие (план teamwork): внимание врага как ресурс
  | 'act.taunt'
  | 'act.lure'
  // вторая волна teamwork: роли своих вместо имён, условия про своих и
  // действия, у которых смысл есть только рядом с товарищем
  | 'sel.allyWounded'
  | 'sel.allyFrontman'
  | 'sel.allyShooter'
  | 'sel.allyTaunter'
  | 'sel.allyNearest'
  | 'cond.allyTaunting'
  | 'cond.allyEngaged'
  | 'cond.guarded'
  | 'cond.allySurrounded'
  | 'cond.alliesFocusing'
  | 'act.screen'
  | 'act.regroup'
  | 'act.swap'
  // третья волна teamwork: канал метки, позиция относительно своих,
  // разбор толпы по одному и недостающие роли
  | 'act.mark'
  | 'space.fallback'
  | 'space.clearLine'
  | 'act.pin'
  | 'sel.allyCaster'
  | 'sel.allyHealer'
  | 'cond.spreadThin'
  // четвёртая партия слов (план words) — «чтение боя»: условия про землю и
  // момент, селекторы про чужое внимание и контакт
  | 'cond.lull'
  | 'cond.onHighGround'
  | 'cond.cornered'
  | 'cond.inFormation'
  | 'sel.heckler'
  | 'sel.unengaged';

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
  'space.roughEdge': { id: 'space.roughEdge', label: 'стеречь кромку', category: 'space' },
  'space.outflank': { id: 'space.outflank', label: 'обходить из-за спин', category: 'space' },
  'space.spread': { id: 'space.spread', label: 'держать интервал', category: 'space' },
  'act.barrage': { id: 'act.barrage', label: 'накрыть скопление', category: 'action' },
  'act.preempt': { id: 'act.preempt', label: 'бить на упреждение', category: 'action' },
  'cond.underCharge': { id: 'cond.underCharge', label: 'враги накатывают', category: 'condition' },
  'act.castRitual': { id: 'act.castRitual', label: 'замахиваться ритуалом', category: 'action' },
  'act.rage': { id: 'act.rage', label: 'впасть в ярость', category: 'action' },
  'act.heal': { id: 'act.heal', label: 'лечить', category: 'action' },
  'act.wait': { id: 'act.wait', label: 'ждать', category: 'action' },
  'cond.hpAbove': { id: 'cond.hpAbove', label: 'пока цел (HP выше X)', category: 'condition' },
  'cond.firstBlood': { id: 'cond.firstBlood', label: 'кровь пролилась', category: 'condition' },
  'cond.leaderDown': { id: 'cond.leaderDown', label: 'вожак врага пал', category: 'condition' },
  'cond.wasHit': { id: 'cond.wasHit', label: 'меня ударили', category: 'condition' },
  'cond.enemyAdjacent': { id: 'cond.enemyAdjacent', label: 'враг вплотную', category: 'condition' },
  'cond.allyAdjacent': { id: 'cond.allyAdjacent', label: 'союзник рядом', category: 'condition' },
  'cond.alone': { id: 'cond.alone', label: 'я в отрыве', category: 'condition' },
  'cond.weOutnumber': { id: 'cond.weOutnumber', label: 'нас больше', category: 'condition' },
  'cond.enemyShooters': { id: 'cond.enemyShooters', label: 'у врага стрелки', category: 'condition' },
  'cond.enemyCasters': { id: 'cond.enemyCasters', label: 'у врага заклинатель', category: 'condition' },
  'cond.enemyWavering': { id: 'cond.enemyWavering', label: 'враг дрогнул', category: 'condition' },
  'cond.lastEnemy': { id: 'cond.lastEnemy', label: 'враг остался один', category: 'condition' },
  'cond.allyHurt': { id: 'cond.allyHurt', label: 'кто-то из наших ранен', category: 'condition' },
  'cond.enemiesClustered': { id: 'cond.enemiesClustered', label: 'враги скучились', category: 'condition' },
  'sel.strongest': { id: 'sel.strongest', label: 'самый здоровый', category: 'selector' },
  'sel.fastest': { id: 'sel.fastest', label: 'самый быстрый', category: 'selector' },
  'sel.healer': { id: 'sel.healer', label: 'вражеский лекарь', category: 'selector' },
  'sel.caster': { id: 'sel.caster', label: 'вражеский заклинатель', category: 'selector' },
  'sel.straggler': { id: 'sel.straggler', label: 'отбившийся', category: 'selector' },
  'sel.tormentor': { id: 'sel.tormentor', label: 'обидчик наших', category: 'selector' },
  'act.finish': { id: 'act.finish', label: 'добивать', category: 'action' },
  'act.focusFire': { id: 'act.focusFire', label: 'бить туда же', category: 'action' },
  'act.bless': { id: 'act.bless', label: 'благословить', category: 'action' },
  'act.feint': { id: 'act.feint', label: 'финтить', category: 'action' },
  'act.taunt': { id: 'act.taunt', label: 'вызывать на себя', category: 'action' },
  'act.lure': { id: 'act.lure', label: 'уводить от', category: 'action' },
  'sel.allyWounded': { id: 'sel.allyWounded', label: 'наш раненый', category: 'selector' },
  'sel.allyFrontman': { id: 'sel.allyFrontman', label: 'передовой', category: 'selector' },
  'sel.allyShooter': { id: 'sel.allyShooter', label: 'наш стрелок', category: 'selector' },
  'sel.allyTaunter': { id: 'sel.allyTaunter', label: 'наш крикун', category: 'selector' },
  'sel.allyNearest': { id: 'sel.allyNearest', label: 'ближайший свой', category: 'selector' },
  'cond.allyTaunting': { id: 'cond.allyTaunting', label: 'наш держит вызов', category: 'condition' },
  'cond.allyEngaged': { id: 'cond.allyEngaged', label: 'наш в контакте', category: 'condition' },
  'cond.guarded': { id: 'cond.guarded', label: 'меня прикрывают', category: 'condition' },
  'cond.allySurrounded': { id: 'cond.allySurrounded', label: 'нашего обступили', category: 'condition' },
  'cond.alliesFocusing': { id: 'cond.alliesFocusing', label: 'наши навалились', category: 'condition' },
  'act.screen': { id: 'act.screen', label: 'заслонить от стрелков', category: 'action' },
  'act.regroup': { id: 'act.regroup', label: 'сомкнуть строй', category: 'action' },
  'act.swap': { id: 'act.swap', label: 'меняться местами', category: 'action' },
  'act.mark': { id: 'act.mark', label: 'метить цель', category: 'action' },
  'space.fallback': { id: 'space.fallback', label: 'отходить за спины', category: 'space' },
  'space.clearLine': { id: 'space.clearLine', label: 'не застить своим', category: 'space' },
  'act.pin': { id: 'act.pin', label: 'связывать боем', category: 'action' },
  'sel.allyCaster': { id: 'sel.allyCaster', label: 'наш заклинатель', category: 'selector' },
  'sel.allyHealer': { id: 'sel.allyHealer', label: 'наш лекарь', category: 'selector' },
  'cond.spreadThin': { id: 'cond.spreadThin', label: 'мы растянулись', category: 'condition' },
  'cond.lull': { id: 'cond.lull', label: 'затишье', category: 'condition' },
  'cond.onHighGround': { id: 'cond.onHighGround', label: 'я на высоте', category: 'condition' },
  'cond.cornered': { id: 'cond.cornered', label: 'меня прижали', category: 'condition' },
  'cond.inFormation': { id: 'cond.inFormation', label: 'строй сомкнут', category: 'condition' },
  'sel.heckler': { id: 'sel.heckler', label: 'вражеский крикун', category: 'selector' },
  'sel.unengaged': { id: 'sel.unengaged', label: 'свободный враг', category: 'selector' },
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
  // слово темпа: само по себе не решает, но открывает связку «сначала одно,
  // потом другое» с любым условием («затянулся», «в опасности», «накатывают»).
  // Аудитом ещё не мерено — новое слово, место в пуле предварительное
  'act.wait',
  // вторая партия слов: условия под глубокие чипсы «и» — сами по себе дёшевы,
  // ценность в конъюнкциях («в отрыве И у врага стрелки → за укрытие»).
  // Аудитом не мерено — весь блок предварительный, см. журнал плана words
  'cond.hpAbove',
  'cond.firstBlood',
  'cond.wasHit',
  'cond.enemyAdjacent',
  'cond.allyAdjacent',
  'cond.alone',
  'cond.weOutnumber',
  'cond.enemyShooters',
  'cond.enemyCasters',
  'cond.allyHurt',
  // селекторы ровной пользы: зеркала уже открытых или мягкие приоритеты
  'sel.strongest',
  'sel.fastest',
  'sel.straggler',
  'sel.tormentor',
  // фокус-огонь без метки: канал lastAttackerId, награда за навал
  'act.focusFire',
  // план teamwork: «уводить от X» внимания не забирает — работает против «бей
  // ближайшего» и в связке с вызовом. По аудиту (3 сида) слабое и обоюдоострое:
  // само −4пп наиву / +1пп кайту (пик +8пп на огре с кастерами, худший −14пп на
  // тролле), а в паре с вызовом добавляет к нему всего +1пп. Пока техника с
  // узкой нишей; кандидат на переработку в следующей итерации плана words
  'act.lure',
  // вторая волна teamwork: роли своих — ось, а не отдельный приём. Каждая
  // роль снимает привязку принципа к имени героя («прикрывай того, кому
  // хуже» вместо «прикрывай Лию»). По аудиту (3 сида) «наш раненый» даёт
  // +4пп наиву / +5пп кайту при пике +17пп на уроке — ровная польза обычного
  // слова, причём выше именной защиты: подопечный переезжает сам. Остальные
  // роли аудитом не мерены, место предварительное
  'sel.allyWounded',
  'sel.allyFrontman',
  'sel.allyShooter',
  'sel.allyNearest',
  // условия про своих: дёшевы поодиночке, ценность — в связках «и»/«или».
  // «наш держит вызов» мерено в комбо с вызовом (+8пп обеим базам, пик +25пп
  // на уроке) — но числа там несёт связка целиком, само условие немо
  'cond.allyTaunting',
  'cond.allyEngaged',
  'cond.guarded',
  'cond.alliesFocusing',
  // «нашего обступили → бить обидчика»: +1пп наиву, пик всего +6пп на крысах —
  // обычное, несмотря на редкое зеркало «меня окружили»
  'cond.allySurrounded',
  // слово рельефа: «стеречь кромку» — ждать у труднопроходной земли, не ступая
  // на неё (враг вязнет на подходе под выстрелами; на аренах без бурелома
  // молчит — паттерн «держать высоту»). В основном аудите (3 сида) ровно +0:
  // в сиды выборки арены с буреломом не попали вовсе; точечный замер на
  // гати/осыпи нейтрален (те бои база выигрывает и так). Техника с узкой
  // нишей — судьба «узкого места», жива аренами, не скорингом
  'space.roughEdge',
  // заслон от стрелков — контр-приём против артиллерии (соседняя ниша с
  // «стрелок» и «вне линии огня»). По аудиту слабый и обоюдоострый: −1пп
  // наиву, пик +6пп (огр с кастерами), худший −11пп (босс) — работает, но
  // числами почти нем; кандидат на переработку вместе с «уводить от X»
  'act.screen',
  // третья волна teamwork (аудит 3 сида — числа в журнале плана):
  // «отходить за спины» — отступление К партии, а не к краю карты; связка
  // «hp ниже X → за спины» + телохранитель с «прикрывать отход». По аудиту
  // обоюдоострое (−3пп наиву / +1пп кайту, пик +6 урок, худший −8 дуэль):
  // раненый ближник выключается из размена — слово для партий с тылом
  'space.fallback',
  // «не застить своим» — дисциплина ближника при своих стрелках; без
  // стрелков в партии молчит (контр-слово состава, как «заслонить»).
  // По аудиту слабое (−3пп наиву / −0 кайту, пик +6 огр+кастеры): наивным
  // стрелкам коридор не помогает, ниша — стрелковые билды
  'space.clearLine',
  // «связывать боем» — каждому по врагу: премия контакту с несвязанным;
  // противоположный полюс «бить туда же». Штраф толкучке убран по аудиту
  // (воевал с фокусом, −6пп); после калибровки −2пп наиву / −0 кайту,
  // пик +6 сержант, худший −17 тролль — расходиться против таймера смертельно
  'act.pin',
  // недостающие роли: маг с ритуалом и целитель ролью «наш стрелок»
  // невыразимы, а это главные подопечные защитных связок. По аудиту профиль
  // односторонней няньки (заклинатель −3пп, лекарь −1пп, у обоих пики +6…8):
  // роль наследует числа именной защиты, ценность — в переносимости принципа
  'sel.allyCaster',
  'sel.allyHealer',
  // «мы растянулись» — строй разорван: естественный гейт для «сомкнуть
  // строй» и «отходить за спины». По аудиту живое: «растянулись → смыкать»
  // +4пп наиву / +1пп кайту, пик +17 урок — условная версия мягче
  // безусловного строя (у того босс −39), гейт снимает половину вреда
  'cond.spreadThin',
  // четвёртая партия слов — «чтение боя» (аудит 3 сида, полные числа в
  // журнале плана words):
  // «затишье» — окно безопасности: никто из врагов не дотянется за свой ход.
  // Отрицание «накатывают» (НЕ-комбинатора в языке нет — комплемент только
  // отдельным словом). По аудиту живое гейтом перестроений: «затишье →
  // смыкать строй» +5пп наиву / +4пп кайту, пик +14 урок — снимает вред
  // безусловного строя не хуже «растянулись»; гейтом лечения нейтрально
  // (лечение и так по нужде, затишье его лишь оттягивает: крысы −8)
  'cond.lull',
  // «я на высоте» — первое условие, читающее землю: гейт стрелковых стоек.
  // «высота + на высоте → наверняка» +1/+2пп, пик +10 тролль — безусловная
  // пара «высота + наверняка» была вредна, гейт переворачивает знак; на
  // плоской арене молчит, как «стеречь кромку»
  'cond.onHighGround',
  // «строй сомкнут» — зеркало «мы растянулись»: гейт агрессии от строя.
  // По аудиту немо: соло-размен ровно 0 (без слова строя строй не
  // складывается сам), комбо со «смыкать» наследует вред строя на боссе
  // (−36) — гейт агрессии не спасает позиционное слово; кандидат на
  // переработку вместе с mark-комбо
  'cond.inFormation',
  // «свободный враг» — которого не держит вплотную никто из наших (кроме
  // меня): селекторная пара к «связывать боем» и приказ стрелкам снимать
  // того, кого некому встретить. По аудиту обоюдоострое, как вся семья
  // распыления (−4/−4пп, пик +7 расстрел, худший −20 дуэль): воюет с
  // фокус-метой — слово для боёв, где врагов больше, чем наших
  'sel.unengaged',
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
  // вторая партия слов (аудитом не мерено, редкость предварительная):
  // условия-события — переломы боя, естественные триггеры смены плана
  'cond.leaderDown',
  'cond.enemyWavering',
  'cond.lastEnemy',
  // гейт-условие под АОЕ-пары («скучились → накрыть»)
  'cond.enemiesClustered',
  // контр-селекторы: есть бой, где они решают (лекарь латает элиту, шаман жжёт)
  'sel.healer',
  'sel.caster',
  // добивание — приоритет снятия цели с поля, кандидат в слова-события
  'act.finish',
  // слова-гейты активов (прецедент heal/rage): жрец и трюкачка
  'act.bless',
  'act.feint',
  // план teamwork: стойка вызова уводит внимание врага с прочих целей —
  // единственное слово, которое меняет ЧУЖОЙ выбор цели, а не свой.
  // Аудит (3 сида): +6пп наиву, +8пп кайту, пик +25пп на уроке — редкое
  'act.taunt',
  // вторая волна teamwork: роль «наш крикун» — ключ к связкам с вызовом
  // («пока наш крикун держит — заходи во фланг»); аудитом отдельно не мерена,
  // редкость предварительная
  'sel.allyTaunter',
  // «сомкнуть строй» — слово-решение по образцу глухой обороны: у него
  // огромный размах по боям (урок +31пп, босс −39пп при средних +3/+1пп).
  // Строй ломает фланги и держит рипост, но кучную партию выкашивают залпы —
  // ровно тот выбор, ради которого слово и берут
  'act.regroup',
  // «обходить из-за спин» — фланговый обход, держась позади своих: слово-
  // решение по образцу «сомкнуть строй». По аудиту (3 сида) средние скромные
  // (+1пп наиву / −3пп кайту), но размах большой: пик +13пп на «вожак+берсерк»,
  // провал −33пп на боссе — широкий обход оттягивает бойца от штурма холма.
  // Комбо с флангом (−7пп наиву) не автовключение: обход надо брать под бой
  'space.outflank',
  // «меняться местами» — гейт нового вида действия (прецедент ярости и
  // лечения): без слова обмена в бою не бывает вовсе. По аудиту почти нем
  // (+1пп наиву, пик +3пп), но замер щадящий — вариант требует, чтобы
  // передовой стоял вплотную к хрупкому; ниша приёма уже, чем у гейтов
  // активов, и это кандидат на перепроверку следующим аудитом
  'act.swap',
  // «метить цель» (третья волна teamwork) — канал команды: мои удары вешают
  // метку всей стороне, напарники читают её словом «помеченный». Второе
  // после вызова слово, меняющее чужой выбор цели, — только своих, а не
  // врагов; редкое по критерию «механика целиком», как sel.marked. По аудиту
  // числами немо (соло ровно 0, комбо с «помеченным» −1пп, пик +6 тролль):
  // наивная база и так фокусит ближайшего, канал светит в билдах с
  // разнесёнными приказами — кандидат на пересмотр следующим аудитом
  'act.mark',
  // «вражеский крикун» (четвёртая партия) — контр-селектор к задире: снять
  // того, кто уводит наши удары от строя. Редкое по образцу sel.healer /
  // sel.caster — есть узел, где оно решает (задира + пращники слоя 3);
  // в составах аудита крикуна нет, там читается как «ближайший» (+3/+2пп)
  'sel.heckler',
  // «меня прижали» (четвёртая партия) — свободных смежных клеток не
  // осталось: бежать некуда, время отчаянных слов. По аудиту слово-событие:
  // «прижали → глухая оборона» пик +28пп на массе крыс (в среднем +2/+3) —
  // редкое по критерию «есть бой, где решает», как «меня окружили».
  // Искомая ниша «бить отчаянно» пока не подтвердилась (+0, пик +3):
  // прижатому выгоднее закрыться, чем разменяться
  'cond.cornered',
];

/** Всё, что не в старте: открывается трофеями боёв, в скриптории и у книжника. */
export const UNLOCKABLE: ConceptId[] = [...COMMON_WORDS, ...RARE_WORDS];
