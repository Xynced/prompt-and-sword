import type { PosRef, Rule, Selector } from './ir.js';
import { CONCEPTS, type ConceptId } from './vocab.js';

/**
 * Конструктор принципов: фразы из чипсов словаря → IR без LLM.
 * Консервативен по построению: закрытый концепт — это ошибка компиляции,
 * а не догадка.
 */

export type ConditionDraft =
  | { id: 'always' }
  | { id: 'cond.hpBelow'; who: 'self' | { ally: string }; frac: number }
  | { id: 'cond.outnumbered' }
  | { id: 'cond.allyInDanger'; ally: string }
  | { id: 'cond.battleDrags' }
  | { id: 'cond.initiativeEdge' }
  | { id: 'cond.allyFallen' }
  | { id: 'cond.surrounded' };

export type SelectorDraft =
  | 'sel.nearest'
  | 'sel.weakest'
  | 'sel.leader'
  | 'sel.mostDangerous'
  | 'sel.attacker'
  | 'sel.marked'
  | 'sel.shooter'
  | 'sel.farthest';

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
  | { id: 'act.strikeDesperate' };

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
};

function requiredConcepts(draft: PhraseDraft): ConceptId[] {
  const out: ConceptId[] = [];
  if (draft.condition.id !== 'always') out.push(draft.condition.id);
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

function describeDraft(draft: PhraseDraft, names: Record<string, string> = {}): string {
  const nm = (id: string): string => names[id] ?? id;
  const c = draft.condition;
  const condText =
    c.id === 'always'
      ? ''
      : c.id === 'cond.hpBelow'
        ? c.who === 'self'
          ? `если hp ниже ${Math.round(c.frac * 100)}%: `
          : `если hp ${nm(c.who.ally)} ниже ${Math.round(c.frac * 100)}%: `
        : c.id === 'cond.outnumbered'
          ? 'если врагов больше: '
          : c.id === 'cond.battleDrags'
            ? 'если бой затянулся: '
            : c.id === 'cond.initiativeEdge'
              ? 'если мы быстрее: '
              : c.id === 'cond.allyFallen'
                ? 'если кто-то из наших пал: '
                : c.id === 'cond.surrounded'
                  ? 'если меня окружили: '
                  : `если ${nm(c.ally)} в опасности: `;
  const p = draft.preference;
  const refText = (ref: { ally: string } | { enemy: SelectorDraft }): string =>
    'ally' in ref ? nm(ref.ally) : CONCEPTS[ref.enemy].label;
  const prefText =
    p.id === 'act.strikeOften'
      ? 'бить часто'
      : p.id === 'act.strikeHard'
      ? 'бить наверняка'
      : p.id === 'act.strikeDesperate'
      ? 'бить отчаянно'
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
  return condText + prefText;
}

/** Компиляция фразы в правило IR. Только открытые концепты. */
export function compilePhrase(
  draft: PhraseDraft,
  vocab: readonly ConceptId[],
  names: Record<string, string> = {},
): CompileResult {
  const missing = requiredConcepts(draft).filter((c) => !vocab.includes(c));
  if (missing.length > 0) return { ok: false, missing };

  const c = draft.condition;
  const when: Rule['when'] =
    c.id === 'always'
      ? { kind: 'always' }
      : c.id === 'cond.hpBelow'
        ? { kind: 'hpBelow', who: c.who, frac: c.frac }
        : c.id === 'cond.outnumbered'
          ? { kind: 'outnumbered' }
          : c.id === 'cond.battleDrags'
            ? { kind: 'battleDrags' }
            : c.id === 'cond.initiativeEdge'
              ? { kind: 'initiativeEdge' }
              : c.id === 'cond.allyFallen'
                ? { kind: 'allyFallen' }
                : c.id === 'cond.surrounded'
                  ? { kind: 'surrounded' }
                  : { kind: 'allyInDanger', ally: c.ally };

  const p = draft.preference;
  const toPosRef = (ref: { ally: string } | { enemy: SelectorDraft }): PosRef =>
    'ally' in ref ? { type: 'ally', id: ref.ally } : { type: 'enemy', sel: SELECTOR_MAP[ref.enemy] };

  const then: Rule['then'] =
    p.id === 'act.strikeOften'
      ? { kind: 'strikeOften' }
      : p.id === 'act.strikeHard'
      ? { kind: 'strikeHard' }
      : p.id === 'act.strikeDesperate'
      ? { kind: 'strikeDesperate' }
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

export { describeDraft };
