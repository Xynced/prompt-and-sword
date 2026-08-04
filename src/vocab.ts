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
  | 'space.awayFrom';

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
};

/**
 * Стартовый словарь — нарочно нищий: атаковать, ближайший, отступать.
 * Всё остальное добывается в бою (трофеи) и в скриптории.
 */
export const STARTING_VOCAB: ConceptId[] = ['act.attack', 'sel.nearest', 'act.retreat'];

/**
 * Простые слова — база выразительности; в предложениях трофея/скриптория
 * идут первой колонкой (простое против глубокого).
 */
export const CORE_WORDS: ConceptId[] = [
  'cond.hpBelow',
  'cond.outnumbered',
  'cond.allyInDanger',
  'sel.weakest',
  'sel.leader',
  'act.protect',
  'act.holdPosition',
  'space.nearTo',
  'space.behind',
];

/** Глубокие слова — качественно новые стратегии; вторая колонка предложений. */
export const DEEP_WORDS: ConceptId[] = [
  'cond.battleDrags',
  'cond.initiativeEdge',
  'cond.allyFallen',
  'cond.surrounded',
  'sel.mostDangerous',
  'sel.attacker',
  'sel.marked',
  'sel.shooter',
  'sel.farthest',
  'act.bait',
  'act.trade',
  'act.coverRetreat',
  'act.standoff',
  'act.brace',
  'space.flank',
  'space.lineOfFire',
  'space.chokepoint',
  'space.awayFrom',
];

/** Всё, что не в старте: открывается трофеями боёв, в скриптории и у книжника. */
export const UNLOCKABLE: ConceptId[] = [...CORE_WORDS, ...DEEP_WORDS];
