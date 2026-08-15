import type { Condition, PosRef, Rule, Selector } from './ir.js';
import { CONCEPTS, type ConceptId } from './vocab.js';

/**
 * Конструктор принципов: фразы из чипсов словаря → IR без LLM.
 * Консервативен по построению: закрытый концепт — это ошибка компиляции,
 * а не догадка.
 */

export type SimpleConditionDraft =
  | { id: 'always' }
  | { id: 'cond.hpBelow'; who: 'self' | { ally: string }; frac: number }
  | { id: 'cond.hpAbove'; who: 'self' | { ally: string }; frac: number }
  | { id: 'cond.outnumbered' }
  | { id: 'cond.allyInDanger'; ally: string }
  | { id: 'cond.battleDrags' }
  | { id: 'cond.initiativeEdge' }
  | { id: 'cond.allyFallen' }
  | { id: 'cond.surrounded' }
  | { id: 'cond.underCharge' }
  | { id: 'cond.firstBlood' }
  | { id: 'cond.leaderDown' }
  | { id: 'cond.wasHit' }
  | { id: 'cond.enemyAdjacent' }
  | { id: 'cond.allyAdjacent' }
  | { id: 'cond.alone' }
  | { id: 'cond.weOutnumber' }
  | { id: 'cond.enemyShooters' }
  | { id: 'cond.enemyCasters' }
  | { id: 'cond.enemyWavering' }
  | { id: 'cond.lastEnemy' }
  | { id: 'cond.allyHurt' }
  | { id: 'cond.enemiesClustered' };

/**
 * Условие фразы: простое — или один комбинатор (глубокие чипсы): «и» (and,
 * горит при всех) либо «или» (or, горит при любом). Внутри комбинатора только
 * простые условия — комбинаторы не вкладываются; вложенные группы
 * расплющивает compileNested.
 */
export type ConditionDraft =
  | SimpleConditionDraft
  | { id: 'and'; conds: SimpleConditionDraft[] }
  | { id: 'or'; conds: SimpleConditionDraft[] };

export type SelectorDraft =
  | 'sel.nearest'
  | 'sel.weakest'
  | 'sel.leader'
  | 'sel.mostDangerous'
  | 'sel.attacker'
  | 'sel.marked'
  | 'sel.shooter'
  | 'sel.farthest'
  | 'sel.strongest'
  | 'sel.fastest'
  | 'sel.healer'
  | 'sel.caster'
  | 'sel.straggler'
  | 'sel.tormentor';

export type PreferenceDraft =
  | { id: 'act.attack'; target: SelectorDraft }
  | { id: 'act.protect'; ally: string }
  | { id: 'act.holdPosition' }
  | { id: 'act.retreat' }
  | { id: 'space.nearTo'; ref: { ally: string } | { enemy: SelectorDraft } }
  | { id: 'space.behind'; ref: { ally: string } | { enemy: SelectorDraft } }
  | { id: 'act.bait' }
  | { id: 'act.trade' }
  | { id: 'act.coverRetreat' }
  | { id: 'act.standoff' }
  | { id: 'space.flank' }
  | { id: 'space.lineOfFire' }
  | { id: 'space.chokepoint' }
  | { id: 'act.brace' }
  | { id: 'space.awayFrom'; ref: { ally: string } | { enemy: SelectorDraft } }
  | { id: 'act.strikeOften' }
  | { id: 'act.strikeHard' }
  | { id: 'act.strikeDesperate' }
  | { id: 'space.highGround' }
  | { id: 'space.behindCover' }
  | { id: 'space.avoidHazard' }
  | { id: 'act.shove' }
  | { id: 'space.spread' }
  | { id: 'act.barrage' }
  | { id: 'act.preempt' }
  | { id: 'act.castRitual' }
  | { id: 'act.rage' }
  | { id: 'act.heal' }
  | { id: 'act.wait' }
  | { id: 'act.finish' }
  | { id: 'act.focusFire' }
  | { id: 'act.bless' }
  | { id: 'act.feint' }
  | { id: 'act.taunt' }
  | { id: 'act.lure'; ally: string };

