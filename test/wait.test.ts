import { describe, expect, it } from 'vitest';
import type { Rule } from '../src/ir.js';
import { applyLens } from '../src/lens.js';
import { type Candidate, decide, makeCtx, scoreCandidate } from '../src/scoring.js';
import { type PhraseDraft, compilePhrase } from '../src/constructor.js';
import { CONCEPTS, STARTING_VOCAB, UNLOCKABLE, type ConceptId } from '../src/vocab.js';
import { understandingCard } from '../src/cards.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import type { CombatUnit, Pos } from '../src/types.js';

/**
 * Слово «ждать»: темп, а не место. Даёт сказать «подожди, а ПОТОМ …» —
 * выжидание безусловным правилом плюс второе правило с условием момента.
 */

const FULL_VOCAB = Object.keys(CONCEPTS) as ConceptId[];

type Fighter = CombatUnit & { compiled: ReturnType<typeof applyLens> };

function unit(id: string, side: 'party' | 'foe', pos: Pos, over: Partial<CombatUnit> = {}): CombatUnit {
  return {
    id, name: id, side, maxHp: 40, hp: 40, atk: 6, range: 1, speed: 5, move: 2,
    pos: { ...pos }, startPos: { ...pos }, alive: true, coverLevel: 0, exposed: false,
    tags: [], lenses: ['plain'], ...over,
  };
}

function fighter(id: string, side: 'party' | 'foe', pos: Pos, rules: Rule[] = [], over: Partial<CombatUnit> = {}): Fighter {
  return { ...unit(id, side, pos, over), compiled: applyLens(['plain'], rules) };
}

const rule = (then: Rule['then'], w = 2): Rule => ({
  when: { kind: 'always' },
  then,
  weight: w,
  scope: 'self',
  source: 'тест',
});

/** Вклад правила в оценку кандидата. */
function ruleFactor(cand: Candidate, self: Fighter, units: Fighter[], rules: Rule[]): number {
  const f = scoreCandidate(cand, self, units, rules, makeCtx()).find((x) => x.label.startsWith('правило:'));
  return f?.value ?? 0;
}

describe('скоринг «ждать»', () => {
  const wait = rule({ kind: 'wait' });

  it('премия пасу, пока бой не докатился; под ударом — молчит', () => {
    const self = fighter('a', 'party', { x: 2, y: 9 });
    const far = fighter('e', 'foe', { x: 15, y: 9 }); // strikeReach 5 < 13
    expect(ruleFactor({ to: self.pos, action: 'wait' }, self, [self, far], [wait])).toBeGreaterThan(0);

    const close = fighter('e', 'foe', { x: 5, y: 9 }); // достаёт за свой ход
    expect(ruleFactor({ to: self.pos, action: 'wait' }, self, [self, close], [wait])).toBe(0);
  });

  it('штраф шагу навстречу; шаг в сторону и назад бесплатны', () => {
    const self = fighter('a', 'party', { x: 2, y: 9 });
    const foe = fighter('e', 'foe', { x: 15, y: 9 });
    const units = [self, foe];
    expect(ruleFactor({ to: { x: 3, y: 9 }, action: 'move' }, self, units, [wait])).toBeLessThan(0);
    expect(ruleFactor({ to: { x: 2, y: 8 }, action: 'move' }, self, units, [wait])).toBe(0);
    expect(ruleFactor({ to: { x: 1, y: 9 }, action: 'move' }, self, units, [wait])).toBe(0);
  });

  it('атаку не трогает: слово о темпе сближения, а не о запрете драться', () => {
    const self = fighter('a', 'party', { x: 2, y: 9 });
    const adj = fighter('e', 'foe', { x: 3, y: 9 });
    for (const action of ['attack', 'weakAttack', 'selflessAttack'] as const) {
      expect(ruleFactor({ to: self.pos, action, targetId: 'e' }, self, [self, adj], [wait])).toBe(0);
    }
  });

  it('без слова боец идёт навстречу, со словом — стоит', () => {
    const foe = fighter('e', 'foe', { x: 15, y: 9 });
    const eager = fighter('a', 'party', { x: 2, y: 9 }, [rule({ kind: 'attack', target: 'nearest' })]);
    expect(decide(eager, [eager, foe]).chosen.action).toBe('move');

    const patient = fighter('a', 'party', { x: 2, y: 9 }, [wait]);
    expect(decide(patient, [patient, foe]).chosen.action).toBe('wait');
  });

  it('«подожди, а потом бросайся в атаку»: условное правило снимает с места', () => {
    const foe = fighter('e', 'foe', { x: 15, y: 9 });
    const self = fighter('a', 'party', { x: 2, y: 9 }, [
      rule({ kind: 'wait' }),
      { ...rule({ kind: 'attack', target: 'nearest' }), when: { kind: 'battleDrags' } },
    ]);
    expect(decide(self, [self, foe], 1).chosen.action).toBe('wait');
    const late = decide(self, [self, foe], 5);
    expect(late.chosen.action).toBe('move');
    expect(late.chosen.to.x).toBeGreaterThan(self.pos.x);
  });
});

