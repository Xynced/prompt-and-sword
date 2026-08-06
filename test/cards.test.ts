import { describe, expect, it } from 'vitest';
import { lensQuip, understandingCard } from '../src/cards.js';
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

describe('understandingCard (карточка-эхо: до боя виден только факт искажения)', () => {
  it('трус: искажённая строка — формулировка игрока + «понял по-своему», инстинкт скрыт', () => {
    const card = understandingCard({ name: 'Тень', lenses: ['coward'] }, [protect()], names);
    expect(card.lines).toEqual(['прикрывай Лию ⚠ понял по-своему']);
  });

  it('фанатик: «отступай» — только факт искажения, без деталей', () => {
    const card = understandingCard({ name: 'Гром', lenses: ['fanatic'] }, [retreat()], names);
    expect(card.lines).toEqual(['ранен — отходи ⚠ понял по-своему']);
  });

  it('не понятое компилятором — «не понял вообще»', () => {
    const card = understandingCard({ name: 'Гром', lenses: ['plain'] }, [retreat()], names, [
      'не знаю слова «кайт»',
    ]);
    expect(card.lines.at(-1)).toBe('⚠ не понял вообще: не знаю слова «кайт»');
  });

  it('буквалист: правила дословно; предупреждение о пропусках — только в debug', () => {
    const card = understandingCard({ name: 'Дарт', lenses: ['literalist'] }, [retreat()], names);
    expect(card.lines[0]).not.toContain('⚠');
    expect(card.lines.some((l) => l.includes('буквалист'))).toBe(false);
    const dbg = understandingCard({ name: 'Дарт', lenses: ['literalist'] }, [retreat()], names, [], true);
    expect(dbg.lines.at(-1)).toContain('буквалист');
  });

  it('debug: полная карточка — детали искажения и инстинкты видны', () => {
    const card = understandingCard({ name: 'Тень', lenses: ['coward'] }, [protect()], names, [], true);
    const line = card.lines.find((l) => l.includes('позади'))!;
    expect(line).toContain('встаю позади Лия');
    expect(line).toContain('⚠ понял по-своему');
    expect(card.lines.some((l) => l.includes('30%') && l.includes('отхожу') && l.includes('инстинкт'))).toBe(true);
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

describe('lensQuip (реплики раскрытия в журнале боя)', () => {
  it('трус про «прикрывать»: голос персонажа, имя подопечного есть, имени линзы нет', () => {
    const q = lensQuip({ lens: 'coward', kind: 'reword', from: { kind: 'protect', ally: 'lia' } }, names);
    expect(q).toContain('Лия');
    expect(q).toContain('за спиной');
    expect(q.toLowerCase()).not.toContain('трус');
  });

  it('фанатик про отступление', () => {
    const q = lensQuip({ lens: 'fanatic', kind: 'reword', from: { kind: 'retreat' } });
    expect(q).toContain('когда все лягут');
  });

  it('инстинкт мстителя', () => {
    expect(lensQuip({ lens: 'avenger', kind: 'instinct' })).toContain('тот умрёт');
  });

  it('непокрытое сочетание — безопасный фолбэк', () => {
    expect(lensQuip({ lens: 'duelist', kind: 'reweight', mult: 0.85 })).toBe('Понял по-своему.');
  });
});
