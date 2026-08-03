import type { Condition, Preference, Rule } from './ir.js';
import { applyLens } from './lens.js';
import type { CharacterId } from './types.js';

/**
 * Карточка «Как понял Гром»: шаблонный обратный перевод IR ПОСЛЕ линзы.
 * Контракт с игроком: все искажения характера видны ДО боя.
 */

export interface UnderstandingCard {
  heroName: string;
  character: CharacterId;
  lines: string[];
}

const SEL_RU: Record<string, string> = {
  nearest: 'ближайшего',
  weakest: 'самого слабого',
  leader: 'вожака',
};

function condRu(c: Condition, nm: (id: string) => string): string {
  switch (c.kind) {
    case 'always':
      return '';
    case 'hpBelow':
      return c.who === 'self'
        ? `если моё hp ниже ${Math.round(c.frac * 100)}% — `
        : `если hp ${nm(c.who.ally)} ниже ${Math.round(c.frac * 100)}% — `;
    case 'outnumbered':
      return 'если врагов больше, чем нас — ';
    case 'allyInDanger':
      return `если ${nm(c.ally)} в опасности — `;
  }
}

function prefRu(p: Preference, nm: (id: string) => string): string {
  switch (p.kind) {
    case 'attack':
      return `атакую ${SEL_RU[p.target]}`;
    case 'protect':
      return `прикрываю ${nm(p.ally)}`;
    case 'holdPosition':
      return 'держу позицию';
    case 'retreat':
      return 'отхожу';
    case 'nearTo':
      return `держусь рядом с ${p.ref.type === 'ally' ? nm(p.ref.id) : SEL_RU[p.ref.sel]}`;
    case 'behind':
      return `встаю позади ${p.ref.type === 'ally' ? nm(p.ref.id) : SEL_RU[p.ref.sel]}`;
  }
}

/** Помечена ли строка искажением линзы (по аннотации source). */
function lensMark(rule: Rule): string {
  if (rule.source.includes('(трус:')) return ' ⚠ понял по-своему';
  if (rule.source.includes('(фанатик:')) return ' ⚠ понял по-своему';
  if (rule.source.startsWith('инстинкт труса')) return ' ⚠ инстинкт';
  return '';
}

/**
 * Строит карточку понимания: сырые правила героя → линза → текст.
 * Та же applyLens, что и в бою — карточка не может разойтись с поведением.
 * uncertainty — заметки LLM-компилятора («не знает слова X»), тоже видны до боя.
 */
export function understandingCard(
  hero: { name: string; character: CharacterId },
  rawRules: Rule[],
  names: Record<string, string> = {},
  uncertainty: readonly string[] = [],
): UnderstandingCard {
  const nm = (id: string): string => names[id] ?? id;
  const compiled = applyLens(hero.character, rawRules);
  const lines = compiled.rules.map(
    (r) => `${condRu(r.when, nm)}${prefRu(r.then, nm)}${lensMark(r)}`,
  );
  for (const u of uncertainty) lines.push(`⚠ ${u}`);
  if (hero.character === 'literalist') {
    lines.push('нет правила на ситуацию — стою и защищаюсь ⚠ буквалист');
  }
  return { heroName: hero.name, character: hero.character, lines };
}