describe('линзы искажают «ждать»', () => {
  it('фанатик не ждёт — бьёт ближайшего', () => {
    const out = applyLens(['fanatic'], [rule({ kind: 'wait' })]);
    expect(out.rules.some((r) => r.then.kind === 'wait')).toBe(false);
    const rewritten = out.rules.find((r) => r.source === 'тест')!;
    expect(rewritten.then).toEqual({ kind: 'attack', target: 'nearest' });
    expect(rewritten.marks?.some((m) => m.kind === 'reword')).toBe(true);
  });

  it('трус выжидает рьяно — вес выше', () => {
    const src = rule({ kind: 'wait' });
    const out = applyLens(['coward'], [src]);
    const kept = out.rules.find((r) => r.source === 'тест')!;
    expect(kept.then).toEqual({ kind: 'wait' });
    expect(kept.weight).toBeCloseTo(src.weight * 1.3);
  });
});

describe('«ждать» по слоям', () => {
  const draft: PhraseDraft = { condition: { id: 'always' }, preference: { id: 'act.wait' } };

  it('в словаре: действие, добывается, в старт не входит', () => {
    expect(CONCEPTS['act.wait'].category).toBe('action');
    expect(UNLOCKABLE).toContain('act.wait');
    expect(STARTING_VOCAB).not.toContain('act.wait');
  });

  it('конструктор: чипс компилируется, закрытое слово — ошибка', () => {
    const ok = compilePhrase(draft, FULL_VOCAB);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.rule.then).toEqual({ kind: 'wait' });
      expect(ok.rule.source).toContain('выжидать');
    }
    const closed = compilePhrase(draft, STARTING_VOCAB);
    expect(closed).toEqual({ ok: false, missing: ['act.wait'] });
  });

  it('схема компилятора: слово есть только при открытом словаре', () => {
    expect(JSON.stringify(buildCompileSchema(FULL_VOCAB, []))).toContain('act.wait');
    expect(JSON.stringify(buildCompileSchema(STARTING_VOCAB, []))).not.toContain('act.wait');
    const out = { phrases: [draft], uncertainty: [] };
    const open = validateOutput(out, FULL_VOCAB, [], 3);
    expect(open.ok).toBe(true);
    if (open.ok) expect(open.output.phrases).toEqual([{ ...draft, weight: 1 }]);
    expect(validateOutput(out, STARTING_VOCAB, [], 3).ok).toBe(false);
  });

  it('карточка «как понял» читается по-русски', () => {
    const compiled = compilePhrase(draft, FULL_VOCAB);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const card = understandingCard({ name: 'Скала', lenses: ['plain'] }, [compiled.rule], {}, [], true);
    expect(card.lines.join(' ')).toContain('выжидаю');
  });
});