export interface PhraseDraft {
  condition: ConditionDraft;
  preference: PreferenceDraft;
  /** Насколько это важно: 1 = обычно, 2 = очень. */
  weight?: number;
}

export type CompileResult =
  | { ok: true; rule: Rule }
  | { ok: false; missing: ConceptId[] };

const SELECTOR_MAP: Record<SelectorDraft, Selector> = {
  'sel.nearest': 'nearest',
  'sel.weakest': 'weakest',
  'sel.leader': 'leader',
  'sel.mostDangerous': 'mostDangerous',
  'sel.attacker': 'attacker',
  'sel.marked': 'marked',
  'sel.shooter': 'shooter',
  'sel.farthest': 'farthest',
  'sel.strongest': 'strongest',
  'sel.fastest': 'fastest',
  'sel.healer': 'healer',
  'sel.caster': 'caster',
  'sel.straggler': 'straggler',
  'sel.tormentor': 'tormentor',
};

/** Концепты условия; «и»/«или» — грамматика, а не слово: платят только вложенные условия. */
function condConcepts(c: ConditionDraft): ConceptId[] {
  if (c.id === 'always') return [];
  if (c.id === 'and' || c.id === 'or') return c.conds.flatMap(condConcepts);
  return [c.id];
}

function requiredConcepts(draft: PhraseDraft): ConceptId[] {
  const out: ConceptId[] = [...condConcepts(draft.condition)];
  const p = draft.preference;
  out.push(p.id);
  if (p.id === 'act.attack') out.push(p.target);
  if (
    (p.id === 'space.nearTo' || p.id === 'space.behind' || p.id === 'space.awayFrom') &&
    'enemy' in p.ref
  ) {
    out.push(p.ref.enemy);
  }
  return out;
}

/** Текст условия для source; у «и» — сцепка «если А: если Б: » (вложенность). */
function condText(c: ConditionDraft, nm: (id: string) => string): string {
  switch (c.id) {
    case 'always':
      return '';
    case 'cond.hpBelow':
      return c.who === 'self'
        ? `если hp ниже ${Math.round(c.frac * 100)}%: `
        : `если hp ${nm(c.who.ally)} ниже ${Math.round(c.frac * 100)}%: `;
    case 'cond.hpAbove':
      return c.who === 'self'
        ? `пока hp выше ${Math.round(c.frac * 100)}%: `
        : `пока hp ${nm(c.who.ally)} выше ${Math.round(c.frac * 100)}%: `;
    case 'cond.outnumbered':
      return 'если врагов больше: ';
    case 'cond.battleDrags':
      return 'если бой затянулся: ';
    case 'cond.initiativeEdge':
      return 'если мы быстрее: ';
    case 'cond.allyFallen':
      return 'если кто-то из наших пал: ';
    case 'cond.surrounded':
      return 'если меня окружили: ';
    case 'cond.underCharge':
      return 'если враги накатывают: ';
    case 'cond.allyInDanger':
      return `если ${nm(c.ally)} в опасности: `;
    case 'cond.firstBlood':
      return 'если кровь пролилась: ';
    case 'cond.leaderDown':
      return 'если вожак врага пал: ';
    case 'cond.wasHit':
      return 'если меня ударили: ';
    case 'cond.enemyAdjacent':
      return 'если враг вплотную: ';
    case 'cond.allyAdjacent':
      return 'если союзник рядом: ';
    case 'cond.alone':
      return 'если я в отрыве: ';
    case 'cond.weOutnumber':
      return 'если нас больше: ';
    case 'cond.enemyShooters':
      return 'если у врага стрелки: ';
    case 'cond.enemyCasters':
      return 'если у врага заклинатель: ';
    case 'cond.enemyWavering':
      return 'если враг дрогнул: ';
    case 'cond.lastEnemy':
      return 'если враг остался один: ';
    case 'cond.allyHurt':
      return 'если кто-то из наших ранен: ';
    case 'cond.enemiesClustered':
      return 'если враги скучились: ';
    case 'and':
      return c.conds.map((s) => condText(s, nm)).join('');
    case 'or':
      // «если А или если Б: » — тексты частей без завершающего «: »
      return `${c.conds.map((s) => condText(s, nm).replace(/: $/, '')).join(' или ')}: `;
  }
}

