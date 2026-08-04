import { describe, expect, it } from 'vitest';
import { JOURNAL_CAP, type JournalEvent, appendEvent, journalReport, lastIntent } from '../src/playtest.js';

const intent = (hero: string, text: string): JournalEvent => ({
  t: 'intent',
  hero,
  lenses: ['coward'],
  vocab: 12,
  seed: 1,
  text,
});

describe('appendEvent', () => {
  it('гасит повторный run того же сида (перезагрузка страницы)', () => {
    let ev: JournalEvent[] = [];
    ev = appendEvent(ev, { t: 'run', seed: 1 });
    ev = appendEvent(ev, { t: 'run', seed: 1 });
    expect(ev).toHaveLength(1);
    ev = appendEvent(ev, { t: 'run', seed: 2 });
    expect(ev).toHaveLength(2);
  });

  it('гасит замысел, совпадающий с последним у того же героя', () => {
    let ev: JournalEvent[] = [];
    ev = appendEvent(ev, intent('grom', 'прикрывай Лию'));
    ev = appendEvent(ev, intent('grom', 'прикрывай Лию'));
    expect(ev).toHaveLength(1);
    // другой герой с тем же текстом — отдельное событие
    ev = appendEvent(ev, intent('lia', 'прикрывай Лию'));
    // переформулировка того же героя — тоже
    ev = appendEvent(ev, intent('grom', 'прикрывай Лию и отходи'));
    expect(ev).toHaveLength(3);
  });

  it('пустой замысел не пишется', () => {
    expect(appendEvent([], intent('grom', '  '))).toHaveLength(0);
  });

  it('вытесняет старейшие события за потолком', () => {
    let ev: JournalEvent[] = [];
    for (let i = 0; i < JOURNAL_CAP + 5; i++) {
      ev = appendEvent(ev, { t: 'battle', node: 'fight', sparring: false, rewritten: false, won: true, rounds: i });
    }
    expect(ev).toHaveLength(JOURNAL_CAP);
    expect((ev[0] as Extract<JournalEvent, { t: 'battle' }>).rounds).toBe(5);
  });
});

describe('lastIntent', () => {
  it('возвращает последний замысел героя (или пустую строку)', () => {
    let ev: JournalEvent[] = [];
    ev = appendEvent(ev, intent('grom', 'первый'));
    ev = appendEvent(ev, intent('grom', 'второй'));
    expect(lastIntent(ev, 'grom')).toBe('второй');
    expect(lastIntent(ev, 'lia')).toBe('');
  });
});

describe('journalReport', () => {
  const sample = (): JournalEvent[] => {
    let ev: JournalEvent[] = [];
    ev = appendEvent(ev, { t: 'run', seed: 1 });
    ev = appendEvent(ev, intent('grom', 'фокусь вожака => любой ценой'));
    ev = appendEvent(ev, { t: 'battle', node: 'lesson', sparring: false, rewritten: false, won: false, rounds: 6 });
    ev = appendEvent(ev, { t: 'battle', node: 'lesson', sparring: true, rewritten: true, won: true, rounds: 5 });
    ev = appendEvent(ev, {
      t: 'freeText',
      hero: 'grom',
      lenses: ['coward'],
      vocab: 12,
      seed: 1,
      text: 'держись позади Лии',
      ok: true,
      uncertain: 1,
    });
    ev = appendEvent(ev, { t: 'end', won: false });
    return ev;
  };

  it('сводка считает бои, спарринги и переписывания', () => {
    const rep = journalReport(sample());
    expect(rep).toContain('# забегов: 1 (доиграно 1, побед 0)');
    expect(rep).toContain('# боёв: 2 · спаррингов: 1 (с переписанными приказами: 1');
    expect(rep).toContain('свободным текстом: 1 (скомпилировано 1, с ⚠ 1)');
  });

  it('корпусные строки совместимы с парсером corpus/*.txt', () => {
    const rep = journalReport(sample());
    // фильтр парсера из cli.ts: непустые строки без #
    const corpusLines = rep
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(corpusLines).toEqual(['фокусь вожака → любой ценой', 'держись позади Лии']);
    // контекст каждой формулировки — в #-комментарии
    expect(rep).toContain('# grom [трус] · словарь 12 · seed 1 · замысел до конструктора');
    expect(rep).toContain('# grom [трус] · словарь 12 · seed 1 · свободный текст → ⚠1');
  });

  it('пустой журнал — только сводка, без секции корпуса', () => {
    const rep = journalReport([]);
    expect(rep).toContain('# забегов: 0');
    expect(rep).not.toContain('corpus/');
  });
});
