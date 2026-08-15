import type { CombatUnit, LensId } from './types.js';
import { dist } from './grid.js';

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
 * Вложенность (глубокие чипсы): and — конъюнкция условий («если А: если Б —
 *   делай X» → одно правило с when = and[А, Б]), or — дизъюнкция («если А
 *   или Б»). «Или» одним правилом — не то же, что две фразы: при обоих
 *   истинных условиях or-правило горит один раз, две фразы — удвоенным весом.
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
  | 'tormentor';

/** С какого раунда бой считается затянувшимся. */
export const BATTLE_DRAGS_ROUND = 5;

export type Condition =
  | { kind: 'always' }
  | { kind: 'hpBelow'; who: 'self' | { ally: string }; frac: number }
  /** Зеркало hpBelow — «пока цел»: для контекстных прочтений линз (план линз); слова игрока пока нет. */
  | { kind: 'hpAbove'; who: 'self' | { ally: string }; frac: number }
  | { kind: 'outnumbered' }
  | { kind: 'allyInDanger'; ally: string }
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
  /**
   * Конъюнкция — глубокие чипсы: «если А: если Б — …». Из черновиков внутри
   * только простые условия и «или»; вложенные группы конструктор расплющивает сам.
   */
  | { kind: 'and'; conds: Condition[] }
  /** Дизъюнкция — «если А или Б»: горит, когда истинно хотя бы одно. */
  | { kind: 'or'; conds: Condition[] };

/** Ссылка на позицию-якорь для пространственных предпочтений. */
export type PosRef = { type: 'ally'; id: string } | { type: 'enemy'; sel: Selector };

export type Preference =
  | { kind: 'attack'; target: Selector }
  | { kind: 'protect'; ally: string }
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
  | { kind: 'lure'; ally: string };

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

export function evalCondition(
  cond: Condition,
  self: CombatUnit,
  units: readonly CombatUnit[],
  round = 1,
): boolean {
  switch (cond.kind) {
    case 'always':
      return true;
    case 'hpBelow': {
      const u = cond.who === 'self' ? self : byId(units, cond.who.ally);
      return !!u && u.alive && u.hp < cond.frac * u.maxHp;
    }
    case 'hpAbove': {
      // точный комплемент hpBelow: при равном frac активна ровно одна половина расщепления
      const u = cond.who === 'self' ? self : byId(units, cond.who.ally);
      return !!u && u.alive && u.hp >= cond.frac * u.maxHp;
    }
    case 'outnumbered':
      return enemiesOf(self, units).length > alliesOf(self, units).length;
    case 'allyInDanger': {
      const ally = byId(units, cond.ally);
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
    case 'and':
      return cond.conds.every((c) => evalCondition(c, self, units, round));
    case 'or':
      return cond.conds.some((c) => evalCondition(c, self, units, round));
  }
}

/** Разрешение селектора по врагам. Детерминированный тайбрейк по id. */
export function resolveSelector(
  sel: Selector,
  self: CombatUnit,
  units: readonly CombatUnit[],
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
  }
}

export function resolvePosRef(
  ref: PosRef,
  self: CombatUnit,
  units: readonly CombatUnit[],
): CombatUnit | undefined {
  if (ref.type === 'ally') {
    const u = byId(units, ref.id);
    return u && u.alive ? u : undefined;
  }
  return resolveSelector(ref.sel, self, units);
}

export function describePreference(p: Preference): string {
  switch (p.kind) {
    case 'attack':
      return `атаковать(${p.target})`;
    case 'protect':
      return `защищать(${p.ally})`;
    case 'holdPosition':
      return 'держать позицию';
    case 'retreat':
      return 'отступать';
    case 'nearTo':
      return `рядом с(${p.ref.type === 'ally' ? p.ref.id : p.ref.sel})`;
    case 'behind':
      return `позади(${p.ref.type === 'ally' ? p.ref.id : p.ref.sel})`;
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
      return `подальше от(${p.ref.type === 'ally' ? p.ref.id : p.ref.sel})`;
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
    case 'finish':
      return 'добивать';
    case 'focusFire':
      return 'бить туда же';
    case 'taunt':
      return 'вызывать на себя';
    case 'lure':
      return `уводить от(${p.ally})`;
  }
}