function describeDraft(draft: PhraseDraft, names: Record<string, string> = {}): string {
  const nm = (id: string): string => names[id] ?? id;
  const p = draft.preference;
  const refText = (ref: { ally: string } | { enemy: SelectorDraft }): string =>
    'ally' in ref ? nm(ref.ally) : CONCEPTS[ref.enemy].label;
  const prefText =
    p.id === 'act.taunt'
      ? 'вызывать на себя'
      : p.id === 'act.lure'
      ? `уводить врагов от ${nm(p.ally)}`
      : p.id === 'act.finish'
      ? 'добивать'
      : p.id === 'act.focusFire'
      ? 'бить туда же'
      : p.id === 'act.bless'
      ? 'благословлять'
      : p.id === 'act.feint'
      ? 'финтить'
      : p.id === 'act.strikeOften'
      ? 'бить часто'
      : p.id === 'act.strikeHard'
      ? 'бить наверняка'
      : p.id === 'act.strikeDesperate'
      ? 'бить отчаянно'
      : p.id === 'space.highGround'
      ? 'держать высоту'
      : p.id === 'space.behindCover'
      ? 'держаться за укрытием'
      : p.id === 'space.avoidHazard'
      ? 'обходить опасное'
      : p.id === 'act.shove'
      ? 'толкать'
      : p.id === 'space.spread'
      ? 'держать интервал'
      : p.id === 'act.barrage'
      ? 'накрыть скопление'
      : p.id === 'act.preempt'
      ? 'бить на упреждение'
      : p.id === 'act.castRitual'
      ? 'замахиваться ритуалом'
      : p.id === 'act.rage'
      ? 'впасть в ярость'
      : p.id === 'act.heal'
      ? 'лечить раненых'
      : p.id === 'act.wait'
      ? 'выжидать'
      : p.id === 'act.attack'
      ? `атаковать: ${CONCEPTS[p.target].label}`
      : p.id === 'act.protect'
        ? `защищать ${nm(p.ally)}`
        : p.id === 'act.holdPosition'
          ? 'держать позицию'
          : p.id === 'act.retreat'
            ? 'отступать'
            : p.id === 'act.bait'
              ? 'изображать приманку'
              : p.id === 'act.trade'
                ? 'идти на размен'
                : p.id === 'act.coverRetreat'
                  ? 'прикрывать отход'
                  : p.id === 'act.standoff'
                    ? 'держать дистанцию'
                    : p.id === 'space.flank'
                    ? 'заходить во фланг'
                    : p.id === 'space.lineOfFire'
                      ? 'держаться вне линии огня'
                      : p.id === 'space.chokepoint'
                        ? 'вставать в узком месте'
                        : p.id === 'act.brace'
                        ? 'вставать в глухую оборону'
                        : p.id === 'space.awayFrom'
                          ? `держаться подальше от ${refText(p.ref)}`
                          : p.id === 'space.nearTo'
                            ? `держаться рядом с ${refText(p.ref)}`
                            : `держаться позади ${refText(p.ref)}`;
  return condText(draft.condition, nm) + prefText;
}

