import { LENS_RU } from './lens.js';
import type { NodeKind } from './run.js';
import type { LensId } from './types.js';

/**
 * Журнал плейтеста — подготовка Ворот B/C.
 *
 * План требует собирать корпус формулировок ещё на Воротах B: тестер пишет
 * замысел словами ДО того, как собрать его из чипсов конструктора. Журнал
 * копит эти замыслы (плюс свободный текст, если включён LLM-компилятор) и
 * поведенческие метки Ворот B: пользуется ли тестер спаррингом добровольно,
 * переписывает ли приказы между попытками.
 *
 * Чистые функции над массивом событий; хранение (localStorage) — на стороне UI.
 * Времени и случайности здесь нет — только порядок событий.
 */

export type JournalEvent =
  | { t: 'run'; seed: number; imported?: true }
  | { t: 'intent'; hero: string; lenses: LensId[]; vocab: number; seed: number; text: string }
  | {
      t: 'freeText';
      hero: string;
      lenses: LensId[];
      vocab: number;
      seed: number;
      text: string;
      ok: boolean;
      uncertain: number;
    }
  | { t: 'battle'; node: NodeKind; sparring: boolean; rewritten: boolean; won: boolean; rounds: number }
  | { t: 'end'; won: boolean };

/** Потолок журнала: старейшие события вытесняются (защита localStorage). */
export const JOURNAL_CAP = 1000;

/**
 * Добавить событие. Дубли гасятся: повторный `run` того же сида (перезагрузка
 * страницы) и `intent`, совпадающий с последним замыслом того же героя.
 */
export function appendEvent(events: JournalEvent[], e: JournalEvent): JournalEvent[] {
  if (e.t === 'run') {
    const last = events.filter((x) => x.t === 'run').at(-1);
    if (last && last.seed === e.seed) return events;
  }
  if (e.t === 'intent') {
    if (e.text.trim().length === 0) return events;
    const last = events.filter((x) => x.t === 'intent' && x.hero === e.hero).at(-1) as
      | Extract<JournalEvent, { t: 'intent' }>
      | undefined;
    if (last && last.text === e.text) return events;
  }
  return [...events, e].slice(-JOURNAL_CAP);
}

/** Последний записанный замысел героя (префилл поля после перезагрузки). */
export function lastIntent(events: JournalEvent[], hero: string): string {
  const last = events.filter((x) => x.t === 'intent' && x.hero === hero).at(-1) as
    | Extract<JournalEvent, { t: 'intent' }>
    | undefined;
  return last?.text ?? '';
}

const lensTag = (lenses: readonly LensId[]): string => lenses.map((l) => LENS_RU[l]).join('+');

/**
 * Текстовый отчёт: сводка Ворот B + корпус формулировок, совместимый с
 * corpus/*.txt (строки с # пропускаются парсером; `=>` в тексте тестера
 * заменяется, чтобы не читался как «ожидаемое понимание»).
 */
export function journalReport(events: JournalEvent[]): string {
  const runs = events.filter((e) => e.t === 'run').length;
  const ends = events.filter((e) => e.t === 'end');
  const battles = events.filter((e) => e.t === 'battle');
  const sparrings = battles.filter((b) => b.sparring);
  const rewrites = sparrings.filter((b) => b.rewritten);
  const texts = events.filter((e) => e.t === 'intent' || e.t === 'freeText');
  const free = events.filter((e) => e.t === 'freeText');

  const out: string[] = [
    '# Prompt & Sword — журнал плейтеста (Ворота B/C)',
    `# забегов: ${runs} (доиграно ${ends.length}, побед ${ends.filter((e) => e.won).length})`,
    `# боёв: ${battles.length} · спаррингов: ${sparrings.length}` +
      ` (с переписанными приказами: ${rewrites.length} — петля работает, если почти все)`,
    `# формулировок в корпусе: ${texts.length}` +
      (free.length
        ? ` · свободным текстом: ${free.length} (скомпилировано ${free.filter((e) => e.ok).length}, с ⚠ ${free.filter((e) => e.ok && e.uncertain > 0).length})`
        : ''),
  ];
  if (texts.length > 0) {
    out.push('', '# --- корпус формулировок: вставь строки ниже в corpus/<тестер>.txt ---');
    for (const e of texts) {
      const kind =
        e.t === 'intent'
          ? 'замысел до конструктора'
          : `свободный текст → ${e.ok ? (e.uncertain > 0 ? `⚠${e.uncertain}` : 'ок') : 'не скомпилирован'}`;
      out.push(`# ${e.hero} [${lensTag(e.lenses)}] · словарь ${e.vocab} · seed ${e.seed} · ${kind}`);
      out.push(e.text.replace(/\s+/g, ' ').replace(/=>/g, '→').trim());
    }
  }
  return out.join('\n') + '\n';
}
