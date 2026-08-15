import {
  ROLE_CONCEPT,
  type ConditionDraft,
  type PhraseDraft,
  type PreferenceDraft,
  type SelectorDraft,
  type SimpleConditionDraft,
} from '../constructor.js';
import type { AllyRef, AllyRole } from '../ir.js';
import type { ConceptId } from '../vocab.js';

/** Роль своего ↔ слово, которое её открывает (план teamwork, вторая волна). */
const ROLE_WORDS = Object.entries(ROLE_CONCEPT) as [AllyRole, ConceptId][];

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
  'sel.strongest',
  'sel.fastest',
  'sel.healer',
  'sel.caster',
  'sel.straggler',
  'sel.tormentor',
  'sel.heckler',
  'sel.unengaged',
  'sel.intruder',
];

/** Условия и предпочтения без параметров: одна ветка схемы и валидации на всех. */
const PARAMLESS_CONDITIONS = [
  'cond.outnumbered',
  'cond.battleDrags',
  'cond.initiativeEdge',
  'cond.allyFallen',
  'cond.surrounded',
  'cond.underCharge',
  'cond.firstBlood',
  'cond.leaderDown',
  'cond.wasHit',
  'cond.enemyAdjacent',
  'cond.allyAdjacent',
  'cond.alone',
  'cond.weOutnumber',
  'cond.enemyShooters',
  'cond.enemyCasters',
  'cond.enemyWavering',
  'cond.lastEnemy',
  'cond.allyHurt',
  'cond.enemiesClustered',
  'cond.allyTaunting',
  'cond.allyEngaged',
  'cond.guarded',
  'cond.allySurrounded',
  'cond.alliesFocusing',
  'cond.spreadThin',
  'cond.lull',
  'cond.onHighGround',
  'cond.cornered',
  'cond.inFormation',
  'cond.inZone',
  'cond.enemyInZone',
  'cond.timeShort',
  'cond.prizeHeld',
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
  'space.roughEdge',
  'space.outflank',
  'act.shove',
  'space.spread',
  'act.barrage',
  'act.preempt',
  'act.castRitual',
  'act.rage',
  'act.heal',
  'act.wait',
  'act.finish',
  'act.focusFire',
  'act.bless',
  'act.feint',
  'act.taunt',
  'act.regroup',
  'act.mark',
  'space.fallback',
  'space.clearLine',
  'act.pin',
  'space.holdLine',
  'act.evacuate',
  'act.carry',
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

  // простые условия — отдельно: из них же собирается ветка конъюнкции «и»
  // ссылка на своего: имя героя или открытая роль — одна форма на все слова,
  // где раньше ждали «<id союзника>»
  const roles = ROLE_WORDS.filter(([, word]) => has(word)).map(([role]) => role);
  const allyRef: object[] = [];
  if (allyIds.length > 0) allyRef.push({ type: 'string', enum: allyIds });
  if (roles.length > 0) allyRef.push(obj({ role: { type: 'string', enum: roles } }));
  const hasAlly = allyRef.length > 0;
  const allySchema = { anyOf: allyRef };

  const simple: object[] = [];
  const who: object[] = [{ const: 'self' }];
  if (hasAlly) who.push(obj({ ally: allySchema }));
  for (const cond of ['cond.hpBelow', 'cond.hpAbove'] as const) {
    if (has(cond)) simple.push(obj({ id: { const: cond }, who: { anyOf: who }, frac: { type: 'number' } }));
  }
  for (const cond of PARAMLESS_CONDITIONS) {
    if (has(cond)) simple.push(obj({ id: { const: cond } }));
  }
  if (has('cond.allyInDanger') && hasAlly) {
    simple.push(obj({ id: { const: 'cond.allyInDanger' }, ally: allySchema }));
  }
  const conditions: object[] = [obj({ id: { const: 'always' } }), ...simple];
  // глубокие чипсы: «и»/«или» — грамматика, не слова; доступны при любом открытом условии
  if (simple.length > 0) {
    for (const op of ['and', 'or'] as const) {
      conditions.push(
        obj({
          id: { const: op },
          conds: { type: 'array', items: { anyOf: simple }, minItems: 2, maxItems: 3 },
        }),
      );
    }
  }

  const preferences: object[] = [];
  if (has('act.attack') && selectors.length > 0) {
    preferences.push(obj({ id: { const: 'act.attack' }, target: { type: 'string', enum: selectors } }));
  }
  // слова про напарника: без союзников (и без открытых ролей) им некого
  // назвать, и в схему они не попадают вовсе
  for (const pref of ['act.protect', 'act.lure', 'act.screen', 'act.swap'] as const) {
    if (has(pref) && hasAlly) preferences.push(obj({ id: { const: pref }, ally: allySchema }));
  }
  for (const pref of PARAMLESS_PREFERENCES) {
    if (has(pref)) preferences.push(obj({ id: { const: pref } }));
  }
  for (const space of ['space.nearTo', 'space.behind', 'space.awayFrom'] as const) {
    if (!has(space)) continue;
    const refs: object[] = [];
    if (hasAlly) refs.push(obj({ ally: allySchema }));
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

/**
 * Ссылка на своего из сырого выхода модели: имя живого союзника (как было)
 * или роль, слово которой открыто. Всё прочее — null, то есть ошибка
 * компиляции фразы целиком.
 */
function toAllyRef(
  v: unknown,
  vocab: readonly ConceptId[],
  allyIds: readonly string[],
): AllyRef | null {
  if (typeof v === 'string') return allyIds.includes(v) ? v : null;
  if (!isRecord(v) || typeof v.role !== 'string') return null;
  const known = ROLE_WORDS.find(([role, word]) => role === v.role && vocab.includes(word));
  return known ? { role: known[0] } : null;
}

function validateCondition(
  v: unknown,
  vocab: readonly ConceptId[],
  allyIds: readonly string[],
): ConditionDraft | null {
  if (!isRecord(v)) return null;
  const inAllies = (a: unknown): AllyRef | null => toAllyRef(a, vocab, allyIds);
  if (
    typeof v.id === 'string' &&
    (PARAMLESS_CONDITIONS as readonly string[]).includes(v.id)
  ) {
    const id = v.id as (typeof PARAMLESS_CONDITIONS)[number];
    // {id: union} не сужается в союз одиночных форм — каждая форма и есть {id}
    return vocab.includes(id) ? ({ id } as SimpleConditionDraft) : null;
  }
  switch (v.id) {
    case 'always':
      return { id: 'always' };
    case 'cond.hpBelow':
    case 'cond.hpAbove': {
      if (!vocab.includes(v.id) || typeof v.frac !== 'number' || !Number.isFinite(v.frac)) return null;
      const frac = Math.min(0.9, Math.max(0.1, v.frac));
      if (v.who === 'self') return { id: v.id, who: 'self', frac };
      const who = isRecord(v.who) ? inAllies(v.who.ally) : null;
      return who !== null ? { id: v.id, who: { ally: who }, frac } : null;
    }
    case 'cond.allyInDanger': {
      const ally = inAllies(v.ally);
      return vocab.includes('cond.allyInDanger') && ally !== null
        ? { id: 'cond.allyInDanger', ally }
        : null;
    }
    case 'and':
    case 'or': {
      // комбинатор: 2–3 ПРОСТЫХ условия (без always и вложенных комбинаторов)
      if (!Array.isArray(v.conds) || v.conds.length < 2 || v.conds.length > 3) return null;
      const conds: SimpleConditionDraft[] = [];
      for (const s of v.conds) {
        const c = validateCondition(s, vocab, allyIds);
        if (!c || c.id === 'and' || c.id === 'or' || c.id === 'always') return null;
        conds.push(c);
      }
      return { id: v.id, conds };
    }
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
  const inAllies = (a: unknown): AllyRef | null => toAllyRef(a, vocab, allyIds);
  const isSelector = (s: unknown): s is SelectorDraft =>
    SELECTORS.includes(s as SelectorDraft) && vocab.includes(s as SelectorDraft);
  if (
    typeof v.id === 'string' &&
    (PARAMLESS_PREFERENCES as readonly string[]).includes(v.id)
  ) {
    const id = v.id as (typeof PARAMLESS_PREFERENCES)[number];
    // {id: union} не сужается в союз одиночных форм — каждая форма и есть {id}
    return vocab.includes(id) ? ({ id } as PreferenceDraft) : null;
  }
  switch (v.id) {
    case 'act.attack':
      return vocab.includes('act.attack') && isSelector(v.target)
        ? { id: 'act.attack', target: v.target }
        : null;
    case 'act.protect':
    case 'act.lure':
    case 'act.screen':
    case 'act.swap': {
      const ally = inAllies(v.ally);
      return vocab.includes(v.id) && ally !== null ? { id: v.id, ally } : null;
    }
    case 'space.nearTo':
    case 'space.behind':
    case 'space.awayFrom': {
      if (!vocab.includes(v.id) || !isRecord(v.ref)) return null;
      const ally = inAllies(v.ref.ally);
      const ref =
        ally !== null ? { ally } : isSelector(v.ref.enemy) ? { enemy: v.ref.enemy } : null;
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