/** Условие черновика → условие IR; «и» собирается рекурсивно. */
function compileCondition(c: ConditionDraft): Condition {
  switch (c.id) {
    case 'always':
      return { kind: 'always' };
    case 'cond.hpBelow':
      return { kind: 'hpBelow', who: c.who, frac: c.frac };
    case 'cond.hpAbove':
      return { kind: 'hpAbove', who: c.who, frac: c.frac };
    case 'cond.outnumbered':
      return { kind: 'outnumbered' };
    case 'cond.battleDrags':
      return { kind: 'battleDrags' };
    case 'cond.initiativeEdge':
      return { kind: 'initiativeEdge' };
    case 'cond.allyFallen':
      return { kind: 'allyFallen' };
    case 'cond.surrounded':
      return { kind: 'surrounded' };
    case 'cond.underCharge':
      return { kind: 'underCharge' };
    case 'cond.allyInDanger':
      return { kind: 'allyInDanger', ally: c.ally };
    case 'cond.firstBlood':
      return { kind: 'firstBlood' };
    case 'cond.leaderDown':
      return { kind: 'leaderDown' };
    case 'cond.wasHit':
      return { kind: 'wasHit' };
    case 'cond.enemyAdjacent':
      return { kind: 'enemyAdjacent' };
    case 'cond.allyAdjacent':
      return { kind: 'allyAdjacent' };
    case 'cond.alone':
      return { kind: 'alone' };
    case 'cond.weOutnumber':
      return { kind: 'weOutnumber' };
    case 'cond.enemyShooters':
      return { kind: 'enemyShooters' };
    case 'cond.enemyCasters':
      return { kind: 'enemyCasters' };
    case 'cond.enemyWavering':
      return { kind: 'enemyWavering' };
    case 'cond.lastEnemy':
      return { kind: 'lastEnemy' };
    case 'cond.allyHurt':
      return { kind: 'allyHurt' };
    case 'cond.enemiesClustered':
      return { kind: 'enemiesClustered' };
    case 'and':
      return { kind: 'and', conds: c.conds.map((s) => compileCondition(s)) };
    case 'or':
      return { kind: 'or', conds: c.conds.map((s) => compileCondition(s)) };
  }
}

/** Компиляция фразы в правило IR. Только открытые концепты. */
export function compilePhrase(
  draft: PhraseDraft,
  vocab: readonly ConceptId[],
  names: Record<string, string> = {},
): CompileResult {
  const missing = requiredConcepts(draft).filter((c) => !vocab.includes(c));
  if (missing.length > 0) return { ok: false, missing };

  const when: Rule['when'] = compileCondition(draft.condition);

  const p = draft.preference;
  const toPosRef = (ref: { ally: string } | { enemy: SelectorDraft }): PosRef =>
    'ally' in ref ? { type: 'ally', id: ref.ally } : { type: 'enemy', sel: SELECTOR_MAP[ref.enemy] };

  const then: Rule['then'] =
    p.id === 'act.taunt'
      ? { kind: 'taunt' }
      : p.id === 'act.lure'
      ? { kind: 'lure', ally: p.ally }
      : p.id === 'act.finish'
      ? { kind: 'finish' }
      : p.id === 'act.focusFire'
      ? { kind: 'focusFire' }
      : p.id === 'act.bless'
      ? { kind: 'bless' }
      : p.id === 'act.feint'
      ? { kind: 'feint' }
      : p.id === 'act.strikeOften'
      ? { kind: 'strikeOften' }
      : p.id === 'act.strikeHard'
      ? { kind: 'strikeHard' }
      : p.id === 'act.strikeDesperate'
      ? { kind: 'strikeDesperate' }
      : p.id === 'space.highGround'
      ? { kind: 'highGround' }
      : p.id === 'space.behindCover'
      ? { kind: 'behindCover' }
      : p.id === 'space.avoidHazard'
      ? { kind: 'avoidHazard' }
      : p.id === 'act.shove'
      ? { kind: 'shove' }
      : p.id === 'space.spread'
      ? { kind: 'spread' }
      : p.id === 'act.barrage'
      ? { kind: 'barrage' }
      : p.id === 'act.preempt'
      ? { kind: 'preempt' }
      : p.id === 'act.castRitual'
      ? { kind: 'castRitual' }
      : p.id === 'act.rage'
      ? { kind: 'rage' }
      : p.id === 'act.heal'
      ? { kind: 'heal' }
      : p.id === 'act.wait'
      ? { kind: 'wait' }
      : p.id === 'act.attack'
      ? { kind: 'attack', target: SELECTOR_MAP[p.target] }
      : p.id === 'act.protect'
        ? { kind: 'protect', ally: p.ally }
        : p.id === 'act.holdPosition'
          ? { kind: 'holdPosition' }
          : p.id === 'act.retreat'
            ? { kind: 'retreat' }
            : p.id === 'act.bait'
              ? { kind: 'bait' }
              : p.id === 'act.trade'
                ? { kind: 'trade' }
                : p.id === 'act.coverRetreat'
                  ? { kind: 'coverRetreat' }
                  : p.id === 'act.standoff'
                    ? { kind: 'standoff' }
                    : p.id === 'space.flank'
                    ? { kind: 'flank' }
                    : p.id === 'space.lineOfFire'
                      ? { kind: 'avoidLineOfFire' }
                      : p.id === 'space.chokepoint'
                        ? { kind: 'chokepoint' }
                        : p.id === 'act.brace'
                        ? { kind: 'brace' }
                        : p.id === 'space.awayFrom'
                          ? { kind: 'awayFrom', ref: toPosRef(p.ref) }
                          : p.id === 'space.nearTo'
                            ? { kind: 'nearTo', ref: toPosRef(p.ref) }
                            : { kind: 'behind', ref: toPosRef(p.ref) };

  return {
    ok: true,
    rule: {
      when,
      then,
      weight: (draft.weight ?? 1) * 1.5,
      scope: 'self',
      source: describeDraft(draft, names),
    },
  };
}

