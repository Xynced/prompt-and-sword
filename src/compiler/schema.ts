import type { ConditionDraft, PhraseDraft, PreferenceDraft, SelectorDraft } from '../constructor.js';
import type { ConceptId } from '../vocab.js';

/**
 * Строгая JSON-схема выхода LLM-компилятора, строится из ОТКРЫТОГО словаря:
 * закрытые концепты в схему не попадают вовсе — невалидное правило и маппинг
 * на закрытый концепт невозможны на уровне схемы. Плюс программная проверка
 * (validateOutput) на случай, если модель схему всё же нарушила.
 */

export interface CompilerOutput {
  phrases: PhraseDraft[];
  /** Заметки о неуверенности: «не знает слова X, понял как Y». */
  uncertainty: string[];
}

const SELECTORS: SelectorDraft[] = [
  'sel.nearest',
  'sel.weakest',
  'sel.leader',
  'sel.mostDangerous',
  'sel.attacker',
  'sel.marked',
  'sel.shooter',
  'sel.farthest',
];

/** Условия и предпочтения без параметров: одна ветка схемы и валидации на всех. */
const PARAMLESS_CONDITIONS = [
  'cond.outnumbered',
  'cond.battleDrags',
  'cond.initiativeEdge',
  'cond.allyFallen',
  'cond.surrounded',
  'cond.underCharge',
] as const;
const PARAMLESS_PREFERENCES = [
  'act.holdPosition',
  'act.retreat',
  'act.bait',
  'act.trade',
  'act.coverRetreat',
  'act.standoff',
  'act.brace',
  'space.flank',
  'space.lineOfFire',
  'space.chokepoint',
  'act.strikeOften',
  'act.strikeHard',
  'act.strikeDesperate',
  'space.highGround',
  'space.behindCover',
  'space.avoidHazard',
  'act.shove',
  'space.spread',
  'act.barrage',
  'act.preempt',
  'act.castRitual',
] as const;

/** Собирает JSON-схему инструмента под открытый словарь и живых союзников. */
export function buildCompileSchema(vocab: readonly ConceptId[], allyIds: readonly string[]): object {
  const has = (c: ConceptId): boolean => vocab.includes(c);
  const selectors = SELECTORS.filter(has);
  const obj = (properties: Record<string, unknown>): object => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });

  const conditions: object[] = [obj({ id: { const: 'always' } })];
  if (has('cond.hpBelow')) {
    const who: object[] = [{ const: 'self' }];
    if (allyIds.length > 0) who.push(obj({ ally: { type: 'string', enum: allyIds } }));
    conditions.push(
      obj({ id: { const: 'cond.hpBelow' }, who: { anyOf: who }, frac: { type: 'number' } }),
    );
  }
  for (const cond of PARAMLESS_CONDITIONS) {
    if (has(cond)) conditions.push(obj({ id: { const: cond } }));
  }
  if (has('cond.allyInDanger') && allyIds.length > 0) {
    conditions.push(obj({ id: { const: 'cond.allyInDanger' }, ally: { type: 'string', enum: allyIds } }));
  }

  const preferences: object[] = [];
  if (has('act.attack') && selectors.length > 0) {
    preferences.push(obj({ id: { const: 'act.attack' }, target: { type: 'string', enum: selectors } }));
  }
  if (has('act.protect') && allyIds.length > 0) {
    preferences.push(obj({ id: { const: 'act.protect' }, ally: { type: 'string', enum: allyIds } }));
  }
  for (const pref of PARAMLESS_PREFERENCES) {
    if (has(pref)) preferences.push(obj({ id: { const: pref } }));
  }
  for (const space of ['space.nearTo', 'space.behind', 'space.awayFrom'] as const) {
    if (!has(space)) continue;
    const refs: object[] = [];
    if (allyIds.length > 0) refs.push(obj({ ally: { type: 'string', enum: allyIds } }));
    if (selectors.length > 0) refs.push(obj({ enemy: { type: 'string', enum: selectors } }));
    if (refs.length > 0) preferences.push(obj({ id: { const: space }, ref: { anyOf: refs } }));
  }

  return obj({
    phrases: {
      type: 'array',
      items: obj({
        condition: { anyOf: conditions },
        preference: { anyOf: preferences },
        weight: { type: 'integer', enum: [1, 2] },
      }),
    },
    uncertainty: { type: 'array', items: { type: 'string' } },
  });
}

