import type { PhraseDraft } from './constructor.js';
import { MAX_SLOTS, type RunState, setPhrases, startRun } from './run.js';
import { CONCEPTS, type ConceptId } from './vocab.js';

/**
 * Экспорт билда строкой (фаза 5): «вот мой билд, побей мой сид».
 * Билд = сид забега + открытый словарь + слоты и принципы героев.
 * Импорт строит свежий забег с того же сида (та же карта, те же линзы)
 * и применяет билд; всё остальное игрок проходит сам.
 *
 * Формат: `ps1.<base64url(JSON)>` — версия в префиксе, валидация при импорте
 * та же, что у конструктора (setPhrases): чужая строка не может выразить
 * закрытый концепт или сломать инварианты.
 */

export interface BuildExport {
  v: 1;
  seed: number;
  vocab: ConceptId[];
  heroes: { id: string; slots: number; phrases: PhraseDraft[] }[];
}

const PREFIX = 'ps1.';

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string | undefined {
  try {
    const bin = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

export function exportBuild(state: RunState): string {
  const build: BuildExport = {
    v: 1,
    seed: state.runSeed,
    vocab: [...state.vocab],
    heroes: state.heroes.map((h) => ({
      id: h.id,
      slots: h.slots,
      phrases: h.phrases.map((p) => ({ ...p })),
    })),
  };
  return PREFIX + toBase64Url(JSON.stringify(build));
}

export type ImportResult = { ok: true; state: RunState } | { ok: false; error: string };

const fail = (error: string): ImportResult => ({ ok: false, error });

export function importBuild(text: string): ImportResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX)) return fail('Не похоже на строку билда (нет префикса ps1)');
  const json = fromBase64Url(trimmed.slice(PREFIX.length));
  if (json === undefined) return fail('Строка билда повреждена (не читается base64)');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fail('Строка билда повреждена (не читается JSON)');
  }
  if (typeof raw !== 'object' || raw === null) return fail('Строка билда повреждена');
  const b = raw as Partial<BuildExport>;
  if (b.v !== 1) return fail(`Неизвестная версия билда: ${String(b.v)}`);
  if (!Number.isInteger(b.seed)) return fail('В билде нет сида');
  if (!Array.isArray(b.vocab) || !Array.isArray(b.heroes)) return fail('Строка билда повреждена');
  for (const c of b.vocab) {
    if (typeof c !== 'string' || !(c in CONCEPTS)) return fail(`Неизвестный концепт в билде: ${String(c)}`);
  }

  const state = startRun(b.seed as number);
  for (const c of b.vocab) {
    if (!state.vocab.includes(c)) state.vocab.push(c);
  }
  for (const h of b.heroes) {
    if (typeof h !== 'object' || h === null) return fail('Строка билда повреждена');
    const hero = state.heroes.find((x) => x.id === h.id);
    if (!hero) return fail(`Неизвестный герой в билде: ${String(h.id)}`);
    if (!Number.isInteger(h.slots) || h.slots < 1 || h.slots > MAX_SLOTS) {
      return fail(`Недопустимые слоты у ${hero.name}`);
    }
    hero.slots = Math.max(hero.slots, h.slots);
    if (!Array.isArray(h.phrases)) return fail('Строка билда повреждена');
    try {
      const r = setPhrases(state, hero.id, h.phrases as PhraseDraft[]);
      if (!r.ok) return fail(`Принципы ${hero.name}: ${r.error}`);
    } catch {
      return fail(`Принципы ${hero.name} повреждены`);
    }
  }
  return { ok: true, state };
}