// ---- Глубокие чипсы: вложенные группы условий ----

/**
 * Группа «если А { если Б → X; если В → Y }»: ветки наследуют условие
 * обёртки. Компилируется в плоские правила с конъюнкцией — if (a) { if (b)
 * { doA }; if (c) { doB } } даёт правила a∧b→doA и a∧c→doB.
 */
export interface PhraseGroupDraft {
  condition: ConditionDraft;
  branches: PhraseNodeDraft[];
}

export type PhraseNodeDraft = PhraseDraft | PhraseGroupDraft;

export type CompileNestedResult = { ok: true; rules: Rule[] } | { ok: false; missing: ConceptId[] };

const isGroup = (n: PhraseNodeDraft): n is PhraseGroupDraft => 'branches' in n;

/** Свести дерево к листам: цепочка условий обёрток (целиком) + сам лист. */
function flattenNode(
  node: PhraseNodeDraft,
  path: readonly ConditionDraft[],
): { conds: ConditionDraft[]; leaf: PhraseDraft }[] {
  const conds = [...path, node.condition];
  if (isGroup(node)) return node.branches.flatMap((b) => flattenNode(b, conds));
  return [{ conds, leaf: node }];
}

/**
 * Конъюнкция звеньев пути: and-черновики вливаются в общий список, «или»
 * остаётся вложенным условием — «если (А или Б): если В» → and[or[А,Б], В].
 */
function combineConds(real: readonly ConditionDraft[]): Condition {
  if (real.length === 0) return { kind: 'always' };
  if (real.length === 1) return compileCondition(real[0]!);
  return {
    kind: 'and',
    conds: real.flatMap((u) =>
      u.id === 'and' ? u.conds.map((s) => compileCondition(s)) : [compileCondition(u)],
    ),
  };
}

/**
 * Компиляция вложенного узла: группа → несколько правил, лист — одно.
 * Ошибка собирает закрытые концепты по всему дереву разом.
 */
export function compileNested(
  node: PhraseNodeDraft,
  vocab: readonly ConceptId[],
  names: Record<string, string> = {},
): CompileNestedResult {
  const nm = (id: string): string => names[id] ?? id;
  const missing: ConceptId[] = [];
  const rules: Rule[] = [];
  for (const { conds, leaf } of flattenNode(node, [])) {
    const real = conds.filter((c) => c.id !== 'always');
    const condMissing = real.flatMap(condConcepts).filter((c) => !vocab.includes(c));
    // лист компилируется с пустым условием: предпочтение, вес и текст действия
    // берём у compilePhrase, условие пути приклеиваем сами
    const base = compilePhrase({ ...leaf, condition: { id: 'always' } }, vocab, names);
    for (const m of [...condMissing, ...(base.ok ? [] : base.missing)]) {
      if (!missing.includes(m)) missing.push(m);
    }
    if (condMissing.length > 0 || !base.ok) continue;
    rules.push({
      ...base.rule,
      when: combineConds(real),
      source: real.map((c) => condText(c, nm)).join('') + base.rule.source,
    });
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, rules };
}

export { describeDraft };