// ---- Программная проверка выхода (защита в глубину поверх схемы) ----

export type ValidationResult = { ok: true; output: CompilerOutput } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function validateCondition(
  v: unknown,
  vocab: readonly ConceptId[],
  allyIds: readonly string[],
): ConditionDraft | null {
  if (!isRecord(v)) return null;
  const inAllies = (a: unknown): a is string => typeof a === 'string' && allyIds.includes(a);
  switch (v.id) {
    case 'always':
      return { id: 'always' };
    case 'cond.hpBelow': {
      if (!vocab.includes('cond.hpBelow') || typeof v.frac !== 'number' || !Number.isFinite(v.frac)) return null;
      const frac = Math.min(0.9, Math.max(0.1, v.frac));
      if (v.who === 'self') return { id: 'cond.hpBelow', who: 'self', frac };
      if (isRecord(v.who) && inAllies(v.who.ally)) return { id: 'cond.hpBelow', who: { ally: v.who.ally }, frac };
      return null;
    }
    case 'cond.outnumbered':
      return vocab.includes('cond.outnumbered') ? { id: 'cond.outnumbered' } : null;
    case 'cond.battleDrags':
      return vocab.includes('cond.battleDrags') ? { id: 'cond.battleDrags' } : null;
    case 'cond.initiativeEdge':
      return vocab.includes('cond.initiativeEdge') ? { id: 'cond.initiativeEdge' } : null;
    case 'cond.allyFallen':
      return vocab.includes('cond.allyFallen') ? { id: 'cond.allyFallen' } : null;
    case 'cond.surrounded':
      return vocab.includes('cond.surrounded') ? { id: 'cond.surrounded' } : null;
    case 'cond.underCharge':
      return vocab.includes('cond.underCharge') ? { id: 'cond.underCharge' } : null;
    case 'cond.allyInDanger':
      return vocab.includes('cond.allyInDanger') && inAllies(v.ally)
        ? { id: 'cond.allyInDanger', ally: v.ally }
        : null;
    default:
      return null;
  }
}

