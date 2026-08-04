import { describe, expect, it } from 'vitest';
import { type PhraseDraft, compilePhrase } from '../src/constructor.js';
import { type ConceptId, STARTING_VOCAB } from '../src/vocab.js';

const names = { lia: 'Лия', grom: 'Гром' };

/** Ранний словарь MVP: старт + первые простые слова (для фраз с условиями/защитой). */
const MVP_VOCAB: ConceptId[] = [
  ...STARTING_VOCAB,
  'cond.hpBelow',
  'cond.outnumbered',
  'sel.weakest',
  'act.protect',
  'act.holdPosition',
  'space.nearTo',
];

describe('compilePhrase', () => {
  it('валидная фраза компилируется в правило IR', () => {
    const draft: PhraseDraft = {
      condition: { id: 'cond.hpBelow', who: 'self', frac: 0.5 },
      preference: { id: 'act.retreat' },
      weight: 2,
    };
    const r = compilePhrase(draft, MVP_VOCAB, names);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rule.when).toEqual({ kind: 'hpBelow', who: 'self', frac: 0.5 });
    expect(r.rule.then).toEqual({ kind: 'retreat' });
    expect(r.rule.weight).toBe(3);
    expect(r.rule.source).toContain('отступать');
  });

  it('закрытый концепт — ошибка компиляции с перечислением, а не догадка', () => {
    const draft: PhraseDraft = {
      condition: { id: 'always' },
      preference: { id: 'act.attack', target: 'sel.leader' }, // sel.leader не в старте
    };
    const r = compilePhrase(draft, MVP_VOCAB, names);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(['sel.leader']);
  });

  it('закрытое условие тоже ловится', () => {
    const draft: PhraseDraft = {
      condition: { id: 'cond.allyInDanger', ally: 'lia' },
      preference: { id: 'act.attack', target: 'sel.nearest' },
    };
    const r = compilePhrase(draft, MVP_VOCAB, names);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(['cond.allyInDanger']);
  });

  it('пространственная ссылка на врага-селектора требует его концепт', () => {
    const draft: PhraseDraft = {
      condition: { id: 'always' },
      preference: { id: 'space.nearTo', ref: { enemy: 'sel.leader' } },
    };
    const r = compilePhrase(draft, MVP_VOCAB, names);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(['sel.leader']);
  });

  it('source читается по-русски с именами', () => {
    const draft: PhraseDraft = {
      condition: { id: 'always' },
      preference: { id: 'act.protect', ally: 'lia' },
    };
    const r = compilePhrase(draft, MVP_VOCAB, names);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rule.source).toBe('защищать Лия');
  });
});
