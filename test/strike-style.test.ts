import { describe, expect, it } from 'vitest';
import type { Rule } from '../src/ir.js';
import { applyLens } from '../src/lens.js';
import { compilePhrase } from '../src/constructor.js';
import { CONCEPTS, DEEP_WORDS, CORE_WORDS, type ConceptId } from '../src/vocab.js';
import { understandingCard } from '../src/cards.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import { type UnitSpec, runBattle } from '../src/battle.js';
import type { LensId } from '../src/types.js';

/**
 * Манера удара (act.strikeOften / strikeHard / strikeDesperate) — слова
 * экономики хода: говорят, ЧЕМ бить, а не кого. Критерий словаря: слово
 * меняет бой, а не дублирует существующее.
 */

const FULL_VOCAB = Object.keys(CONCEPTS) as ConceptId[];

const attackRule = (): Rule => ({
  when: { kind: 'always' },
  then: { kind: 'attack', target: 'nearest' },
  weight: 2,
  scope: 'self',
  source: 'бей ближайшего',
});

const styleRule = (kind: 'strikeOften' | 'strikeHard' | 'strikeDesperate'): Rule => ({
  when: { kind: 'always' },
  then: { kind },
  weight: 1.5,
  scope: 'self',
  source: `манера: ${kind}`,
});

/** Раскладка действий бойца с приказом «бей ближайшего» + манерой удара. */
function actionMix(style?: Rule, lenses: LensId[] = ['plain']): Record<string, number> {
  const counts = new Map<string, number>();
  let total = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const rules = style ? [attackRule(), style] : [attackRule()];
    const hero: UnitSpec = {
      id: 'h', name: 'Боец', side: 'party', maxHp: 60, atk: 8, range: 1,
      speed: 5, move: 2, lenses, rules, spawn: { x: 4, y: 5 },
    };
    const foes: UnitSpec[] = [1, 2].map((i) => ({
      id: `f${i}`, name: `Враг ${i}`, side: 'foe', maxHp: 40, atk: 6, range: 1,
      speed: 4, move: 2, lenses: ['plain'], rules: [attackRule()], spawn: { x: 6, y: 4 + i },
    }));
    for (const e of runBattle(seed, [hero, ...foes]).events) {
      if (e.t !== 'decision' || e.unit !== 'h') continue;
      counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
      total++;
    }
  }
  return Object.fromEntries([...counts].map(([k, v]) => [k, v / total]));
}

describe('манера удара меняет бой', () => {
  const plain = actionMix();

  it('«бей часто» пересаживает на слабые удары', () => {
    const often = actionMix(styleRule('strikeOften'));
    expect(often.weakAttack ?? 0).toBeGreaterThan((plain.weakAttack ?? 0) + 0.2);
  });

  it('«бей наверняка» убирает слабые удары', () => {
    const hard = actionMix(styleRule('strikeHard'));
    expect(hard.weakAttack ?? 0).toBeLessThan((plain.weakAttack ?? 0) - 0.2);
    expect(hard.attack ?? 0).toBeGreaterThan(plain.attack ?? 0);
  });

  it('«бей отчаянно» пересаживает на отчаянные удары', () => {
    const desperate = actionMix(styleRule('strikeDesperate'));
    expect(desperate.selflessAttack ?? 0).toBeGreaterThan((plain.selflessAttack ?? 0) + 0.2);
  });
});

describe('линза искажает манеру удара', () => {
  it('трус: «бей отчаянно» → «бей наверняка», с пометкой', () => {
    const c = applyLens(['coward'], [styleRule('strikeDesperate')]);
    const r = c.rules[0]!;
    expect(r.then.kind).toBe('strikeHard');
    expect(r.marks).toEqual([{ lens: 'coward', kind: 'reword', from: { kind: 'strikeDesperate' } }]);
  });

  it('фанатик: любая манера → «бей отчаянно»', () => {
    for (const kind of ['strikeOften', 'strikeHard'] as const) {
      const c = applyLens(['fanatic'], [styleRule(kind)]);
      expect(c.rules[0]!.then.kind).toBe('strikeDesperate');
      expect(c.rules[0]!.marks).toEqual([{ lens: 'fanatic', kind: 'reword', from: { kind } }]);
    }
  });

  it('горячка: «бей наверняка» → «бей часто»', () => {
    const c = applyLens(['hothead'], [styleRule('strikeHard')]);
    expect(c.rules[0]!.then.kind).toBe('strikeOften');
    expect(c.rules[0]!.marks).toEqual([{ lens: 'hothead', kind: 'reword', from: { kind: 'strikeHard' } }]);
  });

  it('искажение видно в карточке понимания до боя', () => {
    const card = understandingCard({ name: 'Гром', lenses: ['fanatic'] }, [styleRule('strikeHard')]);
    expect(card.lines[0]).toContain('отчаянно');
    expect(card.lines[0]).toContain('⚠');
  });
});

describe('конструктор и словарь', () => {
  it('фразы манеры компилируются при открытом словаре', () => {
    for (const id of ['act.strikeOften', 'act.strikeHard', 'act.strikeDesperate'] as const) {
      const r = compilePhrase({ condition: { id: 'always' }, preference: { id } }, FULL_VOCAB);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.rule.then.kind).toBe(id.replace('act.', ''));
    }
  });

  it('закрытое слово — ошибка, а не догадка', () => {
    const r = compilePhrase(
      { condition: { id: 'always' }, preference: { id: 'act.strikeDesperate' } },
      ['act.attack', 'sel.nearest'],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain('act.strikeDesperate');
  });

  it('пара часто/наверняка — в простых словах, отчаянно — в глубоких', () => {
    expect(CORE_WORDS).toContain('act.strikeOften');
    expect(CORE_WORDS).toContain('act.strikeHard');
    expect(DEEP_WORDS).toContain('act.strikeDesperate');
  });

  it('схема компилятора включает манеру только при открытом словаре', () => {
    const json = JSON.stringify(buildCompileSchema(FULL_VOCAB, ['grom']));
    expect(json).toContain('act.strikeOften');
    const closed = JSON.stringify(buildCompileSchema(['act.attack', 'sel.nearest'], ['grom']));
    expect(closed).not.toContain('act.strikeOften');
  });

  it('validateOutput пропускает манеру по словарю', () => {
    const out = {
      phrases: [{ condition: { id: 'always' }, preference: { id: 'act.strikeOften' }, weight: 1 }],
      uncertainty: [],
    };
    expect(validateOutput(out, FULL_VOCAB, [], 3).ok).toBe(true);
    expect(validateOutput(out, ['act.attack'], [], 3).ok).toBe(false);
  });
});
