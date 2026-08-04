import { describe, expect, it } from 'vitest';
import { understandingCard } from '../src/cards.js';
import type { Rule } from '../src/ir.js';

const names = { lia: 'Лия' };

const protect = (): Rule => ({
  when: { kind: 'always' },
  then: { kind: 'protect', ally: 'lia' },
  weight: 2,
  scope: 'self',
  source: 'прикрывай Лию',
});
const retreat = (): Rule => ({
  when: { kind: 'hpBelow', who: 'self', frac: 0.5 },
  then: { kind: 'retreat' },
  weight: 2,
  scope: 'self',
  source: 'ранен — отходи',
});

describe('understandingCard', () => {
  it('трус: «прикрывать» показан как «встаю позади» с пометкой искажения', () => {
    const card = understandingCard({ name: 'Тень', lenses: ['coward'] }, [protect()], names);
    const line = card.lines.find((l) => l.includes('позади'))!;
    expect(line).toContain('встаю позади Лия');
    expect(line).toContain('⚠');
    // и виден инстинкт бегства
    expect(card.lines.some((l) => l.includes('30%') && l.includes('отхожу'))).toBe(true);
  });

  it('фанатик: «отступай» показан как атака с пометкой', () => {
    const card = understandingCard({ name: 'Гром', lenses: ['fanatic'] }, [retreat()], names);
    const line = card.lines[0]!;
    expect(line).toContain('если моё hp ниже 50%');
    expect(line).toContain('атакую ближайшего');
    expect(line).toContain('⚠');
  });

  it('буквалист: правила без искажений + предупреждение о пропусках', () => {
    const card = understandingCard({ name: 'Дарт', lenses: ['literalist'] }, [retreat()], names);
    expect(card.lines[0]).not.toContain('⚠');
    expect(card.lines.at(-1)).toContain('буквалист');
  });

  it('plain: никаких пометок', () => {
    const card = understandingCard({ name: 'Наёмник', lenses: ['plain'] }, [protect(), retreat()], names);
    expect(card.lines).toHaveLength(2);
    for (const l of card.lines) expect(l).not.toContain('⚠');
  });

  it('карточка детерминирована', () => {
    const a = understandingCard({ name: 'Тень', lenses: ['coward'] }, [protect()], names);
    const b = understandingCard({ name: 'Тень', lenses: ['coward'] }, [protect()], names);
    expect(a).toEqual(b);
  });
});
