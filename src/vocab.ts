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
  | 'act.bait'
  | 'act.trade'
  | 'act.coverRetreat'
  | 'space.flank'
  | 'space.lineOfFire';

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
  'act.bait': { id: 'act.bait', label: 'приманка', category: 'action' },
  'act.trade': { id: 'act.trade', label: 'размен', category: 'action' },
  'act.coverRetreat': { id: 'act.coverRetreat', label: 'прикрывать отход', category: 'action' },
  'space.flank': { id: 'space.flank', label: 'заходить во фланг', category: 'space' },
  'space.lineOfFire': { id: 'space.lineOfFire', label: 'вне линии огня', category: 'space' },
};

/** Стартовый словарь мини-забега: 9 из 12 концептов. */
export const STARTING_VOCAB: ConceptId[] = [
  'cond.hpBelow',
  'cond.outnumbered',
  'sel.nearest',
  'sel.weakest',
  'act.attack',
  'act.protect',
  'act.holdPosition',
  'act.retreat',
  'space.nearTo',
];

/** Открываются в скриптории по ходу забега. */
export const UNLOCKABLE: ConceptId[] = [
  'sel.leader',
  'space.behind',
  'cond.allyInDanger',
  'cond.battleDrags',
  'cond.initiativeEdge',
  'sel.mostDangerous',
  'sel.attacker',
  'act.bait',
  'act.trade',
  'act.coverRetreat',
  'space.flank',
  'space.lineOfFire',
];