function validatePreference(
  v: unknown,
  vocab: readonly ConceptId[],
  allyIds: readonly string[],
): PreferenceDraft | null {
  if (!isRecord(v)) return null;
  const inAllies = (a: unknown): a is string => typeof a === 'string' && allyIds.includes(a);
  const isSelector = (s: unknown): s is SelectorDraft =>
    SELECTORS.includes(s as SelectorDraft) && vocab.includes(s as SelectorDraft);
  switch (v.id) {
    case 'act.attack':
      return vocab.includes('act.attack') && isSelector(v.target)
        ? { id: 'act.attack', target: v.target }
        : null;
    case 'act.protect':
      return vocab.includes('act.protect') && inAllies(v.ally) ? { id: 'act.protect', ally: v.ally } : null;
    case 'act.holdPosition':
      return vocab.includes('act.holdPosition') ? { id: 'act.holdPosition' } : null;
    case 'act.retreat':
      return vocab.includes('act.retreat') ? { id: 'act.retreat' } : null;
    case 'act.bait':
      return vocab.includes('act.bait') ? { id: 'act.bait' } : null;
    case 'act.trade':
      return vocab.includes('act.trade') ? { id: 'act.trade' } : null;
    case 'act.coverRetreat':
      return vocab.includes('act.coverRetreat') ? { id: 'act.coverRetreat' } : null;
    case 'act.standoff':
      return vocab.includes('act.standoff') ? { id: 'act.standoff' } : null;
    case 'space.flank':
      return vocab.includes('space.flank') ? { id: 'space.flank' } : null;
    case 'space.lineOfFire':
      return vocab.includes('space.lineOfFire') ? { id: 'space.lineOfFire' } : null;
    case 'space.chokepoint':
      return vocab.includes('space.chokepoint') ? { id: 'space.chokepoint' } : null;
    case 'act.brace':
      return vocab.includes('act.brace') ? { id: 'act.brace' } : null;
    case 'act.strikeOften':
      return vocab.includes('act.strikeOften') ? { id: 'act.strikeOften' } : null;
    case 'act.strikeHard':
      return vocab.includes('act.strikeHard') ? { id: 'act.strikeHard' } : null;
    case 'act.strikeDesperate':
      return vocab.includes('act.strikeDesperate') ? { id: 'act.strikeDesperate' } : null;
    case 'space.highGround':
      return vocab.includes('space.highGround') ? { id: 'space.highGround' } : null;
    case 'space.behindCover':
      return vocab.includes('space.behindCover') ? { id: 'space.behindCover' } : null;
    case 'space.avoidHazard':
      return vocab.includes('space.avoidHazard') ? { id: 'space.avoidHazard' } : null;
    case 'act.shove':
      return vocab.includes('act.shove') ? { id: 'act.shove' } : null;
    case 'space.spread':
      return vocab.includes('space.spread') ? { id: 'space.spread' } : null;
    case 'act.barrage':
      return vocab.includes('act.barrage') ? { id: 'act.barrage' } : null;
    case 'act.preempt':
      return vocab.includes('act.preempt') ? { id: 'act.preempt' } : null;
    case 'act.castRitual':
      return vocab.includes('act.castRitual') ? { id: 'act.castRitual' } : null;
    case 'space.nearTo':
    case 'space.behind':
    case 'space.awayFrom': {
      if (!vocab.includes(v.id) || !isRecord(v.ref)) return null;
      const ref = inAllies(v.ref.ally)
        ? { ally: v.ref.ally }
        : isSelector(v.ref.enemy)
          ? { enemy: v.ref.enemy }
          : null;
      return ref ? { id: v.id, ref } : null;
    }
    default:
      return null;
  }
}

/**
 * Проверка сырого выхода модели. Любое отклонение от словаря/формы — ошибка
 * компиляции целиком (не догадка и не тихий пропуск).
 */
export function validateOutput(
  raw: unknown,
  vocab: readonly ConceptId[],
  allyIds: readonly string[],
  maxPhrases: number,
): ValidationResult {
  if (!isRecord(raw) || !Array.isArray(raw.phrases) || !Array.isArray(raw.uncertainty)) {
    return { ok: false, error: 'выход компилятора не соответствует форме {phrases, uncertainty}' };
  }
  if (raw.phrases.length === 0) return { ok: false, error: 'компилятор не выдал ни одной фразы' };
  if (raw.phrases.length > maxPhrases) {
    return { ok: false, error: `фраз больше, чем слотов (${raw.phrases.length} > ${maxPhrases})` };
  }
  const phrases: PhraseDraft[] = [];
  for (const [i, ph] of raw.phrases.entries()) {
    if (!isRecord(ph)) return { ok: false, error: `фраза ${i + 1}: не объект` };
    const condition = validateCondition(ph.condition, vocab, allyIds);
    const preference = validatePreference(ph.preference, vocab, allyIds);
    if (!condition || !preference) {
      return { ok: false, error: `фраза ${i + 1}: концепт вне открытого словаря или неверная форма` };
    }
    const weight = ph.weight === 2 ? 2 : 1;
    phrases.push({ condition, preference, weight });
  }
  const uncertainty = raw.uncertainty.filter((u): u is string => typeof u === 'string');
  return { ok: true, output: { phrases, uncertainty } };
}
