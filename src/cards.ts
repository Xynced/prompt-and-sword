import type { Condition, Preference, Rule } from './ir.js';
import { LENS_RU, applyLens } from './lens.js';
import type { LensId } from './types.js';

/**
 * Карточка «Как понял Гром»: шаблонный обратный перевод IR ПОСЛЕ линз.
 * Контракт с игроком: все искажения характера видны ДО боя.
 */

export interface UnderstandingCard {
  heroName: string;
  lenses: LensId[];
  lines: string[];
}

const SEL_RU: Record<string, string> = {
  nearest: 'ближайшего',
  weakest: 'самого слабого',
  leader: 'вожака',
  mostDangerous: 'самого опасного',
  attacker: 'того, кто меня атаковал',
  marked: 'помеченного',
  shooter: 'стрелка',
  farthest: 'самого дальнего',
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
    case 'battleDrags':
      return 'если бой затянулся — ';
    case 'initiativeEdge':
      return 'если мы быстрее — ';
    case 'allyFallen':
      return 'если кто-то из наших пал — ';
    case 'surrounded':
      return 'если меня окружили — ';
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
    case 'bait':
      return 'изображаю приманку: маячу перед врагами, не подставляясь под удар';
    case 'trade':
      return 'иду на размен: бью, когда удар того стоит, даже под ответ';
    case 'coverRetreat':
      return 'прикрываю отход: встаю между врагами и самым раненым из наших';
    case 'standoff':
      return 'держу дистанцию: бью с края своей дальности, ближе не подпускаю';
    case 'flank':
      return 'захожу во фланг и бью с двух сторон';
    case 'avoidLineOfFire':
      return 'держусь вне линии огня вражеских стрелков';
    case 'chokepoint':
      return 'встаю в узком месте: держу проход между камнями';
    case 'brace':
      return 'встаю в глухую оборону, когда до меня могут достать';
    case 'awayFrom':
      return `держусь подальше от ${p.ref.type === 'ally' ? nm(p.ref.id) : SEL_RU[p.ref.sel]}`;
    case 'strikeOften':
      return 'бью часто и вполсилы: лучше три замаха, чем один';
    case 'strikeHard':
      return 'бью в полную силу, на мелкие замахи не размениваюсь';
    case 'strikeDesperate':
      return 'бью отчаянно: сильнее обычного, но открываюсь под ответ';
    case 'highGround':
      return 'держу высоту: забираюсь на холм — с него дальше видно и больнее бить';
    case 'behindCover':
      return 'держусь за укрытием: прячусь за камнем от вражеских стрелков';
    case 'avoidHazard':
      return 'обхожу опасное: на шипы и в огонь не встаю, а встав — ухожу';
  }
}

/** Помечена ли строка искажением линзы (по аннотации source). */
const LENS_MARK_RE = new RegExp(`\\((?:${Object.values(LENS_RU).join('|')}):`);

function lensMark(rule: Rule): string {
  if (LENS_MARK_RE.test(rule.source)) return ' ⚠ понял по-своему';
  if (rule.source.startsWith('инстинкт')) return ' ⚠ инстинкт';
  if (rule.source.startsWith('способность')) return ' · способность';
  return '';
}

/**
 * Строит карточку понимания: сырые правила героя → линзы → текст.
 * Та же applyLens, что и в бою — карточка не может разойтись с поведением.
 * uncertainty — заметки LLM-компилятора («не знает слова X»), тоже видны до боя.
 */
export function understandingCard(
  hero: { name: string; lenses: LensId[] },
  rawRules: Rule[],
  names: Record<string, string> = {},
  uncertainty: readonly string[] = [],
): UnderstandingCard {
  const nm = (id: string): string => names[id] ?? id;
  const compiled = applyLens(hero.lenses, rawRules);
  const lines = compiled.rules.map(
    (r) => `${condRu(r.when, nm)}${prefRu(r.then, nm)}${lensMark(r)}`,
  );
  for (const u of uncertainty) lines.push(`⚠ ${u}`);
  if (hero.lenses.includes('literalist')) {
    lines.push('нет правила на ситуацию — стою и защищаюсь ⚠ буквалист');
  }
  return { heroName: hero.name, lenses: hero.lenses, lines };
}
