import { type BattleEvent, type BattleResult, type UnitSpec, runBattle, spawnPreview } from '../battle.js';
import { PARTY_ZONE_MAX_X, type Tile, pickTerrain } from '../terrain.js';
import { GRID_H, GRID_W } from '../grid.js';
import {
  describeActive,
  describeAoe,
  describeDefenses,
  describeShield,
  describePassives,
  describeReaction,
  moveMarks,
  REACTION_RU,
  ruleRu,
  describeWeapons,
  driftQuip,
  lensQuip,
  persistRu,
  understandingCard,
} from '../cards.js';
import {
  ROLE_CONCEPT,
  type ConditionDraft,
  type PhraseDraft,
  type PreferenceDraft,
  type CondLinkDraft,
  type SimpleConditionDraft,
  compilePhrase,
  describeDraft,
} from '../constructor.js';
import { type ModelCall, anthropicModelCall, compileFreeText } from '../compiler/compile.js';
import type { CompilerCache } from '../compiler/cache.js';
import type { CompilerOutput } from '../compiler/schema.js';
import { ALLY_ROLE_RU, BATTLE_DRAGS_ROUND, type AllyRef, type AllyRole, type Rule } from '../ir.js';
import { CONCEPTS, type ConceptCategory, type ConceptId, RARE_WORDS } from '../vocab.js';
import {
  type MapNode,
  type NodeKind,
  type HeroState,
  type RunState,
  advance,
  arenaForNode,
  battleSeed,
  deployedSpawn,
  setDeploy,
  chooseInEvent,
  chooseInScriptorium,
  claimReward,
  currentNode,
  eventOffer,
  FOCUS_BUDGET,
  INTEL_POINTS,
  ORDER_SETS,
  buyIntel,
  focusUsed,
  setFocus,
  switchOrderSet,
  foeSpecs,
  foesForNode,
  foesKnown,
  visibleFoes,
  heroNames,
  heroSpecs,
  intelVisible,
  playFight,
  rest,
  scriptoriumOffer,
  setMark,
  setPhrases,
  skipLesson,
  startRun,
} from '../run.js';

import { DEBUG_BATTLES, type DebugSetup, MAX_DEBUG_PARTY, debugBattleById, debugBrief, debugRun } from '../debug.js';
import { scenarioForNode } from '../objectives.js';
import { HERO_POOL, type HeroArchetype, heroArchetype } from '../heroes.js';
import { type JournalEvent, appendEvent, journalReport, lastIntent } from '../playtest.js';
import { exportBuild, importBuild } from '../share.js';
import { LENS_RU, applyLens } from '../lens.js';
import { AOE_BLAST_RADIUS, AOE_RITUAL_RADIUS, AP_COST, attackBonusOf, lineCells, movesOf } from '../scoring.js';
import {
  AP_PER_TURN,
  ARCANE_SHIELD_AC,
  ARCANE_SHIELD_SOAK,
  BRACE_AC,
  COVER_AC,
  DEFAULT_AC,
  DEFAULT_SAVE,
  DEFLECT_AC,
  DODGE_AC,
  MAP_STEP,
  MAP_STEP_AGILE,
  NERVE_AMP,
  PERSIST_DC,
  PERSIST_DC_ASSISTED,
  RIPOSTE_DMG,
  SAVE_DC,
  SELFLESS_VULN_MULT,
  SUCCOR_HEAL,
  mapPenalty,
} from '../tuning.js';
import { DAMAGE_TYPE_RU } from '../types.js';
import type { DamageType, LensId, ReactionKind, SaveKind, Side, WeaponMove, WeaponSpec } from '../types.js';

/**
 * UI по дизайн-прототипу «Prompt & Sword - Prototype.dc.html» (разворот кодекса,
 * вариант 1d): книга 960×640 на тёмном сукне, левая страница — карта/бой/лавка,
 * правая — действующие приказы. Чистый DOM, никакого фреймворка.
 */

const app = document.getElementById('app')!;

const urlParams = new URLSearchParams(location.search);
const urlSeed = Number(urlParams.get('seed') ?? 1);
/** ?build=ps1.… — забег из чужого билда: тот же сид, словарь и принципы. */
const urlBuild = urlParams.get('build');
const importedBuild = urlBuild ? importBuild(urlBuild) : undefined;
if (importedBuild && !importedBuild.ok) {
  alert(`Строка билда не прочитана: ${importedBuild.error}. Начат обычный забег.`);
}
let run: RunState =
  importedBuild?.ok === true ? importedBuild.state : startRun(Number.isFinite(urlSeed) ? urlSeed : 1);

// ---------- состояние UI ----------

let battle: BattleResult | null = null;
let frames: Frame[] = [];
let frameIdx = 0;
let playing = false;
let speed = 1;
let timer: number | null = null;
let tactician = false;
let editorOpen = false;

/** Оверлеи внутри редактора: модалка текста и словарь. */
let textOpen = false;
let vocabOpen = false;
let vocabFilter: ConceptCategory | null = null;
let editHero = run.heroes[0]!.id;
let aftermathOpen = false;

/** Экран перед боем: разведка и расстановка. */
let prepOpen = false;
/** Реплики характеров, раскрывшиеся в текущем бою, — для разбора после боя. */
let battleReveals: Reveal[] = [];
/** Оверлей «свиток боя» — полный лог решений. */
let logOpen = false;

/** Раскрытая строка свитка («почему так») — одновременно раскрыта одна. */
let logRow: number | null = null;
/** Карточка юнита (герой или враг) — по клику на фишку или имя в реестре. */
let unitCardId: string | null = null;
/** Вкладка правой страницы похода: строй или реестр павших (спека «Наш отряд»). */
let squadTab: 'party' | 'fallen' = 'party';
/** Вкладка карточки героя; дефолт — приёмы (спека карточки, вариант 3a). */
let cardTab: CardTab = 'moves';
/** Раскрытая строка приёмов — попап справа от карточки; null — свёрнут. */
let cardMove: string | null = null;
/** Приказы переписаны после показанного боя — «продолжить» требует переигровки. */
let ordersDirty = false;
let editError: Record<string, string> = {};
/** Пройденные узлы (для отрисовки карты). */
const visited = new Set<number>([run.at]);
/** Онбординг: после поражения в уроке предлагаем переписать приказ. */
let lessonNudge = false;
/** Герой, выбранный для перестановки на мини-поле расстановки. */
let deployPick: string | null = null;
let fitScale = 1;
/** Панель отладки: сборка конкретного боя. */
let debugOpen = false;
let debugError = '';
/** Черновик сборки; пустой слот — архетип ''. */
const debugDraft: {
  battle: string;
  seed: number;
  nerve: boolean;
  party: { archetypeId: string; lenses: LensId[] }[];
} = {
  battle: DEBUG_BATTLES[0]!.id,
  seed: 1,
  nerve: false,
  party: [],
};

// ---------- журнал плейтеста (Ворота B/C) ----------
// Копит замыслы словами (корпус Ворот C) и поведение тестера (спарринг,
// переписывание приказов — критерии Ворот B). Экспорт — кнопка «журнал плейтеста».

const JOURNAL_KEY = 'ps.journal';
let journal: JournalEvent[] = (() => {
  try {
    return JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? '[]') as JournalEvent[];
  } catch {
    return [];
  }
})();
function recordEvent(e: JournalEvent): void {
  journal = appendEvent(journal, e);
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
}
/** Боёв на текущем узле: повторный бой того же узла = спарринг. */
let fightsAtNode = 0;
/** Приказы переписаны между попытками текущего узла. */
let rewroteSinceBattle = false;
/** Замысел словами, введённый в редакторе (по герою). */
const heroIntent: Record<string, string> = {};
recordEvent({ t: 'run', seed: run.runSeed, ...(importedBuild?.ok === true ? { imported: true as const } : {}) });

// ---------- LLM-компилятор свободного текста (опционален: без ключа — конструктор) ----------
// Провайдер настраивается в .env: VITE_COMPILER_API_KEY (или VITE_ANTHROPIC_API_KEY),
// VITE_COMPILER_MODEL и VITE_COMPILER_BASE_URL — любой Anthropic-совместимый эндпоинт
// (напр. DeepSeek для отладки, claude-sonnet-5 по умолчанию для финала).

const ENV = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
const API_KEY: string | undefined = ENV.VITE_COMPILER_API_KEY ?? ENV.VITE_ANTHROPIC_API_KEY;
const COMPILER_MODEL: string | undefined = ENV.VITE_COMPILER_MODEL;
const COMPILER_BASE_URL: string | undefined = ENV.VITE_COMPILER_BASE_URL;

/**
 * Debug-режим (план линз): игроку характеры не показываются — он выучивает их
 * по бою; кнопка возвращает теги линз, подсказки, чипсы и полную карточку.
 */
let debugLenses = false;

/**
 * Свободный режим — тестовая кнопка: весь словарь открыт разом, не дожидаясь
 * трофеев и скриптория. Нужен, чтобы щупать новые слова и связки без забега;
 * обратно не выключается (закрыть слово, на котором уже написан принцип,
 * значило бы сломать приказы).
 */
const freeVocab = (): boolean =>
  (Object.keys(CONCEPTS) as ConceptId[]).every((c) => run.vocab.includes(c));
function unlockAllWords(): void {
  for (const c of Object.keys(CONCEPTS) as ConceptId[]) {
    if (!run.vocab.includes(c)) run.vocab.push(c);
  }
}

const heroText: Record<string, string> = {};
const heroUncertainty: Record<string, string[]> = {};
const compiling: Record<string, boolean> = {};

/** Кэш компиляций в localStorage (аналог .cache/ для браузера, без TTL). */
function localStorageCache(): CompilerCache {
  const LS_KEY = 'ps.compilerCache';
  const load = (): Record<string, CompilerOutput> => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Record<string, CompilerOutput>;
    } catch {
      return {};
    }
  };
  return {
    get: (k) => load()[k],
    set: (k, v) => {
      const data = load();
      data[k] = v;
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    },
  };
}
const compilerCache = localStorageCache();

let modelCall: ModelCall | null = null;
async function getModelCall(): Promise<ModelCall> {
  if (!modelCall) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({
      apiKey: API_KEY,
      dangerouslyAllowBrowser: true,
      ...(COMPILER_BASE_URL ? { baseURL: COMPILER_BASE_URL } : {}),
    });
    modelCall = anthropicModelCall(client, COMPILER_MODEL);
  }
  return modelCall;
}

async function compileHeroText(heroId: string): Promise<void> {
  const hero = run.heroes.find((h) => h.id === heroId);
  if (!hero || compiling[heroId]) return;
  compiling[heroId] = true;
  editError[heroId] = '';
  render();
  const r = await compileFreeText(
    {
      text: heroText[heroId] ?? '',
      heroId,
      heroName: hero.name,
      lenses: hero.lenses,
      vocab: run.vocab,
      allies: Object.fromEntries(
        run.heroes.filter((h) => h.alive && h.id !== heroId).map((h) => [h.id, h.name]),
      ),
      maxPhrases: hero.slots,
    },
    await getModelCall(),
    compilerCache,
  );
  compiling[heroId] = false;
  if ((heroText[heroId] ?? '').trim()) {
    recordEvent({
      t: 'freeText',
      hero: hero.name,
      lenses: hero.lenses,
      vocab: run.vocab.length,
      seed: run.runSeed,
      text: heroText[heroId]!,
      ok: r.ok,
      uncertain: r.ok ? r.uncertainty.length : 0,
    });
  }
  if (r.ok) {
    const res = applyPhrases(heroId, r.phrases);
    editError[heroId] = res.ok ? '' : res.error;
    heroUncertainty[heroId] = r.uncertainty;
    // текст хранится целиком — включая слова, которых герой не знает
    const set = hero.sets[hero.activeSet];
    if (set) set.text = heroText[heroId] ?? '';
    if (res.ok) textOpen = false;
  } else {
    editError[heroId] = r.error;
  }
  render();
}

// ---------- утилиты ----------

function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Значение в атрибут: сверх esc гасим кавычки — подпись комплекта пишет игрок. */
function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** setPhrases + пометка «показанный бой устарел». */
function applyPhrases(heroId: string, drafts: PhraseDraft[]): ReturnType<typeof setPhrases> {
  const r = setPhrases(run, heroId, drafts);
  if (r.ok && battle) ordersDirty = true;
  if (r.ok && fightsAtNode > 0) rewroteSinceBattle = true;
  return r;
}

// ---------- тексты ----------

/** Азбука видов узла (спека карты забега): типографика, не иконки. */
const NODE_GLYPH: Record<NodeKind, string> = {
  lesson: '✎',
  fight: '⚔',
  elite: '⚑',
  event: '?',
  rest: '☾',
  scriptorium: '✦',
  boss: '✝',
};

const NODE_RU: Record<NodeKind, string> = {
  lesson: 'урок',
  fight: 'бой',
  elite: 'элитка',
  event: 'событие',
  rest: 'привал',
  scriptorium: 'скрипторий',
  boss: 'босс',
};

const CAT_RU: Record<string, string> = {
  condition: 'условие',
  selector: 'селектор',
  action: 'действие',
  space: 'пространство',
};

/** Полевые названия узлов — только флейвор UI, детерминированы позицией узла. */
const NODE_TITLES: Record<NodeKind, string[]> = {
  lesson: ['Учебный плац у старой мельницы'],
  fight: ['Стычка у путевого камня', 'Узкий брод', 'Осыпь на склоне', 'Сожжённый хутор'],
  elite: ['Ватага вожака', 'Засада охотников'],
  event: ['Перекрёсток', 'Огонёк у дороги'],
  rest: ['Лагерь под акведуком'],
  scriptorium: ['Скрипторий сгоревшего аббатства', 'Торговец мёртвыми языками'],
  boss: ['Вождь орды'],
};

function nodeTitle(node: MapNode): string {
  const list = NODE_TITLES[node.kind];
  return list[node.id % list.length]!;
}

/** Ярлык героя: линзы через + («трус+мститель»). */
function lensTag(lenses: readonly LensId[]): string {
  return lenses.map((l) => LENS_RU[l]).join('+');
}

/** Тег линз в разметке — только в debug-режиме: характер скрыт, выучивается по бою. */
function lensTagHtml(lenses: readonly LensId[], cls = 'r-tag'): string {
  if (!debugLenses) return '';
  return `<span class="${cls}${lenses.includes('fanatic') ? ' fanatic' : ''}">${lensTag(lenses)}</span>`;
}

/** Ярлык класса героя («воин», «следопыт») — рядом с именем в карточках. */
function classTag(archetypeId: string): string {
  return `<span class="r-tag klass">${esc(heroArchetype(archetypeId).class)}</span>`;
}

/**
 * Строка параметров юнита: hp текущее/макс, оружие (урон/дальность — на нём,
 * план классов), инициатива, шаг. Шортхенд atk/range — для юнитов без спеки
 * оружия.
 */
function statLine(
  s: { maxHp: number; atk?: number; range?: number; weapons?: readonly WeaponSpec[]; speed: number; move: number },
  hp?: number,
): string {
  const hpTxt = hp === undefined ? `${s.maxHp}` : `${hp}/${s.maxHp}`;
  const arms = s.weapons?.length
    ? s.weapons.map((w) => `${w.name} ${w.dmg}/${w.range}`).join(' · ')
    : `удар ${s.atk} · даль ${s.range}`;
  return `hp ${hpTxt} · ${arms} · иниц ${s.speed} · шаг ${s.move}`;
}

/** Строка способности архетипа героя + его оружие. */
function abilityLine(archetypeId: string): string {
  const arch = heroArchetype(archetypeId);
  const a = arch.ability;
  // оружие видно всегда, даже до слова «накрыть скопление»: слово берут
  // осознанно, зная, есть ли в партии кому им махать
  const act = arch.active ? ` · актив: ${describeActive(arch.active)}` : '';
  const pas = arch.passives ? ` · ${describePassives(arch.passives)}` : '';
  // защиты своих (план damage-types) — тем же контрактом, что и разведка
  // врага: игрок сравнивает КБ и спасброски, выбирая, кого куда ставить
  const def = arch.defenses ? ` · защита: ${describeDefenses(arch.defenses)}` : '';
  const sh = arch.shield ? ` · ${describeShield(arch.shield)}` : '';
  const rc = arch.reaction ? ` · ${describeReaction(arch.reaction)}` : '';
  return `${a.name} — ${a.desc} · оружие: ${describeWeapons(arch.weapons)}${def}${sh}${rc}${act}${pas}`;
}

const LENS_HINT: Record<LensId, string> = {
  plain: 'обычный читает как написано — без вдохновения, без фантазий.',
  coward: 'трус превращает «прикрывать» в «стоять позади», а при трети hp бежит. Используй это нарочно.',
  fanatic: 'фанатик выбрасывает осторожные оговорки — «отступать» читает как «перебить всех».',
  literalist: 'буквалист не заполняет пробелов. Не оставляй пробелов.',
  avenger: 'мститель бросает всё ради того, кто его ударил.',
  duelist: 'дуэлянт слабых не добивает — вызывает сильнейшего; в спину не бьёт.',
  gloryhound: 'славолюб признаёт одну достойную цель — вожака.',
  guardian: 'наседка прикрывает самого раненого — даже без приказа.',
  paranoid: 'параноику везде мерещатся стрелки: на линию огня он не выйдет.',
  hothead: 'горячке невыносимо стоять на месте — «держать позицию» станет атакой.',
  showman: 'позёр красуется перед строем врага — приманка без приказа.',
  bully: 'задира бьёт слабейшего, а когда врагов больше — держится поодаль.',
  miser: 'скупец бережёт всё, что «раз в бой», пока бой не затянется.',
  gambler: 'азартный играет от счёта: в выигрыше скучает, в проигрыше идёт ва-банк.',
  martyr: 'мученик закрывает своих собой, а отступает — только прикрывая.',
  loner: 'одиночка не смыкает строй и никого не кроет щитом; один — дерётся злее.',
  scatterbrain: 'рассеянный забывает «если»: условные приказы исполняет всегда, но вполсилы.',
  stubborn: 'упрямец каждый бой считает одно из правил главным — какое, решает бой.',
  superstitious: 'суеверный первым делом идёт убивать колдуна, а проклятых мест не касается.',
};

/**
 * Подпись важности фразы. Вес игроку закрыт (спека редактора приказов):
 * видно только фокус — единственный рычаг приоритета в его руках.
 */
const WEIGHT_NOTE: Record<number, string> = { 1: '', 2: '', 3: ' (фокус)' };


/** Приказы героя как связный текст (до линзы — как написано). */
function ordersSentence(h: { phrases: PhraseDraft[] }): string {
  const names = heroNames(run);
  if (h.phrases.length === 0) return '';
  return h.phrases
    .map((d) => cap(describeDraft(d, names)) + WEIGHT_NOTE[Math.min(3, d.weight ?? 1)])
    .join('. ') + '.';
}

/** Строки «как понял» — приказы + способность, после линзы, тем же applyLens, что и бой. */
function readingLines(h: {
  id: string;
  archetypeId: string;
  name: string;
  lenses: LensId[];
  phrases: PhraseDraft[];
}): string[] {
  const names = heroNames(run);
  const rules = h.phrases
    .map((d) => compilePhrase(d, run.vocab, names))
    .filter((r): r is Extract<ReturnType<typeof compilePhrase>, { ok: true }> => r.ok)
    .map((r) => r.rule);
  return understandingCard(
    { name: h.name, lenses: h.lenses },
    [...rules, ...heroArchetype(h.archetypeId).innate],
    names,
    heroUncertainty[h.id] ?? [],
    debugLenses,
    // сид грядущего боя: упрямец выбирает «главное» правило по нему, и
    // карточка обязана показать тот же выбор, что сыграет бой
    { seed: battleSeed(run), unitId: h.id },
  ).lines;
}

function readNoteHtml(lines: string[], joined: boolean): string {
  const one = (l: string): string => {
    const warn = l.includes('⚠');
    const [text, mark] = warn ? [l.slice(0, l.indexOf('⚠')).trim(), l.slice(l.indexOf('⚠'))] : [l, ''];
    return `«${esc(text)}»${mark ? ` <span class="warn">${esc(mark)}</span>` : ''}`;
  };
  if (lines.length === 0) return `<div class="read-note">«Приказов нет. Буду импровизировать. Плохо.»</div>`;
  if (joined) return `<div class="read-note">${lines.map(one).join(' ')}</div>`;
  return lines.map((l) => `<div class="read-note">${one(l)}</div>`).join('');
}

// ---------- варианты фраз для селектов ----------

interface Opt<T> {
  value: T;
  label: string;
}

/**
 * Ссылки на своего для чипсов (план teamwork, вторая волна): живые товарищи
 * по именам плюс открытые роли. Роль в списке ровно одна на слово — кого она
 * назовёт, решает бой.
 */
function allyRefOptions(exceptId?: string, form: 'nom' | 'gen' | 'ins' = 'gen'): Opt<AllyRef>[] {
  const names = heroNames(run);
  const out: Opt<AllyRef>[] = run.heroes
    .filter((h) => h.alive && h.id !== exceptId)
    .map((h) => ({ value: h.id as AllyRef, label: names[h.id] ?? h.id }));
  for (const [role, word] of Object.entries(ROLE_CONCEPT) as [AllyRole, ConceptId][]) {
    if (run.vocab.includes(word)) out.push({ value: { role }, label: ALLY_ROLE_RU[role][form] });
  }
  return out;
}

function conditionOptions(): Opt<ConditionDraft>[] {
  const names = heroNames(run);
  const out: Opt<ConditionDraft>[] = [{ value: { id: 'always' }, label: 'всегда' }];
  const has = (c: ConceptId): boolean => run.vocab.includes(c);
  if (has('cond.hpBelow')) {
    out.push(
      { value: { id: 'cond.hpBelow', who: 'self', frac: 0.3 }, label: 'если моё hp < 30%' },
      { value: { id: 'cond.hpBelow', who: 'self', frac: 0.5 }, label: 'если моё hp < 50%' },
    );
    for (const a of allyRefOptions()) {
      out.push({ value: { id: 'cond.hpBelow', who: { ally: a.value }, frac: 0.5 }, label: `если hp ${a.label} < 50%` });
    }
  }
  if (has('cond.outnumbered')) out.push({ value: { id: 'cond.outnumbered' }, label: 'если врагов больше' });
  if (has('cond.allyInDanger')) {
    for (const a of allyRefOptions(undefined, 'nom')) {
      out.push({ value: { id: 'cond.allyInDanger', ally: a.value }, label: `если ${a.label} в опасности` });
    }
  }
  if (has('cond.hpAbove')) {
    out.push(
      { value: { id: 'cond.hpAbove', who: 'self', frac: 0.5 }, label: 'пока моё hp ≥ 50%' },
      { value: { id: 'cond.hpAbove', who: 'self', frac: 0.7 }, label: 'пока моё hp ≥ 70%' },
    );
  }
  if (has('cond.battleDrags')) out.push({ value: { id: 'cond.battleDrags' }, label: 'если бой затянулся' });
  if (has('cond.initiativeEdge')) out.push({ value: { id: 'cond.initiativeEdge' }, label: 'если мы быстрее' });
  if (has('cond.allyFallen')) out.push({ value: { id: 'cond.allyFallen' }, label: 'если кто-то из наших пал' });
  if (has('cond.surrounded')) out.push({ value: { id: 'cond.surrounded' }, label: 'если меня окружили' });
  if (has('cond.underCharge')) out.push({ value: { id: 'cond.underCharge' }, label: 'если враги накатывают' });
  if (has('cond.firstBlood')) out.push({ value: { id: 'cond.firstBlood' }, label: 'если кровь пролилась' });
  if (has('cond.leaderDown')) out.push({ value: { id: 'cond.leaderDown' }, label: 'если вожак врага пал' });
  if (has('cond.wasHit')) out.push({ value: { id: 'cond.wasHit' }, label: 'если меня ударили' });
  if (has('cond.enemyAdjacent')) out.push({ value: { id: 'cond.enemyAdjacent' }, label: 'если враг вплотную' });
  if (has('cond.allyAdjacent')) out.push({ value: { id: 'cond.allyAdjacent' }, label: 'если союзник рядом' });
  if (has('cond.alone')) out.push({ value: { id: 'cond.alone' }, label: 'если я в отрыве' });
  if (has('cond.weOutnumber')) out.push({ value: { id: 'cond.weOutnumber' }, label: 'если нас больше' });
  if (has('cond.enemyShooters')) out.push({ value: { id: 'cond.enemyShooters' }, label: 'если у врага стрелки' });
  if (has('cond.enemyCasters')) out.push({ value: { id: 'cond.enemyCasters' }, label: 'если у врага заклинатель' });
  if (has('cond.enemyWavering')) out.push({ value: { id: 'cond.enemyWavering' }, label: 'если враг дрогнул' });
  if (has('cond.lastEnemy')) out.push({ value: { id: 'cond.lastEnemy' }, label: 'если враг остался один' });
  if (has('cond.allyHurt')) out.push({ value: { id: 'cond.allyHurt' }, label: 'если кто-то из наших ранен' });
  if (has('cond.enemiesClustered')) out.push({ value: { id: 'cond.enemiesClustered' }, label: 'если враги скучились' });
  if (has('cond.allyTaunting')) out.push({ value: { id: 'cond.allyTaunting' }, label: 'если наш держит вызов' });
  if (has('cond.allyEngaged')) out.push({ value: { id: 'cond.allyEngaged' }, label: 'если наш в контакте' });
  if (has('cond.guarded')) out.push({ value: { id: 'cond.guarded' }, label: 'если меня прикрывают' });
  if (has('cond.allySurrounded')) out.push({ value: { id: 'cond.allySurrounded' }, label: 'если нашего обступили' });
  if (has('cond.alliesFocusing')) out.push({ value: { id: 'cond.alliesFocusing' }, label: 'если наши навалились' });
  if (has('cond.spreadThin')) out.push({ value: { id: 'cond.spreadThin' }, label: 'если мы растянулись' });
  if (has('cond.lull')) out.push({ value: { id: 'cond.lull' }, label: 'пока затишье' });
  if (has('cond.onHighGround')) out.push({ value: { id: 'cond.onHighGround' }, label: 'пока я на высоте' });
  if (has('cond.cornered')) out.push({ value: { id: 'cond.cornered' }, label: 'если меня прижали' });
  if (has('cond.inFormation')) out.push({ value: { id: 'cond.inFormation' }, label: 'пока строй сомкнут' });
  if (has('cond.inZone')) out.push({ value: { id: 'cond.inZone' }, label: 'пока я на рубеже' });
  if (has('cond.enemyInZone')) out.push({ value: { id: 'cond.enemyInZone' }, label: 'если враг на рубеже' });
  if (has('cond.timeShort')) out.push({ value: { id: 'cond.timeShort' }, label: 'если время на исходе' });
  if (has('cond.prizeHeld')) out.push({ value: { id: 'cond.prizeHeld' }, label: 'пока трофей у наших' });
  return out;
}

/**
 * Варианты для вложенных уровней условия (глубокие чипсы): те же условия,
 * «всегда» читается как пустое звено; союз («и»/«или») несёт чипс на стыке.
 */
function moreConditionOptions(): Opt<ConditionDraft>[] {
  return conditionOptions().map((o) =>
    o.value.id === 'always' ? { value: o.value, label: '— всё —' } : o,
  );
}

function preferenceOptions(heroId: string): Opt<PreferenceDraft>[] {
  const names = heroNames(run);
  const out: Opt<PreferenceDraft>[] = [];
  const has = (c: ConceptId): boolean => run.vocab.includes(c);
  const selectors = (
    [
      'sel.nearest',
      'sel.weakest',
      'sel.leader',
      'sel.mostDangerous',
      'sel.attacker',
      'sel.marked',
      'sel.shooter',
      'sel.farthest',
      'sel.strongest',
      'sel.fastest',
      'sel.healer',
      'sel.caster',
      'sel.straggler',
      'sel.tormentor',
      'sel.heckler',
      'sel.unengaged',
      'sel.intruder',
    ] as const
  ).filter(has);
  const selRu: Record<string, string> = {
    'sel.nearest': 'ближайшего',
    'sel.weakest': 'слабейшего',
    'sel.leader': 'вожака',
    'sel.mostDangerous': 'самого опасного',
    'sel.attacker': 'того, кто атаковал меня',
    'sel.marked': 'помеченного',
    'sel.shooter': 'стрелка',
    'sel.farthest': 'самого дальнего',
    'sel.strongest': 'самого здорового',
    'sel.fastest': 'самого быстрого',
    'sel.healer': 'вражеского лекаря',
    'sel.caster': 'вражеского заклинателя',
    'sel.straggler': 'отбившегося',
    'sel.tormentor': 'обидчика наших',
    'sel.heckler': 'вражеского крикуна',
    'sel.unengaged': 'свободного врага',
    'sel.intruder': 'прорывающегося',
  };
  if (has('act.attack')) {
    for (const s of selectors) out.push({ value: { id: 'act.attack', target: s }, label: `атаковать ${selRu[s]}` });
  }
  if (has('act.protect')) {
    for (const a of allyRefOptions(heroId)) {
      out.push({ value: { id: 'act.protect', ally: a.value }, label: `защищать ${a.label}` });
    }
  }
  if (has('act.taunt')) out.push({ value: { id: 'act.taunt' }, label: 'вызывать на себя' });
  if (has('act.lure')) {
    for (const a of allyRefOptions(heroId)) {
      out.push({ value: { id: 'act.lure', ally: a.value }, label: `уводить врагов от ${a.label}` });
    }
  }
  if (has('act.screen')) {
    for (const a of allyRefOptions(heroId)) {
      out.push({ value: { id: 'act.screen', ally: a.value }, label: `заслонять ${a.label} от стрелков` });
    }
  }
  if (has('act.swap')) {
    for (const a of allyRefOptions(heroId, 'ins')) {
      out.push({ value: { id: 'act.swap', ally: a.value }, label: `меняться местами с ${a.label}` });
    }
  }
  if (has('act.regroup')) out.push({ value: { id: 'act.regroup' }, label: 'смыкать строй' });
  if (has('act.mark')) out.push({ value: { id: 'act.mark' }, label: 'метить цель ударами' });
  if (has('space.fallback')) out.push({ value: { id: 'space.fallback' }, label: 'отходить за спины своих' });
  if (has('space.clearLine')) out.push({ value: { id: 'space.clearLine' }, label: 'не застить своим стрелкам' });
  if (has('act.pin')) out.push({ value: { id: 'act.pin' }, label: 'связывать врагов боем' });
  if (has('space.holdLine')) out.push({ value: { id: 'space.holdLine' }, label: 'держать рубеж' });
  if (has('act.evacuate')) out.push({ value: { id: 'act.evacuate' }, label: 'уходить к выходу' });
  if (has('act.carry')) out.push({ value: { id: 'act.carry' }, label: 'нести трофей' });
  if (has('act.holdPosition')) out.push({ value: { id: 'act.holdPosition' }, label: 'держать позицию' });
  if (has('act.wait')) out.push({ value: { id: 'act.wait' }, label: 'ждать' });
  if (has('act.retreat')) out.push({ value: { id: 'act.retreat' }, label: 'отступать' });
  if (has('act.bait')) out.push({ value: { id: 'act.bait' }, label: 'изображать приманку' });
  if (has('act.trade')) out.push({ value: { id: 'act.trade' }, label: 'идти на размен' });
  if (has('act.coverRetreat')) out.push({ value: { id: 'act.coverRetreat' }, label: 'прикрывать отход' });
  if (has('act.standoff')) out.push({ value: { id: 'act.standoff' }, label: 'держать дистанцию' });
  if (has('space.flank')) out.push({ value: { id: 'space.flank' }, label: 'заходить во фланг' });
  if (has('space.lineOfFire')) out.push({ value: { id: 'space.lineOfFire' }, label: 'держаться вне линии огня' });
  if (has('space.chokepoint')) out.push({ value: { id: 'space.chokepoint' }, label: 'вставать в узком месте' });
  if (has('space.highGround')) out.push({ value: { id: 'space.highGround' }, label: 'держать высоту' });
  if (has('space.behindCover')) out.push({ value: { id: 'space.behindCover' }, label: 'держаться за укрытием' });
  if (has('space.avoidHazard')) out.push({ value: { id: 'space.avoidHazard' }, label: 'обходить опасное' });
  if (has('space.roughEdge')) out.push({ value: { id: 'space.roughEdge' }, label: 'стеречь кромку' });
  if (has('space.outflank')) out.push({ value: { id: 'space.outflank' }, label: 'обходить из-за спин' });
  if (has('act.shove')) out.push({ value: { id: 'act.shove' }, label: 'толкать' });
  if (has('space.spread')) out.push({ value: { id: 'space.spread' }, label: 'держать интервал' });
  if (has('act.barrage')) out.push({ value: { id: 'act.barrage' }, label: 'накрыть скопление' });
  if (has('act.preempt')) out.push({ value: { id: 'act.preempt' }, label: 'бить на упреждение' });
  if (has('act.castRitual')) out.push({ value: { id: 'act.castRitual' }, label: 'замахиваться ритуалом' });
  if (has('act.rage')) out.push({ value: { id: 'act.rage' }, label: 'впасть в ярость' });
  if (has('act.heal')) out.push({ value: { id: 'act.heal' }, label: 'лечить раненых' });
  if (has('act.bless')) out.push({ value: { id: 'act.bless' }, label: 'благословлять' });
  if (has('act.feint')) out.push({ value: { id: 'act.feint' }, label: 'финтить' });
  if (has('act.finish')) out.push({ value: { id: 'act.finish' }, label: 'добивать' });
  if (has('act.focusFire')) out.push({ value: { id: 'act.focusFire' }, label: 'бить туда же' });
  if (has('act.brace')) out.push({ value: { id: 'act.brace' }, label: 'вставать в глухую оборону' });
  if (has('act.strikeOften')) out.push({ value: { id: 'act.strikeOften' }, label: 'бить часто' });
  if (has('act.strikeHard')) out.push({ value: { id: 'act.strikeHard' }, label: 'бить наверняка' });
  if (has('act.strikeDesperate')) out.push({ value: { id: 'act.strikeDesperate' }, label: 'бить отчаянно' });
  for (const space of ['space.nearTo', 'space.behind', 'space.awayFrom'] as const) {
    if (!has(space)) continue;
    const verb =
      space === 'space.nearTo'
        ? 'держаться рядом с'
        : space === 'space.behind'
          ? 'держаться позади'
          : 'держаться подальше от';
    for (const a of allyRefOptions(heroId, space === 'space.nearTo' ? 'ins' : 'gen')) {
      out.push({ value: { id: space, ref: { ally: a.value } }, label: `${verb} ${a.label}` });
    }
    for (const s of selectors) {
      out.push({ value: { id: space, ref: { enemy: s } }, label: `${verb}: враг-${selRu[s]}` });
    }
  }
  return out;
}

function selectHtml<T>(cls: string, hero: string, idx: number, opts: Opt<T>[], current: T, attrs = ''): string {
  const cur = canon(current);
  const options = opts
    .map((o) => {
      const v = canon(o.value);
      return `<option value='${esc(v)}' ${v === cur ? 'selected' : ''}>${esc(o.label)}</option>`;
    })
    .join('');
  return `<select class="${cls}" data-hero="${hero}" data-idx="${idx}"${attrs ? ` ${attrs}` : ''}>${options}</select>`;
}

// ---------- кадры боя (по одному решению за кадр) ----------

interface FrameUnit {
  id: string;
  name: string;
  side: Side;
  leader: boolean;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  alive: boolean;
  /** Действующее прикрытие — значок на фишке до начала своего хода: прикрытие / глухая оборона / прикрыт союзником. */
  cover?: 'half' | 'full' | 'ally' | 'shield';
  /** Кто держит чужой щит (`cover: 'ally'`) — значок жив, только пока он жив и смежен. */
  coverBy?: string;
  /** Что на юните тлеет (план damage-types, волна 6) — подпись значка: «огонь», «яд», «кровь». */
  smolder?: string;
}

/** Мгновенный эффект кадра: всплывающий текст над клеткой или вспышка задетых клеток. */
type FxTone = 'dmg' | 'heal' | 'buff' | 'info';
type Fx =
  | { kind: 'float'; x: number; y: number; text: string; tone: FxTone }
  | { kind: 'cells'; cells: { x: number; y: number }[]; form: 'blast' | 'line' | 'ritual' | 'hit' };

interface Frame {
  round: number;
  actorId: string;
  actorName: string;
  /** Цена решения в очках хода: 0 — реакция или ожидание (ромб ◇). */
  cost: number;
  text: string;
  factors: { label: string; value: number }[];
  units: FrameUnit[];
  /** Центры висящих зон замаха (5×5) — от телеграфа до залпа или смерти кастера. */
  zones: { x: number; y: number }[];
  /** Анимации кадра — проигрываются один раз при его показе. */
  fx: Fx[];
  callout?: string;
}

/** Размер клетки поля в процентах — позиции фишек и камней. */
const CELL = 100 / GRID_W;

const cellName = (x: number, y: number): string => String.fromCharCode(97 + x) + (GRID_H - y);

/** Раскрытая в бою реплика характера — для колаута и разбора после боя. */
interface Reveal {
  unit: string;
  name: string;
  side: Side;
  lens: LensId;
  quip: string;
  /** Кадр, в котором характер проговорился: до него линза в карточке скрыта. */
  frame: number;
  /** Слово игрока, которое прочли по-своему (нет у дрейфа). */
  source?: string;
  /** Что из слова получилось на деле. */
  reading?: string;
  /** Раунд боя — для разбора: «Лия, раунд 4». */
  round?: number;
  /** Защёлкнувшийся дрейф характера, а не разовое искажение слова. */
  drift?: true;
}

function buildFrames(
  result: BattleResult,
  leaderIds: Set<string>,
  specs: readonly UnitSpec[],
  names: Record<string, string>,
  seed: number,
): { frames: Frame[]; reveals: Reveal[] } {
  const units = new Map<string, FrameUnit>();
  const nm = (id: string): string => units.get(id)?.name ?? id;
  // Значок чужого щита пересчитывается на каждом кадре, а не гасится событием:
  // прикрытие живо, только пока щитоносец жив и смежен (та же проверка в момент
  // чтения, что у `effectiveGuard` в бою). Без пересчёта значок висел до
  // следующего хода прикрытого — и щит читался как работающий через полполя
  const snap = (): FrameUnit[] =>
    [...units.values()].map((u) => {
      const c = { ...u };
      if (c.cover === 'ally') {
        const by = c.coverBy !== undefined ? units.get(c.coverBy) : undefined;
        if (!by?.alive || Math.max(Math.abs(by.x - c.x), Math.abs(by.y - c.y)) > 1) {
          c.cover = undefined;
          c.coverBy = undefined;
        }
      }
      return c;
    });
  // висящие зоны замаха по кастерам: от телеграфа до залпа или смерти кастера
  const activeZones = new Map<string, { x: number; y: number }>();
  const out: Frame[] = [];
  let round = 0;
  let pending:
    | { actorId: string; cost: number; factors: Frame['factors']; parts: string[]; fx: Fx[]; callout?: string }
    | null = null;
  // всплывающий текст над юнитом (его текущая клетка) — попадает в кадр pending
  const float = (unitId: string, text: string, tone: FxTone): void => {
    const u = units.get(unitId);
    if (u) pending?.fx.push({ kind: 'float', x: u.x, y: u.y, text, tone });
  };
  // клетки зоны радиуса r вокруг центра (Чебышёв), в границах поля
  const cellsAround = (c: { x: number; y: number }, r: number): { x: number; y: number }[] => {
    const cells: { x: number; y: number }[] = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = c.x + dx;
        const y = c.y + dy;
        if (x >= 0 && y >= 0 && x < GRID_W && y < GRID_H) cells.push({ x, y });
      }
    }
    return cells;
  };
  const blocked = (p: { x: number; y: number }): boolean => result.terrain.tiles[p.y]?.[p.x]?.blocked === true;
  // длина волны клинка по спекам — для подсветки клеток взмаха
  const lineLenByUnit = new Map<string, number>();
  for (const s of specs) {
    const len = s.aoe?.line?.len ?? s.weapons?.find((w) => w.aoe?.line)?.aoe?.line?.len;
    if (len) lineLenByUnit.set(s.id, len);
  }

  // искажённые линзами правила по юнитам: source → правила с пометками
  // (расщепление даёт на фразу пару правил с разными условиями); реплика
  // раскрывается при первом срабатывании (правило вошло в топ-факторы)
  const twistedByUnit = new Map<string, Map<string, Rule[]>>();
  const lensesByUnit = new Map<string, readonly LensId[]>();
  for (const s of specs) {
    lensesByUnit.set(s.id, s.lenses);
    const bySource = new Map<string, Rule[]>();
    for (const r of applyLens(s.lenses, s.rules, { seed, unitId: s.id }).rules) {
      if (!r.marks?.length) continue;
      bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
    }
    if (bySource.size) twistedByUnit.set(s.id, bySource);
  }
  // условие правила против состояния кадра: различает честную и ситуационную
  // половины расщеплённой фразы (у них общий source в лейбле фактора);
  // неизвестные условия считаем истинными — реплика лучше молчания
  const condHolds = (cond: Rule['when'], selfId: string, round: number): boolean => {
    const all = [...units.values()];
    const self = units.get(selfId);
    if (!self) return true;
    switch (cond.kind) {
      case 'hpBelow':
      case 'hpAbove': {
        // роль вместо имени (план teamwork): кого она назовёт, знает только
        // бой — в эвристике реплик считаем условие истинным, как и неизвестные
        const who = cond.who;
        if (who !== 'self' && typeof who.ally !== 'string') return true;
        const u = who === 'self' ? self : all.find((x) => x.id === who.ally);
        if (!u || !u.alive) return false;
        return cond.kind === 'hpBelow' ? u.hp < cond.frac * u.maxHp : u.hp >= cond.frac * u.maxHp;
      }
      case 'outnumbered':
        return (
          all.filter((x) => x.alive && x.side !== self.side).length >
          all.filter((x) => x.alive && x.side === self.side).length
        );
      case 'battleDrags':
        return round >= BATTLE_DRAGS_ROUND;
      default:
        return true;
    }
  };
  const revealed = new Set<string>();
  const reveals: Reveal[] = [];
  const reveal = (unitId: string, lens: LensId, quip: string, rule?: Rule): void => {
    const u = units.get(unitId)!;
    reveals.push({
      unit: unitId,
      name: u.name,
      side: u.side,
      lens,
      quip,
      frame: out.length,
      round,
      ...(rule ? { source: rule.source, reading: ruleRu(rule, names) } : {}),
    });
    if (pending && pending.callout === undefined) pending.callout = `${u.name}: «${quip}»`;
  };

  const flush = (): void => {
    if (!pending) return;
    out.push({
      round,
      actorId: pending.actorId,
      actorName: nm(pending.actorId),
      cost: pending.cost,
      text: pending.parts.length ? pending.parts.join(', ') : 'медлит',
      factors: pending.factors,
      units: snap(),
      zones: [...activeZones.values()].map((z) => ({ ...z })),
      fx: pending.fx,
      ...(pending.callout !== undefined ? { callout: pending.callout } : {}),
    });
    pending = null;
  };

  for (const e of result.events as BattleEvent[]) {
    switch (e.t) {
      case 'spawn':
        units.set(e.unit, {
          id: e.unit,
          name: e.name,
          side: e.side,
          leader: leaderIds.has(e.unit),
          hp: e.maxHp,
          maxHp: e.maxHp,
          x: e.pos.x,
          y: e.pos.y,
          alive: true,
        });
        break;
      case 'round':
        flush();
        round = e.n;
        break;
      case 'decision': {
        flush();
        pending = { actorId: e.unit, cost: AP_COST[e.action] ?? 1, factors: e.factors, parts: [], fx: [] };
        // начало своего хода: действие прикрытия и щит союзника истекают
        if (e.ap === AP_PER_TURN) {
          const u = units.get(e.unit);
          if (u) u.cover = undefined;
        }
        // раскрытие характера: искажённое правило впервые вошло в топ-факторы
        const twisted = twistedByUnit.get(e.unit);
        for (const f of e.factors) {
          if (!twisted || !f.label.startsWith('правило:')) continue;
          const rs = twisted.get(f.label.slice('правило:'.length));
          // из правил фразы говорит активная сейчас половина (поздняя — ситуационная)
          const r = rs
            ?.slice()
            .reverse()
            .find((x) => condHolds(x.when, e.unit, round));
          const key = r && `${e.unit}:${r.source}:${JSON.stringify(r.when)}`;
          if (!r || !key || revealed.has(key)) continue;
          revealed.add(key);
          // из нескольких пометок озвучиваем последнее переписывание смысла;
          // сдвиг веса — только если смысл никто не тронул
          const marks = r.marks!;
          const mark = marks.filter((m) => m.kind === 'reword' || m.kind === 'recondition').at(-1) ?? marks.at(-1)!;
          reveal(e.unit, mark.lens, lensQuip(mark, names, r), r);
          break; // одна реплика на кадр
        }
        // достройка пропусков: ни одно правило не сработало — герой решает сам
        if (e.firedCount === 0 && !revealed.has(`${e.unit}:gap`)) {
          revealed.add(`${e.unit}:gap`);
          const literalist = lensesByUnit.get(e.unit)?.includes('literalist') ?? false;
          reveal(
            e.unit,
            literalist ? 'literalist' : 'plain',
            literalist ? 'Правила на это нет. Стою и защищаюсь.' : 'Приказов на такое нет — решаю сам.',
          );
        }
        break;
      }
      case 'move': {
        const u = units.get(e.unit)!;
        u.x = e.to.x;
        u.y = e.to.y;
        pending?.parts.push(`перешёл в ${cellName(e.to.x, e.to.y)}`);
        break;
      }
      case 'attack': {
        const t = units.get(e.target)!;
        t.hp = e.targetHp;
        // приём кита (план weapon-moves) читается по имени; дефолт — по манере
        const verb = e.move
          ? `бьёт («${e.move}»)`
          : e.action === 'weakAttack' ? 'бьёт слабо' : e.action === 'selflessAttack' ? 'бьёт отчаянно' : 'бьёт';
        // штраф за повтор (MAP, план action-economy): без подписи второй
        // промах за ход выглядит невезением, а он — цена третьего удара
        const rep = e.map ? ` (повтор −${e.map})` : '';
        // исход броска и защиты цели (план damage-types): промах обязан
        // читаться промахом, иначе игрок спишет его на свою формулировку
        if (e.outcome === 'miss') {
          pending?.parts.push(`${verb} ${nm(e.target)} — мимо${rep}`);
          float(e.target, 'мимо', 'info');
          break;
        }
        const soak =
          e.soak === 'immune' ? ' (не берёт)'
          : e.soak === 'resist' ? ' (броня)'
          : e.soak === 'weak' ? ' (в слабое место)'
          : '';
        const crit = e.outcome === 'crit' ? ' ✸' : '';
        pending?.parts.push(`${verb} ${nm(e.target)}: −${e.dmg}${e.flank ? ' (фланг)' : ''}${soak}${crit}${rep}`);
        pending?.fx.push({ kind: 'cells', cells: [{ x: t.x, y: t.y }], form: 'hit' });
        float(e.target, `−${e.dmg}${e.flank ? ' ⚑' : ''}${crit}`, 'dmg');
        break;
      }
      case 'hazard': {
        const u = units.get(e.unit)!;
        u.hp = e.hp;
        pending?.parts.push(`${e.kind === 'spikes' ? 'напоролся на шипы' : 'обожжён'}: −${e.dmg}`);
        float(e.unit, `−${e.dmg}`, 'dmg');
        break;
      }
      case 'swap': {
        // обмен местами: двигаются оба, кадр один — приём читается как жест
        const u = units.get(e.unit)!;
        const t = units.get(e.target)!;
        u.x = e.to.x;
        u.y = e.to.y;
        t.x = e.from.x;
        t.y = e.from.y;
        pending?.parts.push(`меняется местами с ${nm(e.target)}`);
        float(e.target, '⇄ местами', 'buff');
        break;
      }
      case 'shove': {
        const t = units.get(e.target)!;
        t.x = e.to.x;
        t.y = e.to.y;
        pending?.parts.push(`толкает ${nm(e.target)} в ${cellName(e.to.x, e.to.y)}`);
        float(e.target, 'толчок', 'info');
        break;
      }
      case 'telegraph':
        activeZones.set(e.unit, { x: e.at.x, y: e.at.y });
        pending?.parts.push(`начинает замах: накроет 5×5 у ${cellName(e.at.x, e.at.y)}`);
        break;
      case 'aoeCast':
        if (e.form === 'ritual') {
          // залп ритуала бьёт в начале хода кастера, до его решения — свой кадр;
          // «полымя» (holds) держит зону до последнего пульса
          flush();
          pending = { actorId: e.unit, cost: 0, factors: [], parts: [`ритуал обрушивается на ${cellName(e.at.x, e.at.y)}`], fx: [] };
          pending.fx.push({ kind: 'cells', cells: cellsAround(e.at, AOE_RITUAL_RADIUS), form: 'ritual' });
          if (!e.holds) activeZones.delete(e.unit);
        } else if (e.form === 'line') {
          pending?.parts.push(`рубит волной в сторону ${cellName(e.at.x, e.at.y)}`);
          // клетки взмаха — та же геометрия, что у castVictims: от кастера в сторону at
          const c = units.get(e.unit);
          if (c) {
            const dir = { x: Math.sign(e.at.x - c.x), y: Math.sign(e.at.y - c.y) };
            const cells = lineCells({ x: c.x, y: c.y }, dir, lineLenByUnit.get(e.unit) ?? 0, blocked);
            pending?.fx.push({ kind: 'cells', cells, form: 'line' });
          }
        } else {
          pending?.parts.push(`накрывает залпом ${cellName(e.at.x, e.at.y)}`);
          pending?.fx.push({ kind: 'cells', cells: cellsAround(e.at, AOE_BLAST_RADIUS), form: 'blast' });
        }
        break;
      case 'aoeHit': {
        const u = units.get(e.unit)!;
        u.hp = e.hp;
        // спасбросок жертвы (план damage-types) — почему числа у накрытых разные
        const save =
          e.save === 'critSuccess' ? ' (увернулся)'
          : e.save === 'success' ? ' (вполсилы)'
          : e.save === 'critFail' ? ' (накрыло вдвое)'
          : '';
        pending?.parts.push(`${nm(e.unit)} накрыт: −${e.dmg}${save}`);
        float(e.unit, e.dmg === 0 ? 'мимо' : `−${e.dmg}`, e.dmg === 0 ? 'info' : 'dmg');
        break;
      }
      case 'die': {
        units.get(e.unit)!.alive = false;
        units.get(e.unit)!.cover = undefined;
        units.get(e.unit)!.smolder = undefined;
        activeZones.delete(e.unit); // зона умирает вместе с кастером
        pending?.parts.push(`${nm(e.unit)} падает`);
        float(e.unit, '✝', 'info');
        break;
      }
      // задачи боя (план objectives, волна 2): уход с поля и судьба трофея
      case 'flee': {
        units.get(e.unit)!.alive = false;
        pending?.parts.push(`${nm(e.unit)} уходит с поля`);
        float(e.unit, 'ушёл', 'info');
        break;
      }
      case 'pickup':
        pending?.parts.push(`${nm(e.unit)} поднимает трофей`);
        float(e.unit, 'трофей!', 'buff');
        break;
      case 'drop':
        pending?.parts.push(`${nm(e.unit)} роняет трофей`);
        float(e.unit, 'ноша пала', 'info');
        break;
      case 'rage':
        pending?.parts.push('впадает в ярость');
        float(e.unit, 'ярость!', 'buff');
        break;
      case 'mark':
        pending?.parts.push(`метит ${nm(e.target)}`);
        float(e.target, '◎ метка', 'info');
        break;
      case 'heal': {
        const u = units.get(e.target)!;
        u.hp = e.hp;
        pending?.parts.push(`исцеляет ${nm(e.target)}: +${e.amount}`);
        float(e.target, `+${e.amount}`, 'heal');
        break;
      }
      case 'regen': {
        // зарастание случается до первого решения хода — свой кадр, как у ритуала
        flush();
        units.get(e.unit)!.hp = e.hp;
        pending = {
          actorId: e.unit,
          cost: 0,
          factors: [],
          parts: [e.quenched ? 'не зарастает: огонь не даёт' : `зарастает: +${e.amount}`],
          fx: [],
        };
        float(e.unit, e.quenched ? 'не зарастает' : `+${e.amount}`, e.quenched ? 'info' : 'heal');
        break;
      }
      // длящийся урон (план damage-types, волна 6): занялся, тикает, погас
      case 'persistStart':
        units.get(e.target)!.smolder = persistRu(e.dmgType);
        pending?.parts.push(`${nm(e.target)}: ${persistRu(e.dmgType)} (−${e.dmg} в конце хода)`);
        float(e.target, `${persistRu(e.dmgType)}!`, 'dmg');
        break;
      case 'persist': {
        // тик приходит в конце хода жертвы — своим кадром, как зарастание
        flush();
        units.get(e.unit)!.hp = e.hp;
        pending = {
          actorId: e.unit,
          cost: 0,
          factors: [],
          parts: [`${persistRu(e.dmgType)}: −${e.dmg}`],
          fx: [],
        };
        float(e.unit, `−${e.dmg} ${persistRu(e.dmgType)}`, 'dmg');
        break;
      }
      case 'persistEnd':
        units.get(e.unit)!.smolder = undefined;
        pending?.parts.push(`${persistRu(e.dmgType)} сходит на нет${e.assisted ? ' (помогли)' : ''}`);
        float(e.unit, `${persistRu(e.dmgType)} унят`, 'buff');
        break;
      case 'douse':
        pending?.parts.push(
          e.unit === e.target ? 'сбивает с себя пламя' : `сбивает пламя с ${nm(e.target)}`,
        );
        float(e.target, 'сбить пламя', 'buff');
        break;
      case 'moodShift': {
        // сдвиг характера — свой кадр с репликой; попадает и в разбор после боя
        flush();
        const quip = driftQuip(e.lens);
        const u = units.get(e.unit)!;
        reveals.push({ unit: e.unit, name: u.name, side: u.side, lens: e.lens, quip, frame: out.length, round, drift: true });
        pending = { actorId: e.unit, cost: 0, factors: [], parts: [`«${quip}»`], fx: [], callout: `${u.name}: «${quip}»` };
        break;
      }
      case 'bless':
        pending?.parts.push(`благословляет ${nm(e.target)} (урон ×${e.mult})`);
        float(e.target, 'благословение', 'buff');
        break;
      case 'feint':
        pending?.parts.push(`финтит: ${nm(e.target)} открыт`);
        float(e.target, 'открыт!', 'dmg');
        break;
      case 'intercept':
        pending?.parts.push(`${nm(e.unit)} принимает удар, предназначенный ${nm(e.target)}`);
        float(e.unit, 'перехват!', 'buff');
        break;
      case 'riposte': {
        const u = units.get(e.unit)!;
        u.hp = e.hp;
        pending?.parts.push(`напарывается на рипост ${nm(e.by)}: −${e.dmg}`);
        float(e.unit, `−${e.dmg} рипост`, 'dmg');
        break;
      }
      case 'reactGuard':
        pending?.parts.push(`${nm(e.unit)} встречает удар: ${REACTION_RU[e.kind]} (+${e.ac} к КБ)`);
        float(e.unit, REACTION_RU[e.kind], 'buff');
        break;
      case 'reactHeal': {
        const ally = units.get(e.target)!;
        ally.hp = e.hp;
        pending?.parts.push(`${nm(e.unit)} заступается — ${nm(e.target)}: +${e.amount}`);
        float(e.target, `+${e.amount}`, 'heal');
        break;
      }
      case 'reactStep': {
        const chaser = units.get(e.unit)!;
        chaser.x = e.to.x;
        chaser.y = e.to.y;
        pending?.parts.push(`${nm(e.unit)} шагает следом — ${nm(e.target)} не уйдёт`);
        float(e.unit, 'не уйдёшь', 'buff');
        break;
      }
      case 'reactStrike': {
        // ответный удар случается в чужой ход, поэтому строка называет обоих:
        // без имени бьющего игрок читает её как урон из ниоткуда
        const victim = units.get(e.target)!;
        victim.hp = e.targetHp;
        pending?.parts.push(
          e.dmg === 0
            ? `${nm(e.unit)} бьёт вслед — ${nm(e.target)}: мимо`
            : `${nm(e.unit)} бьёт вслед уходящему — ${nm(e.target)}: −${e.dmg}`,
        );
        float(e.target, e.dmg === 0 ? 'вслед — мимо' : `−${e.dmg} вслед`, e.dmg === 0 ? 'buff' : 'dmg');
        break;
      }
      case 'shieldBlock':
        // строка идёт в запись ходящего (это его удар), поэтому называем того,
        // кто закрылся, — иначе читается «Тесса держит удар Тессы»
        pending?.parts.push(`${nm(e.unit)} принимает удар на щит: −${e.absorbed}`);
        float(e.unit, `⛨ −${e.absorbed}`, 'buff');
        break;
      case 'shieldBreak': {
        pending?.parts.push(`щит ${nm(e.unit)} разваливается`);
        float(e.unit, 'щит сломан', 'dmg');
        const u = units.get(e.unit);
        if (u && u.cover === 'half') u.cover = undefined;
        break;
      }
      case 'cover': {
        pending?.parts.push(
          e.ally
            ? `прикрыл ${nm(e.ally)} (+${e.bonus} к КБ)`
            : e.from === 'raiseShield'
              ? `поднимает щит (+${e.bonus} к КБ)`
              : `прикрылся (+${e.bonus} к КБ)`,
        );
        if (e.ally) {
          const a = units.get(e.ally);
          // щит союзника не понижает уже взятую глухую оборону
          if (a && a.cover !== 'full') {
            a.cover = 'ally';
            a.coverBy = e.unit;
          }
          float(e.ally, '⛨ прикрыт', 'buff');
        } else {
          const u = units.get(e.unit);
          const full = e.bonus >= BRACE_AC;
          const shield = e.from === 'raiseShield';
          if (u) u.cover = full ? 'full' : shield ? 'shield' : 'half';
          float(e.unit, full ? '⛨ глухая оборона' : shield ? '⛨ щит поднят' : '⛨ прикрытие', 'buff');
        }
        break;
      }
      case 'wait':
        pending?.parts.push('выжидает');
        break;
      case 'end':
        flush();
        break;
    }
  }
  flush();
  // стартовый кадр смещаем в начало: юниты расставлены, приказы скомпилированы
  const first: Frame = {
    round: 0,
    actorId: '',
    actorName: '',
    cost: 0,
    text: '',
    factors: [],
    units: out.length ? out[0]!.units.map((u) => ({ ...u, hp: u.maxHp, alive: true })) : snap(),
    zones: [],
    fx: [],
    callout: 'приказы скомпилированы — дальше арифметика',
  };
  // позиции стартового кадра — из событий spawn, а не первого решения
  const spawned = new Map<string, FrameUnit>();
  for (const e of result.events) {
    if (e.t === 'spawn') {
      spawned.set(e.unit, {
        id: e.unit,
        name: e.name,
        side: e.side,
        leader: leaderIds.has(e.unit),
        hp: e.maxHp,
        maxHp: e.maxHp,
        x: e.pos.x,
        y: e.pos.y,
        alive: true,
      });
    }
  }
  first.units = [...spawned.values()];
  return { frames: [first, ...out], reveals };
}

function glyphOf(name: string): string {
  const digit = /(\d+)\s*$/.exec(name)?.[1] ?? '';
  return name.charAt(0) + digit;
}

// ---------- бой: запуск и воспроизведение ----------

const FIGHT_KINDS: NodeKind[] = ['lesson', 'fight', 'elite', 'boss'];

function startBattle(): void {
  const node = currentNode(run);
  if (!FIGHT_KINDS.includes(node.kind) || run.resolved || run.status !== 'ongoing') return;
  // foeSpecs — с применённой меткой: бой на экране и бой в забеге (playFight) — один бой
  const foes = foeSpecs(run);
  const leaderIds = new Set(foes.filter((f) => f.tags?.includes('leader')).map((f) => f.id));
  const scenario = scenarioForNode(node);
  // NPC сценария (обоз, чтец, старейшина) — тем же порядком, что в playFight
  const specs = [...heroSpecs(run), ...(scenario?.allies?.() ?? []), ...foes];
  battle = runBattle(battleSeed(run), specs, arenaForNode(node), scenario?.setup);
  recordEvent({
    t: 'battle',
    node: node.kind,
    sparring: fightsAtNode > 0,
    rewritten: rewroteSinceBattle,
    won: battle.winner === 'party',
    rounds: battle.rounds,
  });
  fightsAtNode++;
  rewroteSinceBattle = false;
  deployPick = null;
  ({ frames, reveals: battleReveals } = buildFrames(battle, leaderIds, specs, heroNames(run), battleSeed(run)));
  frameIdx = 0;
  playing = true;
  aftermathOpen = false;
  editorOpen = false;
  logOpen = false;
  unitCardId = null;
  ordersDirty = false;
  prepOpen = false;
  render();
  runTimer();
}

function runTimer(): void {
  stopTimer();
  timer = window.setInterval(() => {
    if (!playing) return;
    if (frameIdx >= frames.length - 1) {
      stopTimer();
      playing = false;
      aftermathOpen = true;
      render();
      return;
    }
    frameIdx++;
    syncBattleFrame();
  }, 820 / speed);
}

function acceptOutcome(): void {
  if (!battle || ordersDirty) return;
  stopTimer();
  const node = currentNode(run);
  const lost = battle.winner !== 'party';
  playFight(run);
  if (run.status !== 'ongoing') recordEvent({ t: 'end', won: run.status === 'won' });
  lessonNudge = node.kind === 'lesson' && lost;
  // проигранный урок не кончает узел — возвращаемся туда, где приказ переписывают
  prepOpen = run.status === 'ongoing' && !run.resolved;
  battle = null;
  frames = [];
  aftermathOpen = false;
  logOpen = false;
  unitCardId = null;
  render();
}

// ---------- правая страница: наш отряд ----------

/** hp героя в текущем кадре боя (если бой идёт) или из забега. */
function heroHpNow(heroId: string): { hp: number; maxHp: number; alive: boolean } | null {
  const hero = run.heroes.find((h) => h.id === heroId)!;
  if (battle && frames[frameIdx]) {
    const u = frames[frameIdx]!.units.find((u) => u.id === heroId);
    if (u) return { hp: Math.max(0, u.hp), maxHp: u.maxHp, alive: u.alive };
    return null;
  }
  return hero.alive ? { hp: hero.hp, maxHp: hero.stats.maxHp, alive: true } : null;
}

/** Быстрый доступ на карточке героя: лист открывается сразу на своей вкладке. */
const HERO_JUMPS: [CardTab, string, string][] = [
  ['about', '§', 'описание'],
  ['moves', '⚔', 'действия'],
  ['bag', '◎', 'инвентарь'],
];

/** Карточка героя: кнопка героя · быстрый доступ · полоска действующего набора. */
function squadCardHtml(h: HeroState): string {
  const live = heroHpNow(h.id);
  const hp = live ?? { hp: h.hp, maxHp: h.stats.maxHp };
  const low = hp.hp / hp.maxHp <= 0.35;
  const pct = Math.round((100 * Math.max(0, hp.hp)) / hp.maxHp);
  const jumps = HERO_JUMPS.map(
    ([tab, glyph, label]) => `<button class="sq-jump" data-action="unit-card" data-unit="${h.id}"
      data-card-tab="${tab}" title="лист героя · ${label}"><span class="g">${glyph}</span>${label}</button>`,
  ).join('');
  const set = h.sets[h.activeSet]!;
  const tabs = h.sets
    .map((s, i) => {
      const cls = i === h.activeSet ? 'on' : s.phrases.length === 0 ? 'empty' : '';
      const title =
        i === h.activeSet
          ? `комплект ${ORDER_SETS[i]} действует · двойной клик — правка`
          : s.phrases.length === 0
            ? `комплект ${ORDER_SETS[i]} пуст — приказов в нём нет`
            : `перейти на комплект ${ORDER_SETS[i]} · ${s.phrases.length} прик.`;
      return `<button class="sq-set ${cls}" data-action="switch-set" data-hero="${h.id}" data-set="${i}"
        title="${title}">${ORDER_SETS[i]}</button>`;
    })
    .join('');
  return `<div class="sq-card">
    <button class="sq-hero" data-action="unit-card" data-unit="${h.id}" title="лист героя">
      <span class="sq-col">
        <span class="sq-name-row">
          <span class="sq-name">${esc(h.name)}</span>
          ${classTag(h.archetypeId)}
        </span>
        <span class="sq-hp-row">
          <span class="sq-hp${low ? ' low' : ''}">hp ${hp.hp}/${hp.maxHp}</span>
          <span class="sq-bar"><span style="width:${pct}%" class="${low ? 'low' : ''}"></span></span>
          <span class="sq-slots">приказов ${h.phrases.length}/${h.slots}</span>
        </span>
      </span>
      <span class="sq-chev">›</span>
    </button>
    <div class="sq-jumps">${jumps}</div>
    <div class="sq-strip" data-action="edit-set" data-hero="${h.id}" title="клик по полоске — правка приказов">
      <span class="sq-col">
        <span class="kicker">набор ${ORDER_SETS[h.activeSet]} · ${set.phrases.length} прик.</span>
        <span class="sq-note">«${esc(set.note.trim() || 'без подписи')}»</span>
      </span>
      <span class="sq-sets">${tabs}</span>
    </div>
  </div>`;
}

/** Где герой пал: вид узла, слой и задача сценария — читаются по карте. */
function fallenWhere(nodeId: number): string {
  const node = run.map[nodeId];
  if (!node) return '';
  const scenario = scenarioForNode(node);
  return `${NODE_RU[node.kind]}, слой ${node.layer + 1}${scenario ? ` — «${scenario.title}»` : ''}`;
}

/** Реестр павших: пермасмерть, места не освобождают — наёмник встаёт в тот же слот. */
function fallenHtml(): string {
  const rows = run.fallen
    .map((f) => {
      const where = fallenWhere(f.node);
      return `<div class="fl-row">
        <span class="fl-cross">✝</span>
        <span class="fl-body">
          <span class="fl-head">
            <span class="fl-name">${esc(f.name)}</span>
            ${classTag(f.archetypeId)}
            <span class="fl-set">набор: ${ORDER_SETS[f.set]}${f.setNote.trim() ? ` «${esc(f.setNote.trim())}»` : ''}</span>
          </span>
          ${where ? `<span class="fl-where">где: ${esc(where)}</span>` : ''}
        </span>
      </div>`;
    })
    .join('');
  return `<div class="fallen">
    <span class="kicker">павшие товарищи · пермасмерть, места не освобождают</span>
    ${rows}
    <span class="flavor">Их наборы остаются в книге: наёмник прочтёт тот же текст по-своему.</span>
  </div>`;
}

/** Вкладки «в строю / павшие»; пока павших нет — вкладки одной не бывает. */
function squadTabsHtml(alive: number): string {
  if (run.fallen.length === 0) return '';
  const tab = (t: 'party' | 'fallen', label: string): string =>
    `<button class="sq-tab ${squadTab === t ? 'on' : ''}" data-action="squad-tab" data-tab="${t}">${label}</button>`;
  return `<div class="sq-tabs">${tab('party', `в строю ${alive}`)}${tab('fallen', `павшие ${run.fallen.length}`)}</div>`;
}

/** Правая страница похода: кто у меня есть и чем он сейчас играет. */
function squadHtml(): string {
  const alive = run.heroes.filter((h) => h.alive);
  const onFallen = squadTab === 'fallen' && run.fallen.length > 0;
  return `<div class="page-head">
      <span class="title">Наш отряд</span>
      <button class="linkish" data-action="export-build">экспорт билда</button>
    </div>
    ${squadTabsHtml(alive.length)}
    ${onFallen ? fallenHtml() : `<div class="squad">${alive.map(squadCardHtml).join('')}</div>`}
    <div class="foot sq-foot">
      <span>клик по полоске набора — правка приказов; A/B/C — просто переключить.</span>
      <span class="flavor">Те же кости, тот же исход, каждый раз.</span>
    </div>`;
}

// ---------- экран: карта похода ----------

/** Состояние клетки тропы — читается фоном и рамкой, без значков внутри (спека карты). */
type TrailState = 'here' | 'done' | 'open' | 'far';

const TRAIL_STATE_RU: Record<TrailState, string> = {
  here: 'ты здесь',
  done: 'пройден',
  open: 'доступен',
  far: 'дальше по тропе',
};

/** Узлы, куда есть дорога прямо сейчас — из рёбер текущего узла, а не из отдельного списка. */
function openNodeIds(): Set<number> {
  const canGo = run.status === 'ongoing' && run.resolved && !run.pendingReward;
  return new Set(canGo ? currentNode(run).next : []);
}

function trailStateOf(n: MapNode, open: Set<number>): TrailState {
  if (n.id === run.at) return 'here';
  if (visited.has(n.id)) return 'done';
  if (open.has(n.id)) return 'open';
  return 'far';
}

/** Тропа: слои — колонки, узлы — клетки на сквозной полосочке. */
function trailHtml(): string {
  const open = openNodeIds();
  const layers: MapNode[][] = [];
  for (const n of run.map) (layers[n.layer] ??= []).push(n);
  const cols = layers
    .map((nodes) => {
      const cells = [...nodes]
        .sort((a, b) => a.slot - b.slot)
        .map((n) => {
          const st = trailStateOf(n, open);
          return `<div class="tnode ${st}${n.id === pickedId() ? ' sel' : ''}"
            data-action="pick-node" data-node="${n.id}" title="${NODE_RU[n.kind]} — ${TRAIL_STATE_RU[st]}">
            <span class="g">${NODE_GLYPH[n.kind]}</span>
            <span class="k">${NODE_RU[n.kind]}</span>
          </div>`;
        })
        .join('');
      return `<div class="t-col">${cells}</div>`;
    })
    .join('');
  return `<div class="trail">${cols}</div>`;
}

function trailLegendHtml(): string {
  const sw = (st: TrailState): string => `<span class="t-leg"><i class="sw ${st}"></i>${TRAIL_STATE_RU[st]}</span>`;
  return `<div class="t-legend">
    ${sw('done')}${sw('here')}${sw('open')}${sw('far')}
    <span class="t-glyphs">${Object.entries(NODE_GLYPH)
      .map(([k, g]) => `${g} ${NODE_RU[k as NodeKind]}`)
      .join(' · ')}</span>
  </div>`;
}

/** Чипсы состояния забега в шапке тропы. */
function runChipsHtml(): string {
  const alive = run.heroes.filter((h) => h.alive).length;
  return `<span class="run-chips">
    <span class="chip ink">слов ${run.vocab.length}</span>
    <span class="chip line">фокусы ${FOCUS_BUDGET - focusUsed(run)} из ${FOCUS_BUDGET}</span>
    <span class="chip red">отряд ${alive} жив${alive === 1 ? '' : 'ы'}</span>
  </span>`;
}

/** Дедлайн задачи узла в раундах — если сценарий его ставит. */
function nodeDeadline(node: MapNode): number | null {
  const o = scenarioForNode(node)?.setup.objective;
  if (!o) return null;
  if (o.kind === 'killBefore') return o.round;
  if (o.kind === 'survive' || o.kind === 'holdZone') return o.rounds;
  if (o.kind === 'protect') return o.rounds ?? null;
  return null;
}

/** «что даст» — награда узла словами; пулы трофеев живут в run.ts. */
function nodeReward(node: MapNode): string {
  switch (node.kind) {
    case 'lesson':
      return 'пара обычных слов или одно редкое — первое настоящее решение забега';
    case 'fight':
      return 'три обычных слова на выбор — шире речь, а не глубже';
    case 'elite':
      return 'три редких слова на выбор — то, что меняет язык';
    case 'scriptorium':
      return 'слово в словарь либо +1 слот приказов герою — берут одно';
    case 'rest':
      return 'лечение всему отряду';
    case 'event':
      return 'встреча: слово, слот или наёмник взамен павшего';
    case 'boss':
      return 'забег пройден';
  }
}

/** «чем грозит» — настоящая цена этого узла в этом забеге, одной строкой. */
function nodeRisk(node: MapNode): string {
  const parts: string[] = [];
  const deadline = nodeDeadline(node);
  if (deadline) parts.push(`дедлайн ${deadline} раундов`);
  if (node.kind === 'lesson') {
    parts.push('проиграть можно бесплатно: урок только учит');
  } else if (FIGHT_KINDS.includes(node.kind)) {
    const hurt = [...run.heroes]
      .filter((h) => h.alive && h.hp < h.stats.maxHp)
      .sort((a, b) => a.hp / a.stats.maxHp - b.hp / b.stats.maxHp)[0];
    if (hurt) parts.push(`${hurt.name} входит с ${hurt.hp}/${hurt.stats.maxHp}`);
    const fallen = run.heroes.filter((h) => !h.alive).length;
    if (fallen) parts.push(`отряд неполон: павших ${fallen}`);
    if (node.kind === 'boss') parts.push('второй попытки не будет');
    if (parts.length === 0) parts.push('ран не лечат до привала');
  } else if (node.kind === 'rest') {
    parts.push('вместо слова — здоровье; выбор без второго шанса');
  } else if (node.kind === 'scriptorium') {
    parts.push('ничем — но и раны не залечит');
  } else {
    parts.push('за встречу платят временем, а не кровью');
  }
  return parts.join(' · ');
}

/** Описание узла: задача боя видна всегда — честная часть разведки. */
function nodeDesc(node: MapNode): string {
  const scenario = scenarioForNode(node);
  if (FIGHT_KINDS.includes(node.kind)) return scenario ? scenario.brief : 'Перебей всех — задача без оговорок.';
  switch (node.kind) {
    case 'scriptorium':
      return 'Полка чужих наставлений: слово в словарь или лишний слот приказа. Берут одно.';
    case 'rest':
      return 'Костёр, тишина, иголка с ниткой. Живые восстановят большую часть здоровья.';
    default:
      return 'Встреча на дороге: книжник, тайник или наёмник у костра.';
  }
}

/** «кто ждёт» — состав врагов заранее только там, где интел даёт код. */
function foeIntelHtml(node: MapNode): string {
  if (!FIGHT_KINDS.includes(node.kind)) return '';
  if (!intelVisible(node)) {
    return `<div class="nc-hidden">кто ждёт — неизвестно: интел дают только урок, элитка и босс</div>`;
  }
  const chips = foesForNode(node)
    .map((f) => `<span class="chip red">${esc(f.name)} ${f.maxHp}</span>`)
    .join('');
  return `<div class="nc-block">
    <span class="kicker">кто ждёт · известно заранее</span>
    <div class="chips">${chips}</div>
  </div>`;
}

/** Узел, чья карточка открыта: клик по тропе, по умолчанию — текущий. */
let mapPick: number | null = null;

function pickedId(): number {
  return mapPick !== null && run.map[mapPick] ? mapPick : run.at;
}

/** Действия текущего узла: трофей, бой, событие, привал. */
function nodeActionsHtml(node: MapNode): string {
  if (run.status !== 'ongoing') return '';
  if (run.pendingReward) {
    const items = run.pendingReward
      .map((option, i) => {
        const words = option
          .map(
            (c) => `<span class="s-title">${esc(CONCEPTS[c].label)}</span>
            <span class="s-desc">${CAT_RU[CONCEPTS[c].category]} — новое слово для приказов</span>`,
          )
          .join('');
        return `<button class="shop-item" data-action="reward-take" data-index="${i}">
          <span style="flex:1;display:flex;flex-direction:column;gap:3px">${words}</span>
          <span class="s-cost">${option.length > 1 ? 'взять оба' : 'взять'}</span>
        </button>`;
      })
      .join('');
    return `<div class="nc-block">
      <span class="kicker">трофей боя · в обозе врага обрывки чужих наставлений</span>
      <div class="shop">${items}</div>
      <div class="btn-row"><button data-action="reward-skip">оставить на поле</button></div>
    </div>`;
  }
  if (run.resolved) {
    return `<div class="nc-note">узел пройден — выбери на тропе, куда идти дальше</div>`;
  }
  if (FIGHT_KINDS.includes(node.kind)) {
    return `<div class="btn-row"><button class="primary" data-action="prep">⚔ выступить</button>
      <button data-action="open-editor">переписать приказы</button></div>`;
  }
  if (node.kind === 'event') {
    const offer = eventOffer(run);
    const names = heroNames(run);
    const parts: string[] = [];
    if (offer.concept) {
      parts.push(`<div class="nc-desc">Странствующий книжник готов растолковать концепт
        «${CONCEPTS[offer.concept].label}» — задаром, из любви к слову.</div>
        <div class="btn-row"><button class="primary" data-action="event-take">изучить</button></div>`);
    } else if (offer.slotHero) {
      parts.push(`<div class="nc-desc">В тайнике — чистый лист для полевого дневника:
        +1 слот приказа для ${names[offer.slotHero]}.</div>
        <div class="btn-row"><button class="primary" data-action="event-take">забрать</button></div>`);
    }
    if (offer.mercenary) {
      parts.push(`<div class="nc-desc">У костра сидит наёмник ${esc(offer.mercenary.name)}${
        debugLenses ? ` [${lensTag(offer.mercenary.lenses)}]` : ''
      } — займёт место павшего, но прежние принципы прочтёт по-своему.</div>
        <div class="btn-row"><button data-action="event-hire">нанять</button></div>`);
    }
    return `${parts.join('')}<div class="btn-row"><button data-action="event-skip">пройти мимо</button></div>`;
  }
  if (node.kind === 'rest') {
    return `<div class="btn-row"><button class="primary" data-action="rest">отдохнуть</button>
      <button data-action="open-editor">переписать приказы</button></div>`;
  }
  return '';
}

/** Карточка узла: что это, кто ждёт, что даст, чем грозит — и дорога туда. */
function nodeCardHtml(): string {
  const node = run.map[pickedId()]!;
  const open = openNodeIds();
  const state = trailStateOf(node, open);
  const here = node.id === run.at;
  const accent = node.kind === 'lesson' || node.kind === 'elite' || node.kind === 'boss' ? 'red' : 'ink';
  const scenario = scenarioForNode(node);
  const task = scenario
    ? `<div class="task-line"><span class="kicker">задача боя</span><b>⚑ ${esc(scenario.title)}</b></div>`
    : '';
  const go = here
    ? nodeActionsHtml(node)
    : open.has(node.id)
      ? `<div class="btn-row"><button class="primary" data-action="go-node" data-node="${node.id}">идти сюда</button></div>`
      : `<div class="nc-note">туда дороги нет с этого узла</div>`;
  return `<div class="node-card acc-${accent}">
    <div class="nc-head">
      <span class="nc-title">${NODE_GLYPH[node.kind]} ${esc(cap(NODE_RU[node.kind]))}</span>
      <span class="nc-place">${esc(nodeTitle(node))}</span>
      <span class="nc-state">${TRAIL_STATE_RU[state]}</span>
    </div>
    <div class="nc-body">
      ${task}
      <div class="nc-desc">${esc(nodeDesc(node))}</div>
      ${foeIntelHtml(node)}
      <div class="nc-block">
        <span class="kicker">что даст</span>
        <span class="nc-serif">${esc(nodeReward(node))}</span>
      </div>
      <div class="nc-block">
        <span class="kicker">чем грозит</span>
        <span class="nc-risk">${esc(nodeRisk(node))}</span>
      </div>
      ${go}
    </div>
  </div>`;
}

/** Кнопка теста «свободный режим» — на карте и в редакторе приказов. */
function freeVocabBtnHtml(): string {
  const on = freeVocab();
  return `<button class="linkish" data-action="free-vocab" ${on ? 'disabled' : ''}
    title="тест: открыть все слова словаря разом">${
      on ? 'свободный режим: весь словарь открыт' : 'свободный режим'
    }</button>`;
}

function mapScreenHtml(): string {
  return `<div class="spread">
    <div class="page-l">
      <div class="page-head">
        <span class="title">Тропа</span>
        <span class="meta">слой ${currentNode(run).layer + 1} из ${
          run.map[run.map.length - 1]!.layer + 1
        } · seed ${run.runSeed}</span>
        ${runChipsHtml()}
      </div>
      ${trailHtml()}
      ${trailLegendHtml()}
      ${nodeCardHtml()}
      <div class="foot">
        <button class="linkish" data-action="toggle-debug">${debugLenses ? 'debug: скрыть характеры' : 'debug'}</button>
        <button class="linkish" data-action="open-debug" title="отладка: любой сценарий, партия и характеры">собрать бой</button>
        <button class="linkish" data-action="toggle-nerve" title="нерв: под давлением бойцы взвешивают решение неровно">${
          run.nerve ? 'нерв: вкл' : 'нерв: выкл'
        }</button>
        ${freeVocabBtnHtml()}
        <button class="linkish" data-action="export-journal">журнал плейтеста</button>
      </div>
    </div>
    <div class="gutter"></div>
    <div class="page-r">${squadHtml()}</div>
  </div>`;
}

// ---------- экран: перед боем (разведка + расстановка) ----------

/** Ромбы очков: ◆ доступное, ◇ истраченное — та же азбука, что цена приёмов. */
function pipsHtml(left: number, total: number): string {
  return `<span class="pips">${'◆'.repeat(Math.max(0, left))}${'◇'.repeat(Math.max(0, total - left))}</span>`;
}

/** Числа врага (покупка «◆ числа»): hp, КБ, слабейший спасбросок, реакция. */
function foeNumbersLine(f: UnitSpec): string {
  const d = f.defenses;
  const saves: [SaveKind, number][] = [
    ['fort', d?.fort ?? DEFAULT_SAVE],
    ['ref', d?.ref ?? DEFAULT_SAVE],
    ['will', d?.will ?? DEFAULT_SAVE],
  ];
  const weakest = saves.sort((a, b) => a[1] - b[1])[0]!;
  const parts = [`hp ${f.maxHp}`, `КБ ${d?.ac ?? DEFAULT_AC}`, `${SAVE_RU[weakest[0]]} ${weakest[1]}`];
  if (f.reaction) parts.push(`◇ ${REACTION_RU[f.reaction]}`);
  return parts.join(' · ');
}

/** Приказы врага строками (покупка «◆ приказы») — уже с его характером. */
function foeOrdersLines(f: UnitSpec): string[] {
  return applyLens(f.lenses, f.rules).rules.map((r) =>
    r.marks?.some((m) => m.kind === 'reword' || m.kind === 'recondition') ? `${r.source} → ${ruleRu(r)}` : r.source,
  );
}

/** Поле перед боем: зона расстановки видна всегда, восток — под туманом до покупки карты. */
function prepFieldHtml(node: MapNode): string {
  const layout = pickTerrain(battleSeed(run), arenaForNode(node));
  const open = run.intel.map;
  // сценарий с фикс-спавнами (разбитый лагерь): расстановка не в руках игрока
  const fixedSpawns = Boolean(scenarioForNode(node)?.heroSpawns);
  const zoneW = PARTY_ZONE_MAX_X + 1;
  const cells: string[] = [];
  if (!fixedSpawns) {
    for (let y = 0; y < layout.tiles.length; y++) {
      for (let x = 0; x <= PARTY_ZONE_MAX_X; x++) {
        if (layout.tiles[y]![x]!.blocked) continue;
        cells.push(
          `<div class="dcell" data-action="deploy-cell" data-x="${x}" data-y="${y}" style="left:${x * CELL}%;top:${y * CELL}%"></div>`,
        );
      }
    }
  }
  const heroTokens = run.heroes
    .filter((h) => h.alive)
    .map((h) => {
      const p = deployedSpawn(run, h);
      const set = Boolean(run.deploy[h.id]);
      const pick = fixedSpawns ? '' : ` data-action="deploy-pick" data-hero="${h.id}"`;
      return `<div class="btoken${deployPick === h.id ? ' pick' : ''}${set ? '' : ' ghost'}"${pick}
        style="left:${p.x * CELL}%;top:${p.y * CELL}%"><span class="dm"><span>${esc(glyphOf(h.name))}</span></span></div>`;
    })
    .join('');
  let foeTokens = '';
  if (open) {
    // тот же сид и порядок спеков, что у боя, — превью совпадает с ареной
    const foes = foeSpecs(run);
    const names = new Map(foes.map((f) => [f.id, f.name]));
    foeTokens = spawnPreview(battleSeed(run), [...heroSpecs(run), ...foes])
      .filter((u) => names.has(u.id))
      .map(
        (u) => `<div class="btoken foe" style="left:${u.pos.x * CELL}%;top:${u.pos.y * CELL}%">
          <span class="dm"><span>${esc(glyphOf(names.get(u.id)!))}</span></span></div>`,
      )
      .join('');
  }
  const fog = open
    ? ''
    : `<div class="fog" style="left:${zoneW * CELL}%;width:${(GRID_W - zoneW) * CELL}%"><span>туман войны</span></div>`;
  const note = open
    ? `<b>${esc(layout.name)}</b> — ${esc(layout.scenario)}`
    : 'видна только зона расстановки';
  const hint = fixedSpawns
    ? 'лагерь разбит: расстановка не в ваших руках'
    : deployPick
      ? 'поставь на клетку зоны'
      : 'расстановка: герой → клетка';
  return `<div class="prep-field">
    <div class="pf-head">
      <span class="kicker">поле</span>
      <span class="pf-meta">${GRID_W}×${GRID_H} · ${open ? 'открыто' : 'под туманом'}</span>
    </div>
    <div class="bfield mini" style="--cell:${CELL}%">
      <div class="dzone" style="width:${zoneW * CELL}%"></div>
      ${tilesLayerHtml(layout.tiles, open ? GRID_W - 1 : PARTY_ZONE_MAX_X)}
      ${fixedSpawns ? '' : cells.join('')}${foeTokens}${heroTokens}${fog}
    </div>
    <div class="pf-foot">
      <span class="pf-note">${note}</span>
      ${
        open
          ? ''
          : `<button class="buy" data-action="buy-intel" data-buy="map" ${
              run.intel.points > 0 ? '' : 'disabled'
            } title="карта даёт рельеф, расстановку врагов и полный состав">◆ открыть карту</button>`
      }
    </div>
    <span class="kicker">${hint}</span>
  </div>`;
}

/** Отряд врага: имена открыты всегда, числа и приказы — за очки. */
function prepFoesHtml(): string {
  const rows = visibleFoes(run)
    .map((f) => {
      const hasNumbers = run.intel.numbers.includes(f.id);
      const hasOrders = run.intel.orders.includes(f.id);
      const spent = run.intel.points <= 0;
      const marked = run.marked === f.id;
      const canMark = run.vocab.includes('sel.marked');
      const buy = (kind: 'numbers' | 'orders', label: string): string =>
        `<button class="buy" data-action="buy-intel" data-buy="${kind}" data-foe="${f.id}" ${
          spent ? 'disabled' : ''
        }>◆ ${label}</button>`;
      const orders = hasOrders
        ? `<div class="fo-orders">${foeOrdersLines(f)
            .map((l) => `<span><i>·</i>${esc(l)}</span>`)
            .join('')}</div>`
        : '';
      return `<div class="fo-row">
        <div class="fo-head">
          <span class="fo-mark${marked ? ' on' : ''}" ${
            canMark ? `data-action="mark-foe" data-foe="${f.id}" title="метка: правила «атаковать помеченного» целятся в него"` : ''
          }>◎</span>
          <span class="fo-name">${esc(f.name)}</span>
          <span class="fo-buys">
            ${hasNumbers ? `<span class="chip ink">${esc(foeNumbersLine(f))}</span>` : buy('numbers', 'числа')}
            ${hasOrders ? '' : buy('orders', 'приказы')}
          </span>
        </div>
        ${orders}
      </div>`;
    })
    .join('');
  const tail = foesKnown(run)
    ? ''
    : `<div class="fo-rest"><span>?</span>кто-то ещё за камнями — карта покажет, сколько их всего</div>`;
  return `<div class="prep-foes">${rows}${tail}</div>`;
}

/** Расстановка: кто уже стоит на поле и с каким текстом идёт. */
function prepPartyHtml(node: MapNode): string {
  const fixedSpawns = Boolean(scenarioForNode(node)?.heroSpawns);
  const rows = run.heroes
    .filter((h) => h.alive)
    .map((h) => {
      const set = Boolean(run.deploy[h.id]);
      const orders = ordersSentence(h);
      return `<div class="pp-row${deployPick === h.id ? ' pick' : ''}" ${
        fixedSpawns ? '' : `data-action="deploy-pick" data-hero="${h.id}"`
      }>
        <span class="pp-who">
          <span class="pp-name">${esc(h.name)}</span>
          <span class="pp-class">${esc(heroArchetype(h.archetypeId).class)}</span>
        </span>
        <span class="pp-orders">${orders ? esc(orders) : '— приказов нет —'}</span>
        <span class="pp-sets">${h.sets
          .map(
            (os, i) =>
              `<button class="set-tab ${
                i === h.activeSet ? 'on' : os.phrases.length === 0 ? 'empty' : ''
              }" data-action="switch-set" data-hero="${h.id}" data-set="${i}" ${
                os.phrases.length === 0 ? 'disabled title="пустой комплект — сперва напиши приказ в редакторе"' : ''
              }>${ORDER_SETS[i]}</button>`,
          )
          .join('')}</span>
        <span class="pp-state">${fixedSpawns ? 'по сценарию' : set ? 'встал сам' : 'по умолчанию'}</span>
      </div>`;
    })
    .join('');
  return `<div class="prep-party">
    <span class="kicker">кто с каким комплектом идёт</span>
    ${rows}
  </div>`;
}

function prepScreenHtml(): string {
  const node = currentNode(run);
  const scenario = scenarioForNode(node);
  const intel = run.intel;
  const hint = !foesKnown(run)
    ? 'состав отряда неполон — карта покажет, сколько их всего'
    : intel.points > 0
      ? 'осталось решить, чьи числа важнее чьих приказов'
      : 'остальное придётся выяснять телом';
  const task = scenario
    ? `<div class="task-line"><span class="kicker">задача боя · открыта всегда</span>
        <b>⚑ ${esc(scenario.title)}</b><br>${esc(scenario.brief)}</div>`
    : `<div class="task-line"><span class="kicker">задача боя · открыта всегда</span>
        <b>⚑ ${esc(cap(NODE_RU[node.kind]))}</b><br>Перебей всех — задача без оговорок.</div>`;
  const nudge = lessonNudge
    ? `<div class="onboarding">Первый приказ почти никогда не выигрывает этот бой — так задумано.
       В дневник вписано новое слово: «держать дистанцию».
       Перепиши принципы под то, что видно в разведке, и переиграй: <b>кости те же</b>.</div>`
    : '';
  return `<div class="spread">
    <div class="page-l">
      <div class="page-head">
        <span class="title">Разведка</span>
        <span class="meta">перед выступлением</span>
        <span class="pips-line"><span class="kicker">очки разведки</span>${pipsHtml(
          intel.points,
          INTEL_POINTS,
        )}</span>
      </div>
      ${task}
      ${prepFieldHtml(node)}
      ${nudge}
      <div class="foot">
        <button class="linkish" data-action="back-to-map">← к тропе</button>
        <span class="spacer"></span>
        <span class="prep-hint">${esc(hint)}</span>
      </div>
    </div>
    <div class="gutter"></div>
    <div class="page-r">
      <div class="page-head">
        <span class="title">Противник</span>
        <span class="meta">${
          foesKnown(run) ? `врагов ${foeSpecs(run).length}` : 'врагов ? — состав неполон'
        } · числа и приказы за очки</span>
      </div>
      <div class="prep-cols">
        ${prepFoesHtml()}
        ${prepPartyHtml(node)}
      </div>
      <div class="btn-row">
        <button class="primary grow" data-action="fight">⚔ выступить</button>
        <button data-action="open-editor">переписать приказы</button>
        ${
          node.kind === 'lesson'
            ? `<button class="linkish" data-action="skip-lesson"
                 title="забрать трофей урока и начать забег, не играя учебный бой">пропустить урок</button>`
            : ''
        }
      </div>
    </div>
  </div>`;
}

// ---------- экран: скрипторий ----------

function scriptoriumHtml(): string {
  const node = currentNode(run);
  const offer = scriptoriumOffer(run);
  const names = heroNames(run);
  const items = offer.concepts
    .map(
      (c) => `<button class="shop-item" data-action="buy-concept" data-concept="${c}">
        <span style="flex:1;display:flex;flex-direction:column;gap:3px">
          <span class="s-title">${esc(CONCEPTS[c].label)}</span>
          <span class="s-desc">${CAT_RU[CONCEPTS[c].category]} — фраза, которую раньше нельзя было сказать</span>
        </span>
        <span class="s-cost">выбрать</span>
      </button>`,
    )
    .join('');
  const slotItem = offer.slotHero
    ? `<button class="shop-item" data-action="buy-slot" data-hero="${offer.slotHero}">
        <span style="flex:1;display:flex;flex-direction:column;gap:3px">
          <span class="s-title">Ещё один слот — для ${esc(names[offer.slotHero]!)}</span>
          <span class="s-desc">больше места для приказов — и больше способов быть неверно понятым</span>
        </span>
        <span class="s-cost">выбрать</span>
      </button>`
    : '';
  const vocabRows = Object.values(CONCEPTS)
    .map((c) => {
      const open = run.vocab.includes(c.id);
      return `<div class="vocab-row ${open ? '' : 'locked'}">
        <span class="mark">${open ? '✓' : '—'}</span><span>${esc(c.label)}</span>
      </div>`;
    })
    .join('');
  const slotsLabel = [...new Set(run.heroes.filter((h) => h.alive).map((h) => h.slots))].join('–');
  return `<div class="spread">
    <div class="page-l">
      <div class="page-head">
        <span class="title">${esc(nodeTitle(node))}</span>
        <span class="meta">слова на выбор · seed ${run.runSeed}</span>
      </div>
      <div class="flavor">шире словарь — это не большее число. это фраза, которую раньше нельзя было сказать.</div>
      <div class="shop">${items}${slotItem}</div>
      <div class="foot" style="border-top:none;padding-top:0">
        <span>здесь берут одно — выбирай</span>
      </div>
      <div class="btn-row" style="margin-top:auto">
        <button data-action="open-editor">переписать приказы</button>
        <span class="spacer"></span>
        <button class="primary" data-action="skip">дальше в путь, без покупок</button>
      </div>
    </div>
    <div class="gutter"></div>
    <div class="page-r">
      <div class="page-head"><span class="title">Твой словарь</span></div>
      <div class="vocab-list">${vocabRows}</div>
      <div class="foot solid">Слотов на героя: ${slotsLabel}. Мало слотов — это суть: приказы должны соперничать.</div>
    </div>
  </div>`;
}

// ---------- экран: бой ----------

function fmtFactors(factors: Frame['factors']): string {
  if (factors.length === 0) return '';
  const top = [...factors].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 3);
  const parts = top.map((f) =>
    tactician ? `${f.label} ${f.value >= 0 ? '+' : ''}${f.value.toFixed(1)}` : f.label,
  );
  return '· ' + parts.join(' · ');
}

/** Цена решения ромбами: ◆ за очко хода, ◇ — реакция или то, что ходом не оплачено. */
function costPips(cost: number): string {
  return cost > 0 ? '◆'.repeat(cost) : '◇';
}

const RULE_PREFIX = 'правило:';

/** Слово, которое сработало в этом кадре — самый весомый фактор-правило. */
function firedRule(f: Frame): string | null {
  const rules = f.factors.filter((x) => x.label.startsWith(RULE_PREFIX));
  if (rules.length === 0) return null;
  return [...rules].sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0]!.label.slice(RULE_PREFIX.length);
}

/** Строка «по твоему приказу»: чьё слово сработало и было ли оно твоим вообще. */
function orderLine(f: Frame): string {
  const side = f.units.find((u) => u.id === f.actorId)?.side;
  const rule = firedRule(f);
  if (side === 'foe') {
    if (f.cost === 0) return 'его реакция, не твой приказ';
    return rule ? `его приказ, не твой: «${rule}»` : 'его решение, не твой приказ';
  }
  if (rule) return `«${rule}»`;
  return f.cost === 0 ? 'реакция — слова тут не спрашивают' : 'ни одно слово не сработало — достраивает сам';
}

/** Блок «сейчас · кто и почему»: цена, решение, чьё слово, реплика характера. */
function nowBlockHtml(): string {
  const f = frames[frameIdx]!;
  if (!f.actorId) {
    return `<div class="now-block">
      <span class="kicker">сейчас · кто и почему</span>
      <span class="nb-text">Отряд расставлен, приказы скомпилированы. Дальше — арифметика.</span>
    </div>`;
  }
  // реплика характера — только там, где он проговорился впервые
  const quip = battleReveals.find((r) => r.frame === frameIdx && r.unit === f.actorId);
  return `<div class="now-block">
    <span class="kicker">сейчас · кто и почему</span>
    <span class="nb-act">
      <span class="nb-cost">${costPips(f.cost)}</span>
      <span class="nb-text"><b>${esc(f.actorName)}</b> ${esc(f.text)}</span>
    </span>
    <span class="nb-order">
      <span class="kicker">по твоему приказу</span>
      <span>${esc(orderLine(f))}</span>
    </span>
    ${quip ? `<span class="nb-voice ${quip.side === 'party' ? 'own' : 'foe'}">${esc(quip.quip)}</span>` : ''}
  </div>`;
}

/** Лента решений: четыре последних кадра, текущий полным тоном. */
function feedHtml(): string {
  const from = Math.max(1, frameIdx - 3);
  const rows = frames
    .slice(from, frameIdx + 1)
    .map((f, i, arr) => {
      const idx = from + i;
      const cur = idx === frameIdx;
      return `<span class="feed-row${cur ? ' cur' : ''}" data-feed="${idx}">
        <span class="no">${f.round}.${idx}</span>
        <span class="tx"><b>${esc(f.actorName)}</b> ${esc(f.text)}
          ${tactician ? `<i class="why">${esc(fmtFactors(f.factors))}</i>` : ''}</span>
      </span>`;
    })
    .join('');
  return rows || '<span class="feed-row"><span class="tx">бой ещё не начался</span></span>';
}

/** Полоска кадров: засечка на кадр, пройденные ink, текущая red и выше. */
function ticksHtml(): string {
  return frames
    .map((_, i) => `<span class="tick${i === frameIdx ? ' cur' : i < frameIdx ? ' done' : ''}"></span>`)
    .join('');
}

/** Полоса отряда: имя и класс, hp числом и полоской, состояние. */
function partyStripHtml(): string {
  return run.heroes
    .map((h) => {
      const live = heroHpNow(h.id);
      const pct = live ? Math.round((100 * Math.max(0, live.hp)) / live.maxHp) : 0;
      const low = live !== null && live.hp / live.maxHp <= 0.5;
      const note = !live || !live.alive ? 'пал(а)' : low ? 'на исходе' : ordersSentence(h) ? 'по приказу' : 'без приказов';
      return `<span class="ps-col${!live || !live.alive ? ' dead' : ''}" data-party="${h.id}">
        <span class="ps-head">
          <span class="ps-name">${esc(h.name)}</span>
          <span class="ps-class">${esc(heroArchetype(h.archetypeId).class)}</span>
          <span class="ps-hp" data-hp="${h.id}">${live ? `${live.hp}/${live.maxHp}` : '—'}</span>
        </span>
        <span class="ps-bar"><span style="width:${pct}%" class="${low ? 'low' : ''}"></span></span>
        <span class="ps-note">${esc(note)}</span>
      </span>`;
    })
    .join('');
}

/** Подписи значков прикрытия: что даёт и почём. */

const COVER_BADGE_TITLE: Record<NonNullable<FrameUnit['cover']>, string> = {
  half: 'прикрытие: +2 к КБ до своего хода',
  full: 'глухая оборона: +4 к КБ, ближний удар ловит рипост',
  ally: 'прикрыт союзником, пока тот жив и рядом',
  shield: 'щит поднят: бонус к КБ и блок — раз в раунд гасит удар твёрдостью щита',
};

function coverBadgeHtml(cover: FrameUnit['cover']): string {
  return cover ? `<span class="cov ${cover}" title="${COVER_BADGE_TITLE[cover]}">⛨</span>` : '';
}

/** Значок тлеющей раны: что горит и почём (план damage-types, волна 6). */
function smolderBadgeHtml(smolder: FrameUnit['smolder']): string {
  return smolder
    ? `<span class="smold" title="${smolder}: урон в конце хода, пока не сбито">✸</span>`
    : '';
}

function tokensHtml(): string {
  const f = frames[frameIdx];
  if (!f) return '';
  return f.units
    .map((u) => {
      const cls = [
        'btoken',
        u.side === 'foe' ? 'foe' : '',
        u.leader ? 'leader' : '',
        u.side === 'party' && u.id === run.heroes[0]!.id ? 'hero-lead' : '',
        u.alive ? '' : 'dead',
      ].join(' ');
      const hpw = Math.round((100 * Math.max(0, u.hp)) / u.maxHp);
      const mark = u.side === 'foe' && u.id === run.marked ? '<span class="mark-badge">◎</span>' : '';
      return `<div class="${cls}" data-unit="${u.id}" style="left:${u.x * CELL}%;top:${u.y * CELL}%">
        ${mark}${coverBadgeHtml(u.cover)}${smolderBadgeHtml(u.smolder)}<span class="dm"><span>${esc(glyphOf(u.name))}</span></span>
        <span class="hp-sliver"><span style="width:${hpw}%"></span></span>
      </div>`;
    })
    .join('');
}

/** Анимации текущего кадра: перезапись innerHTML слоя перезапускает их. */
function fxHtml(): string {
  const f = frames[frameIdx];
  if (!f) return '';
  const out: string[] = [];
  const stacked = new Map<string, number>();
  for (const e of f.fx) {
    if (e.kind === 'cells') {
      for (const c of e.cells) {
        out.push(`<div class="fx-cell ${e.form}" style="left:${c.x * CELL}%;top:${c.y * CELL}%"></div>`);
      }
    } else {
      // несколько всплытий над одной клеткой — очередью, чтобы не слипались
      const key = `${e.x},${e.y}`;
      const n = stacked.get(key) ?? 0;
      stacked.set(key, n + 1);
      out.push(
        `<span class="fx-float ${e.tone}" style="left:${(e.x + 0.5) * CELL}%;top:${e.y * CELL}%;animation-delay:${(n * 0.22).toFixed(2)}s">${esc(e.text)}</span>`,
      );
    }
  }
  return out.join('');
}

/** Висящие зоны замаха текущего кадра: клетки 5×5 вокруг центров. */
function zonesHtml(): string {
  const f = frames[frameIdx];
  if (!f || f.zones.length === 0) return '';
  const out: string[] = [];
  for (const z of f.zones) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const x = z.x + dx;
        const y = z.y + dy;
        if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) continue;
        out.push(
          `<div class="zone" style="left:${x * CELL}%;top:${y * CELL}%" title="зона замаха — ударит в начале хода кастера"></div>`,
        );
      }
    }
  }
  return out.join('');
}

function tilesLayerHtml(tiles: readonly Tile[][], maxX = GRID_W - 1): string {
  const out: string[] = [];
  tiles.forEach((row, y) =>
    row.forEach((t, x) => {
      if (x > maxX) return;
      const at = `style="left:${x * CELL}%;top:${y * CELL}%"`;
      if (t.blocked) out.push(`<div class="rock" ${at}></div>`);
      else if (t.hazard) out.push(`<div class="hz ${t.hazard}" ${at} title="${t.hazard === 'spikes' ? 'шипы' : 'огонь'}"></div>`);
      else if (t.rough) out.push(`<div class="rgh" ${at} title="труднопроходимо"></div>`);
      else if (t.height) out.push(`<div class="hgt h${t.height}" ${at}></div>`);
    }),
  );
  return out.join('');
}

function terrainHtml(): string {
  return battle ? tilesLayerHtml(battle.terrain.tiles) : '';
}

function battleScreenHtml(): string {
  const node = currentNode(run);
  const f = frames[frameIdx]!;
  const scenario = scenarioForNode(node);
  const deadline = nodeDeadline(node);
  return `<div class="spread">
    <div class="page-l" style="padding:20px 24px 14px 28px;gap:9px">
      <div class="page-head">
        <span class="title">⚑ ${esc(scenario ? scenario.title : cap(NODE_RU[node.kind]))}</span>
        <span class="meta">${esc(NODE_RU[node.kind])} · слой ${node.layer + 1} · seed ${run.runSeed}</span>
        <span class="run-chips">
          <span class="chip ink" id="turnlabel">раунд ${f.round}</span>
          ${deadline ? `<span class="chip red">дедлайн ${deadline}</span>` : ''}
        </span>
      </div>
      ${scenario ? `<div class="task-line">${esc(scenario.brief)}</div>` : ''}
      <div class="bfield" id="bfield" style="--cell:${CELL}%">
        ${terrainHtml()}
        <div class="zones-layer" id="zoneslayer">${zonesHtml()}</div>
        ${tokensHtml()}
        <div class="fx-layer" id="fxlayer">${fxHtml()}</div>
        <span class="callout" id="callout" style="left:24%;top:90%">${esc(f.callout ?? '')}</span>
      </div>
      <div class="frame-line">
        <span class="kicker" id="framelabel">кадр ${frameIdx} из ${frames.length - 1}</span>
        <span class="ticks" id="ticks">${ticksHtml()}</span>
      </div>
      <div class="controls-row">
        <button data-action="step-back" title="кадр назад">‹</button>
        <button data-action="step-fwd" title="кадр вперёд">›</button>
        <button class="primary" data-action="toggle-play" id="playbtn">${playing ? '❙❙ пауза' : '▶ играть'}</button>
        <span class="speeds">${[1, 2, 4]
          .map((v) => `<button class="sp${speed === v ? ' on' : ''}" data-action="set-speed" data-sp="${v}">×${v}</button>`)
          .join('')}</span>
        <span class="ctl-hint">пробел — пауза, стрелки — по кадру</span>
      </div>
      <div class="party-strip" id="partystrip">${partyStripHtml()}</div>
    </div>
    <div class="gutter"></div>
    <div class="page-r" style="padding:20px 24px 14px 20px;gap:10px">
      <div class="page-head">
        <span class="title">Свиток</span>
        <button class="tact-btn ${tactician ? 'on' : ''}" data-action="toggle-tact">режим тактика</button>
      </div>
      <div id="now-block">${nowBlockHtml()}</div>
      <div class="feed">
        <span class="kicker">лента решений</span>
        <div id="feed">${feedHtml()}</div>
        <button class="mini" data-action="open-log">весь свиток</button>
      </div>
      <div class="btn-row" style="margin-top:auto">
        <button class="grow" data-action="open-editor">переписать приказы</button>
        <button class="grow primary" data-action="sparring">↻ те же кости</button>
      </div>
    </div>
  </div>`;
}

/** Дешёвое обновление DOM на смене кадра — сохраняет CSS-переходы фишек. */
function syncBattleFrame(): void {
  const f = frames[frameIdx];
  if (!f) return;
  for (const u of f.units) {
    const el = app.querySelector<HTMLElement>(`.btoken[data-unit="${u.id}"]`);
    if (!el) continue;
    el.style.left = `${u.x * CELL}%`;
    el.style.top = `${u.y * CELL}%`;
    el.classList.toggle('dead', !u.alive);
    el.classList.toggle('active', u.alive && u.id === f.actorId);
    const hp = el.querySelector<HTMLElement>('.hp-sliver span');
    if (hp) hp.style.width = `${Math.round((100 * Math.max(0, u.hp)) / u.maxHp)}%`;
    const cov = el.querySelector<HTMLElement>('.cov');
    if (!u.cover) cov?.remove();
    else if (!cov) el.insertAdjacentHTML('afterbegin', coverBadgeHtml(u.cover));
    else if (!cov.classList.contains(u.cover)) {
      cov.className = `cov ${u.cover}`;
      cov.title = COVER_BADGE_TITLE[u.cover];
    }
    const sm = el.querySelector<HTMLElement>('.smold');
    if (!u.smolder) sm?.remove();
    else if (!sm) el.insertAdjacentHTML('afterbegin', smolderBadgeHtml(u.smolder));
    else sm.title = `${u.smolder}: урон в конце хода, пока не сбито`;
  }
  const fxl = document.getElementById('fxlayer');
  if (fxl) fxl.innerHTML = fxHtml();
  const set = (id: string, text: string): void => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set('turnlabel', `раунд ${f.round}`);
  set('framelabel', `кадр ${frameIdx} из ${frames.length - 1}`);
  set('callout', f.callout ?? '');
  const html = (id: string, markup: string): void => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = markup;
  };
  html('now-block', nowBlockHtml());
  html('feed', feedHtml());
  html('ticks', ticksHtml());
  const zl = document.getElementById('zoneslayer');
  if (zl) zl.innerHTML = zonesHtml();
  const play = document.getElementById('playbtn');
  if (play) play.textContent = playing ? '❙❙ пауза' : '▶ играть';
  html('partystrip', partyStripHtml());
}

// ---------- оверлей: редактор приказов ----------

/** Как герой прочтёт эту фразу: дословно или по-своему (содержание раскроет бой). */
function understanding(hero: HeroState, draft: PhraseDraft): 'literal' | 'own' {
  const r = compilePhrase(draft, run.vocab, heroNames(run));
  if (!r.ok) return 'literal';
  return applyLens(hero.lenses, [r.rule]).rules[0]?.marks?.length ? 'own' : 'literal';
}

/** Счётчик фокусов словами, а не дробью. */
function focusNote(): string {
  const free = FOCUS_BUDGET - focusUsed(run);
  if (free === 0) return `занято ${FOCUS_BUDGET} из ${FOCUS_BUDGET}`;
  return `${free} ${free === 1 ? 'свободен' : 'свободно'} из ${FOCUS_BUDGET}`;
}

/** Слоты героя ромбами: ◆ занятый, ◇ свободный. */
function slotPips(hero: HeroState): string {
  return '◆'.repeat(Math.min(hero.phrases.length, hero.slots)) + '◇'.repeat(Math.max(0, hero.slots - hero.phrases.length));
}

/** Подпись комплекта — её же читает карточка отряда, там она обрезается. */
const SET_NOTE_MAX = 24;

/** Переключатель комплектов A / B / C: активный залит, пустой — пунктир. */
function orderSetsHtml(hero: HeroState): string {
  const tabs = hero.sets
    .map((set, i) => {
      const cls = i === hero.activeSet ? 'on' : set.phrases.length === 0 ? 'empty' : '';
      return `<button class="set-tab ${cls}" data-action="switch-set" data-hero="${hero.id}" data-set="${i}">${
        ORDER_SETS[i]
      }</button>`;
    })
    .join('');
  const active = hero.sets[hero.activeSet]!;
  const hint = active.phrases.length ? '' : '<span class="set-hint">пустой комплект — здесь пока ничего не написано</span>';
  return `<div class="sets-row">${tabs}
    <input class="set-note" data-hero="${hero.id}" maxlength="${SET_NOTE_MAX}" placeholder="без подписи"
      title="подпись комплекта — её видно на карточке отряда" value="${escAttr(active.note)}">
    ${hint}</div>`;
}

/** Строка принципа: ромб фокуса · чипсы IR · статус понимания. Вес не показывается. */
function principleRowHtml(hero: HeroState, i: number, ph: PhraseDraft): string {
  // глубокие чипсы: условие фразы — цепочка до трёх уровней со связкой
  // «и»/«или» (одна на фразу); следующий уровень появляется, когда выбран предыдущий
  const chain: CondLinkDraft[] =
    ph.condition.id === 'and' || ph.condition.id === 'or'
      ? ph.condition.conds
      : ph.condition.id === 'always'
        ? []
        : [ph.condition];
  const op: 'and' | 'or' = ph.condition.id === 'or' ? 'or' : 'and';
  const opChip = (lvl: number): string =>
    lvl === 1
      ? `<select class="op-select" data-hero="${hero.id}" data-idx="${i}">
          <option value="and" ${op === 'and' ? 'selected' : ''}>и</option>
          <option value="or" ${op === 'or' ? 'selected' : ''}>или</option>
        </select>`
      : `<span class="nest">${op === 'or' ? 'или' : 'и'}</span>`;
  // «не» — грамматика при звене, а не чипс словаря: галочка рядом с выбором.
  // У «всегда» отрицать нечего — галочка гаснет
  const condChip = (lvl: number, opts: Opt<ConditionDraft>[]): string => {
    const link = chain[lvl];
    const neg = link?.id === 'not';
    const value: ConditionDraft = neg ? link.cond : (link ?? { id: 'always' });
    const off = value.id === 'always';
    return `<label class="neg" title="если НЕ">
        <input type="checkbox" class="neg-check" data-hero="${hero.id}" data-idx="${i}"
          data-level="${lvl}" ${neg ? 'checked' : ''} ${off ? 'disabled' : ''}> не
      </label>${selectHtml('cond-select', hero.id, i, opts, value, `data-level="${lvl}"`)}`;
  };
  const condSelects = [condChip(0, conditionOptions())];
  for (let lvl = 1; lvl < 3 && chain.length >= lvl; lvl++) {
    condSelects.push(`<span class="nest">⌞</span>${opChip(lvl)}${condChip(lvl, moreConditionOptions())}`);
  }
  const focused = (ph.weight ?? 1) >= 3;
  const read = understanding(hero, ph);
  return `<div class="pr-row${focused ? ' focused' : ''}">
    <span class="pr-focus" data-action="toggle-focus" data-hero="${hero.id}" data-idx="${i}"
      title="фокус — важнее остальных; бюджет общий на отряд">${focused ? '◆' : '◇'}</span>
    <span class="fields">${condSelects.join('')}${selectHtml(
      'pref-select',
      hero.id,
      i,
      preferenceOptions(hero.id),
      ph.preference,
    )}</span>
    <span class="pr-status${read === 'own' ? ' own' : ''}">${
      focused ? 'фокус · ' : ''
    }${read === 'own' ? 'понял по-своему' : 'понял дословно'}</span>
    <button class="mini" data-action="clear-phrase" data-hero="${hero.id}" data-idx="${i}">стереть</button>
  </div>`;
}

/** Модалка ввода текста: слева текст комплекта, справа эхо — как он это понял. */
function textModalHtml(hero: HeroState): string {
  const set = hero.sets[hero.activeSet]!;
  const draft = heroText[hero.id] ?? set.text;
  const unknown = heroUncertainty[hero.id] ?? [];
  const empty = set.phrases.length === 0 && draft.trim() === '';
  const echo = set.phrases
    .map((ph) => {
      const read = understanding(hero, ph);
      return read === 'own'
        ? `<div class="echo-row own"><span class="kicker">понял по-своему</span>
            <span class="hand">это слово он читает по-своему — содержание раскроет свиток боя</span></div>`
        : `<div class="echo-row"><span class="kicker">понял дословно</span>
            <span>${esc(cap(describeDraft(ph, heroNames(run))))}</span></div>`;
    })
    .join('');
  const notUnderstood = unknown.length
    ? `<div class="echo-row miss"><span class="kicker">не понял вообще</span>
        <span>${unknown.map(esc).join(' · ')}</span></div>`
    : '';
  return `<div class="overlay inner" data-close="text"><div class="modal text-modal">
    <div class="head">
      <span class="title">Твой текст · комплект ${ORDER_SETS[hero.activeSet]}</span>
      <span class="meta">он знает ${run.vocab.length} слов</span>
    </div>
    <div class="tm-cols">
      <div class="tm-in">
        <textarea class="principle-text" data-hero="${hero.id}" rows="7"
          placeholder="Опиши принципы словами — ${esc(hero.name)} поймёт по-своему">${esc(draft)}</textarea>
        <span class="tm-note">незнакомые слова перепиши или оставь — в набор это просто не войдёт</span>
      </div>
      <div class="tm-echo">
        ${empty ? '<div class="echo-row miss"><span class="hand">пока нечего понимать</span></div>' : echo}
        ${notUnderstood}
      </div>
    </div>
    <div class="foot-row">
      <span class="tm-note">текст сохранится целиком — даже те слова, что он пока не понимает</span>
      <span class="spacer"></span>
      <button data-action="close-text">отмена</button>
      <button class="primary" data-action="compile-text" data-hero="${hero.id}" ${
        compiling[hero.id] || !(heroText[hero.id] ?? set.text).trim() ? 'disabled' : ''
      }>${compiling[hero.id] ? '…понимает' : 'применить'}</button>
    </div>
  </div></div>`;
}

/** Словарь: что открыто, по ролям слова; закрытые — только счётом, без имён. */
function vocabHtml(): string {
  const open = Object.values(CONCEPTS).filter((c) => run.vocab.includes(c.id));
  const cats = ['condition', 'selector', 'action', 'space'] as const;
  const filters = [
    `<button class="vf${vocabFilter === null ? ' on' : ''}" data-action="vocab-filter">все ${open.length}</button>`,
    ...cats
      .map((cat) => {
        const n = open.filter((c) => c.category === cat).length;
        return n
          ? `<button class="vf${vocabFilter === cat ? ' on' : ''}" data-action="vocab-filter" data-cat="${cat}">${
              CAT_RU[cat]
            } ${n}</button>`
          : '';
      })
      .filter(Boolean),
  ].join('');
  const shown = vocabFilter ? open.filter((c) => c.category === vocabFilter) : open;
  const group = (title: string, list: typeof open, rare: boolean): string =>
    list.length
      ? `<div class="v-group">
          <span class="kicker">${title}</span>
          ${list
            .map(
              (c) => `<div class="v-row">
                <span class="chip ${rare ? 'red' : 'line'}">${esc(c.label)}</span>
                <span class="v-desc">${CAT_RU[c.category]}${rare ? ' · редкое' : ''}</span>
              </div>`,
            )
            .join('')}
        </div>`
      : '';
  const locked = Object.values(CONCEPTS).length - open.length;
  return `<div class="overlay inner" data-close="vocab"><div class="modal vocab-modal">
    <div class="head">
      <span class="title">Словарь</span>
      <span class="meta">${open.length} из ${Object.values(CONCEPTS).length} слов</span>
      <span class="spacer"></span>
      <button data-action="close-vocab">закрыть</button>
    </div>
    <div class="v-filters">${filters}<span class="v-hint">слова открываются трофеями и в скриптории</span></div>
    <div class="v-scroll">
      ${group('редкие', shown.filter((c) => RARE_WORDS.includes(c.id)), true)}
      ${group('обычные', shown.filter((c) => !RARE_WORDS.includes(c.id)), false)}
      ${
        locked
          ? `<div class="v-group"><span class="kicker">ещё не открыто</span>
              <div class="v-row"><span class="chip unknown">? ещё ${locked}</span>
              <span class="v-desc">имена закрытых слов не показываются — это спойлер трофея</span></div></div>`
          : ''
      }
    </div>
  </div></div>`;
}

function editorHtml(): string {
  const alive = run.heroes.filter((h) => h.alive);
  const eh = alive.find((h) => h.id === editHero) ?? alive[0]!;
  const arch = heroArchetype(eh.archetypeId);
  const heroCards = run.heroes
    .map((h) => {
      if (!h.alive) {
        return `<div class="eh-card dead"><div class="nm"><span>${esc(h.name)}</span>
          ${lensTagHtml(h.lenses, 'ch')}</div>
          <div class="sub">пал(а) в бою</div></div>`;
      }
      return `<div class="eh-card ${h.id === eh.id ? 'sel' : ''}" data-action="sel-hero" data-hero="${h.id}">
        <div class="nm"><span>${esc(h.name)}</span>${lensTagHtml(h.lenses, 'ch')}</div>
        <div class="sub klass-line">${esc(heroArchetype(h.archetypeId).class)} · hp ${h.hp}/${h.stats.maxHp}</div>
        <div class="sub">комплект ${ORDER_SETS[h.activeSet]} · ${h.phrases.length} из ${h.slots} слотов${
          h.phrases.some((d) => (d.weight ?? 1) >= 3) ? ' · фокус' : ''
        }</div>
      </div>`;
    })
    .join('');

  const set = eh.sets[eh.activeSet]!;
  const quote = set.text.trim() || ordersSentence(eh);
  const canText = Boolean(API_KEY);
  const quoteBlock = `<div class="quote-block">
    <span class="q-text">${quote ? `«${esc(quote)}»` : 'здесь пока ничего не написано'}</span>
    ${
      canText
        ? `<button class="mini" data-action="open-text" data-hero="${eh.id}">править текст</button>`
        : `<span class="q-note">свободный текст без ключа компилятора недоступен — собирай приказ чипсами</span>`
    }
  </div>`;

  const rows = eh.phrases.map((ph, i) => principleRowHtml(eh, i, ph)).join('');
  const free = Array.from({ length: Math.max(0, eh.slots - eh.phrases.length) })
    .map(
      (_, k) => `<div class="pr-row empty" data-action="add-phrase" data-hero="${eh.id}">
        <span class="pr-focus">◇</span>
        <span class="fields">свободный слот — допиши приказ или оставь ему свободу</span>
        <span class="pr-status">слот ${eh.phrases.length + k + 1} из ${eh.slots}</span>
      </div>`,
    )
    .join('');

  // вне debug чипсы при живом компиляторе скрыты — тумблер не показываем
  const err = editError[eh.id] ? `<div class="error">${esc(editError[eh.id]!)}</div>` : '';
  const replay = battle
    ? `<button class="primary" data-action="sparring">↻ те же кости, новые приказы</button>`
    : `<button class="primary" data-action="close-editor">${
        prepOpen ? '⚔ к разведке' : 'к походу'
      }</button>`;
  // Ворота C: замысел словами до конструктора — уходит в журнал плейтеста
  const intentBlock = `<div class="intent-block">
    <span class="kicker">сначала — замысел словами, в полевой журнал</span>
    <textarea class="intent-text" data-hero="${eh.id}" rows="2"
      placeholder="Чего ты хочешь от ${esc(eh.name)}? Напиши как думаешь — потом собери из чипсов.">${esc(
        heroIntent[eh.id] ?? lastIntent(journal, eh.name),
      )}</textarea>
  </div>`;

  return `<div class="overlay" data-close="editor">
    <div class="modal editor">
      <div class="head">
        <span class="title">Приказы · ${esc(eh.name)}</span>
        <span class="sub">${esc(arch.class)} · слоты ${slotPips(eh)}</span>
        <span class="spacer"></span>
        <button class="mini" data-action="open-vocab">словарь · ${run.vocab.length} слов</button>
        <span class="meta">фокусы: ${focusNote()}</span>
      </div>
      <div class="cols">
        <div class="heroes-col">
          ${heroCards}
          ${debugLenses ? `<div class="lens-hint">${eh.lenses.map((l) => `<div>${LENS_HINT[l]}</div>`).join('')}</div>` : ''}
        </div>
        <div class="slots-col">
          ${orderSetsHtml(eh)}
          ${quoteBlock}
          ${rows}${free}
          ${err}
          ${intentBlock}
          <div class="readings">
            <span class="kicker">как прочёл ${esc(eh.name)}</span>
            ${readNoteHtml(readingLines(eh), false)}
          </div>
        </div>
      </div>
      <div class="foot-row">
        <button data-action="close-editor">закрыть</button>
        ${freeVocabBtnHtml()}
        <span class="ed-state">комплект ${ORDER_SETS[eh.activeSet]} · переключение бесплатно и вне боя</span>
        <span class="spacer"></span>
        ${replay}
      </div>
    </div>
    ${textOpen ? textModalHtml(eh) : ''}
    ${vocabOpen ? vocabHtml() : ''}
  </div>`;
}

// ---------- оверлей: отладка ----------

/**
 * Панель отладки: собрать конкретный бой руками — сценарий каталога, состав
 * партии, характеры. Собранное — обычный забег из одного узла (debugRun),
 * поэтому дальше работают все экраны: расстановка, приказы, бой, разбор.
 * Та же сборка играется headless в тестах и `pnpm sim debug`.
 */
function debugPanelHtml(): string {
  const battle = debugBattleById(debugDraft.battle);
  const brief = debugBrief(debugDraft.battle);
  const battleOpts = DEBUG_BATTLES.map(
    (b) => `<option value="${b.id}" ${b.id === debugDraft.battle ? 'selected' : ''}>${esc(b.label)}</option>`,
  ).join('');
  const slots = Array.from({ length: MAX_DEBUG_PARTY }, (_, i) => {
    const cur = debugDraft.party[i] ?? { archetypeId: '', lenses: [] };
    const heroOpts = [
      `<option value="" ${cur.archetypeId ? '' : 'selected'}>— пусто —</option>`,
      ...HERO_POOL.map(
        (h) => `<option value="${h.id}" ${h.id === cur.archetypeId ? 'selected' : ''}>${esc(h.name)} — ${esc(h.class)}</option>`,
      ),
    ].join('');
    const chips = (Object.keys(LENS_RU) as LensId[])
      .map(
        (l) => `<button class="lens-chip ${cur.lenses.includes(l) ? 'on' : ''}"
          data-action="debug-lens" data-slot="${i}" data-lens="${l}">${esc(LENS_RU[l])}</button>`,
      )
      .join('');
    return `<div class="dbg-slot">
      <select class="dbg-hero" data-slot="${i}">${heroOpts}</select>
      <div class="dbg-lenses">${cur.archetypeId ? chips : '<span class="kicker">слот пуст</span>'}</div>
    </div>`;
  }).join('');

  return `<div class="overlay" data-close="debug">
    <div class="modal debug-panel">
      <div class="head">
        <span class="title">Отладка: собрать бой</span>
        <span class="meta">любой сценарий × любая партия × любые характеры</span>
      </div>
      <div class="dbg-row">
        <label>бой <select class="dbg-battle">${battleOpts}</select></label>
        <label>сид <input class="dbg-seed" type="number" min="1" step="1" value="${debugDraft.seed}"></label>
        <label title="под давлением бойцы взвешивают решение неровно"><input class="dbg-nerve" type="checkbox" ${
          debugDraft.nerve ? 'checked' : ''
        }> нерв</label>
        <span class="spacer"></span>
        <span class="kicker">${esc(battle.note)}</span>
      </div>
      ${brief ? `<div class="dbg-brief">Задача: ${esc(brief)}</div>` : ''}
      <div class="dbg-slots">${slots}</div>
      ${debugError ? `<div class="error">${esc(debugError)}</div>` : ''}
      <div class="foot-row">
        <button data-action="close-debug">закрыть</button>
        <span class="kicker">характеры и весь словарь открываются сами</span>
        <span class="spacer"></span>
        <button class="primary" data-action="debug-build">собрать бой</button>
      </div>
    </div>
  </div>`;
}

/** Открыть панель, подставив текущую партию как черновик. */
function openDebugPanel(): void {
  if (debugDraft.party.length === 0) {
    debugDraft.party = run.heroes
      .slice(0, MAX_DEBUG_PARTY)
      .map((h) => ({ archetypeId: h.archetypeId, lenses: [...h.lenses] }));
    debugDraft.seed = run.runSeed;
  }
  debugError = '';
  debugOpen = true;
  playing = false;
  stopTimer();
}

/** Заменить забег собранным боем и сбросить состояние экранов. */
function debugBuild(): void {
  const setup: DebugSetup = {
    battle: debugDraft.battle,
    seed: debugDraft.seed,
    party: debugDraft.party.filter((h) => h.archetypeId),
    ...(debugDraft.nerve ? { nerve: NERVE_AMP } : {}),
  };
  let state: RunState;
  try {
    state = debugRun(setup);
  } catch (e) {
    debugError = (e as Error).message;
    return;
  }
  run = state;
  battle = null;
  frames = [];
  frameIdx = 0;
  playing = false;
  stopTimer();
  battleReveals = [];
  editorOpen = false;
  aftermathOpen = false;
  logOpen = false;
  unitCardId = null;
  ordersDirty = false;
  editError = {};
  lessonNudge = false;
  deployPick = null;
  fightsAtNode = 0;
  rewroteSinceBattle = false;
  editHero = run.heroes[0]!.id;
  visited.clear();
  visited.add(run.at);
  // отладка смотрит на всё: характеры видны, словарь открыт целиком
  debugLenses = true;
  unlockAllWords();
  debugOpen = false;
  debugError = '';
}

// ---------- оверлей: разбор после боя ----------

/** Кто в бою потратил реакцию — это знание игрок оплатил уроном, а не очками. */
function reactorsInBattle(): Set<string> {
  const out = new Set<string>();
  if (!battle) return out;
  for (const e of battle.events as BattleEvent[]) {
    switch (e.t) {
      case 'riposte':
      case 'reactGuard':
        out.add(e.by);
        break;
      case 'shieldBlock':
      case 'intercept':
      case 'reactHeal':
      case 'reactStep':
      case 'reactStrike':
        out.add(e.unit);
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Слова, которые написал игрок: `герой:источник правила`. Инстинкты архетипа
 * сюда не входят — разбор говорит про твои слова, а не про врождённое.
 */
function heroWords(): Map<string, string> {
  const names = heroNames(run);
  const out = new Map<string, string>();
  for (const h of run.heroes) {
    for (const d of h.phrases) {
      const r = compilePhrase(d, run.vocab, names);
      if (r.ok) out.set(`${h.id}:${r.rule.source}`, h.name);
    }
  }
  return out;
}

/** Слова героев, которые за бой не прозвучали ни разу. */
function silentWords(): { name: string; word: string }[] {
  const fired = new Set<string>();
  for (const f of frames) {
    for (const x of f.factors) {
      if (x.label.startsWith(RULE_PREFIX)) fired.add(`${f.actorId}:${x.label.slice(RULE_PREFIX.length)}`);
    }
  }
  return [...heroWords()]
    .filter(([key]) => !fired.has(key))
    .map(([key, name]) => ({ name, word: key.slice(key.indexOf(':') + 1) }));
}

/**
 * «Разведка подтвердилась»: купленное — ink с ✓, открытое телом — red и
 * «— ново», бесплатно известное — контуром. Единственное место, где знание
 * о враге приходит без очков: плата за него уже внесена уроном.
 */
function intelDebriefHtml(): string {
  const chips: string[] = [];
  if (run.intel.map) chips.push('<span class="chip ink">✓ карта: рельеф и расстановка</span>');
  const reacted = reactorsInBattle();
  for (const f of foeSpecs(run)) {
    if (run.intel.numbers.includes(f.id)) chips.push(`<span class="chip ink">✓ ${esc(f.name)}: числа</span>`);
    if (run.intel.orders.includes(f.id)) chips.push(`<span class="chip ink">✓ ${esc(f.name)}: приказы</span>`);
    if (f.reaction && reacted.has(f.id)) {
      chips.push(`<span class="chip red">${esc(f.name)}: ${esc(REACTION_RU[f.reaction])} — ново</span>`);
    }
    const weak = Object.keys(f.defenses?.weak ?? {});
    if (weak.length) {
      chips.push(
        `<span class="chip red">${esc(f.name)}: слаб к ${weak.map((w) => DAMAGE_TYPE_RU[w as DamageType]).join(', ')} — ново</span>`,
      );
    }
  }
  chips.push(`<span class="chip line">состав: врагов ${foeSpecs(run).length}</span>`);
  return `<div class="ab-block">
    <span class="kicker">разведка подтвердилась</span>
    <div class="chips">${chips.join('')}</div>
  </div>`;
}

function aftermathHtml(): string {
  if (!battle) return '';
  const node = currentNode(run);
  const won = battle.winner === 'party';
  const deadline = nodeDeadline(node);
  const scenario = scenarioForNode(node);
  const fallen = battle.units.filter((u) => u.side === 'party' && !u.alive).map((u) => u.name);
  const outcome = won ? 'поле за тобой' : battle.winner === 'draw' ? 'ничья' : 'отряд разбит';
  const meta = `${scenario ? `${scenario.title.toLowerCase()} — ${won ? 'задача взята' : 'задача сорвалась'} · ` : ''}раунд ${
    battle.rounds
  }${deadline ? ` из ${deadline}` : ''}`;

  // только те искажения, что реально сработали за бой, каждое по разу
  const words = heroWords();
  const twisted = battleReveals.filter((r) => r.side === 'party' && !r.drift && r.source && words.has(`${r.unit}:${r.source}`));
  const seen = new Set<string>();
  const twistRows = twisted
    .filter((r) => !seen.has(`${r.unit}:${r.source}`) && seen.add(`${r.unit}:${r.source}`))
    .map(
      (r) => `<div class="ab-row">
        <span class="ab-who">${esc(r.name)}</span>
        <span class="ab-said"><span class="ab-word">${esc(r.source!)}</span> → ${esc(r.reading ?? '')}</span>
      </div>
      <div class="ab-voice">${esc(r.quip)}</div>`,
    )
    .join('');
  // непроявившиеся слова — обязательный элемент: они объясняют, почему
  // карточка героя до боя молчит
  const silent = silentWords()
    .map(
      (w) => `<div class="ab-row silent">
        <span class="ab-who">${esc(w.name)}</span>
        <span class="ab-said"><span class="ab-word off">${esc(w.word)}</span>
          не сработало ни разу — прочтение осталось загадкой</span>
      </div>`,
    )
    .join('');

  const drift = battleReveals.filter((r) => r.drift);
  const driftHtml = drift.length
    ? `<div class="ab-block">
        <span class="kicker">характер сдвинулся по ходу боя</span>
        ${drift
          .map(
            (r) => `<div class="ab-row"><span class="ab-mark">◈</span>
              <span class="ab-said">${esc(r.name)}, раунд ${
                r.round ?? '?'
              } — характер защёлкнулся: до конца боя решает он${debugLenses ? ` (${LENS_RU[r.lens]})` : ''}</span></div>
            <div class="ab-voice">${esc(r.quip)}</div>`,
          )
          .join('')}
      </div>`
    : '';

  const contLabel = won
    ? 'продолжить поход'
    : node.kind === 'lesson'
      ? 'вернуться к приказам'
      : 'принять поражение';
  const contHint = ordersDirty ? 'title="приказы переписаны — сперва переиграй с теми же костями"' : '';
  return `<div class="overlay" data-close="aftermath">
    <div class="modal aftermath ${won ? '' : 'loss'}">
      <div class="head">
        <span class="title">Разбор</span>
        <span class="meta">${esc(meta)}</span>
        <span class="chip ${won ? 'ink' : 'red'}" style="margin-left:auto">${outcome}</span>
      </div>
      <div class="ab-body">
        <div class="ab-block">
          <span class="kicker">твои слова прочли по-своему</span>
          ${twistRows || '<div class="ab-row silent"><span class="ab-said">ни одно слово не переиначили — читали дословно</span></div>'}
          ${silent}
        </div>
        ${driftHtml}
        ${intelDebriefHtml()}
        <div class="ab-lines">
          <span>${fallen.length ? `пали: ${esc(fallen.join(', '))}` : 'пали: никто'} · seed ${run.runSeed}</span>
          ${
            !won && node.kind === 'lesson'
              ? '<span>это ничего не стоило: урок прощает — перепиши приказ и переиграй</span>'
              : ''
          }
        </div>
      </div>
      <div class="foot-row">
        <button class="primary" data-action="open-editor">переписать приказы</button>
        <button data-action="sparring">те же кости — спарринг</button>
        <button data-action="open-log">весь свиток</button>
        <span class="spacer"></span>
        <button data-action="accept" ${ordersDirty ? 'disabled' : ''} ${contHint}>${contLabel}</button>
      </div>
    </div>
  </div>`;
}

// ---------- оверлей: карточка юнита ----------

/** hp юнита в текущем кадре боя; undefined — кадра нет или юнит вне боя. */
function unitHpInBattle(id: string): { hp: number; alive: boolean } | undefined {
  const u = battle && frames[frameIdx] ? frames[frameIdx]!.units.find((u) => u.id === id) : undefined;
  return u ? { hp: Math.max(0, u.hp), alive: u.alive } : undefined;
}

// ---------- карточка героя: вкладки, приёмы по оружию, попап ----------

/*
 * Дизайн-спека: `design/hero-card/Карточка героя - спека для кода.md`
 * (утверждённый вариант 3a). Азбука карточки: ромб — очко хода, пустой ромб —
 * реакция; три ступени броска прописаны числами; всё, что длиннее строки,
 * уходит в попап — список остаётся сводкой на один взгляд.
 */

type CardTab = 'about' | 'moves' | 'bag';

interface CardChip {
  tone: 'ink' | 'red' | 'line';
  text: string;
}

/** Попап строки: имя, мета, чипсы, абзац пояснения и слово-заказчик. */
interface CardDetail {
  name: string;
  meta: string;
  chips: CardChip[];
  text: string;
  /** Какое слово заказывает этот приём (план words) — рукописной строкой. */
  word?: string;
}

interface CardRow {
  key: string;
  /** Цена ромбами: ◆ — очко хода, ◇ — реакция. */
  cost: string;
  name: string;
  /** Райдеры пунктиром рядом с именем. */
  marks: string[];
  chips: CardChip[];
  detail: CardDetail;
}

interface CardSection {
  title: string;
  meta: string;
  /** Правый край заголовка: бонус атаки оружия или пометка «общее для всех». */
  right: string;
  /** У оружия заголовок кликабелен — у него свой попап. */
  key?: string;
  detail?: CardDetail;
  rows: CardRow[];
}

const signed = (n: number): string => (n < 0 ? `−${-n}` : `+${n}`);
const apRu = (ap: number): string => `${ap} ${ap === 1 ? 'очко' : 'очка'}`;
const rangeRu = (r: number): string => (r > 1 ? `даль ${r}` : 'в упор');
const dmgTypeRu = (t?: DamageType): string => (t ? DAMAGE_TYPE_RU[t] : 'без типа');

const SLOT_RU: Record<WeaponMove['slot'], string> = {
  weakAttack: 'быстрый',
  attack: 'полный',
  selflessAttack: 'рисковый',
};

/** Слово-заказчик темпа (план words): манера в приказе выбирает слот. */
const SLOT_WORD: Record<WeaponMove['slot'], string> = {
  weakAttack: 'слово «бить часто» заказывает этот темп.',
  attack: 'слово «бить наверняка» заказывает этот темп.',
  selflessAttack: 'слово «бить отчаянно» заказывает этот темп.',
};

/**
 * Три ступени броска за ход (MAP, план action-economy): первым ударом, вторым
 * и третьим. Числа, а не иконки — инвариант карточки.
 */
function mapLadder(w: WeaponSpec, arch: HeroArchetype): string {
  const base = attackBonusOf(w);
  return [0, 1, 2]
    .map((i) => signed(base - mapPenalty(i, { agile: w.agile, flurry: arch.passives?.flurry })))
    .join(' / ');
}

function weaponDetail(w: WeaponSpec, arch: HeroArchetype): CardDetail {
  const moves = movesOf(w);
  const slots = new Set(moves.map((m) => m.slot));
  const parts: string[] = [];
  parts.push(
    w.range > 1
      ? `Достаёт на ${w.range} — бьёт поверх строя, не входя в чужой контакт.`
      : 'Бьёт только в упор.',
  );
  if (!slots.has('weakAttack')) parts.push('Быстрого темпа нет: частить этим оружием не выйдет.');
  if (!slots.has('selflessAttack')) parts.push('Рискового темпа нет: этим оружием не открываются.');
  if (w.agile) {
    parts.push(
      `Ловкое: ступень штрафа за повтор мягче (−${MAP_STEP_AGILE} вместо −${MAP_STEP}) — второй и третий удары за ход обходятся дешевле.`,
    );
  }
  if (w.persist) {
    parts.push(`Любой удар оставляет ${persistRu(w.persist.type ?? w.dmgType ?? 'fire')} −${w.persist.dmg}/ход.`);
  }
  if (w.aoe) parts.push(`Площадное: ${describeAoe(w.aoe)}. Без слова каста форма молчит.`);
  return {
    name: w.name,
    meta: `оружие · ${dmgTypeRu(w.dmgType)} · урон ${w.dmg} · ${rangeRu(w.range)} · бонус ${signed(attackBonusOf(w))}`,
    chips: [{ tone: 'line', text: `приёмов ${moves.length}` }],
    text: parts.join(' '),
  };
}

function moveDetail(w: WeaponSpec, m: WeaponMove, arch: HeroArchetype): CardDetail {
  const ap = m.ap ?? AP_COST[m.slot];
  const step = mapPenalty(1, { agile: w.agile, flurry: arch.passives?.flurry });
  const type = m.dmgType ?? w.dmgType;
  const parts: string[] = [];
  parts.push(
    m.slot === 'weakAttack'
      ? `Быстрый темп — одно очко хода: таких за ход влезает ${AP_PER_TURN}.`
      : m.slot === 'attack'
        ? 'Полный темп — два очка: третье остаётся на шаг или оборону.'
        : 'Рисковый темп — два очка: самый тяжёлый удар и настоящий размен.',
  );
  parts.push(
    `Второй удар за ход идёт со штрафом −${step}, третий −${step * 2}, и промах стоит того же очка, что попадание.`,
  );
  if (m.pierce !== undefined) {
    parts.push(
      `Пробивает укрытия: цели остаётся ${Math.round(m.pierce * 100)}% бонуса обороны — против щита и камня это решает больше, чем фланг. Заодно расчётлив: на рипост глухой обороны не напарывается.`,
    );
  } else if (m.sure) {
    parts.push('Расчётливый удар: на рипост глухой обороны не напарывается.');
  }
  if (m.expose) {
    parts.push(
      `Открывает: до своего следующего хода всё входящее по бьющему идёт ×${SELFLESS_VULN_MULT} — от всех сразу, а не только от цели.`,
    );
  }
  if (m.push) parts.push('Толкает: цель сдвигается на клетку от бьющего — в шипы, с высоты, из строя; некуда — просто урон.');
  if (m.gang !== undefined) parts.push(`Толпой больнее: +${m.gang} к множителю за каждого своего вплотную к цели.`);
  if (m.stepBack) parts.push('С отходом: после удара шаг на клетку строго от цели, если та свободна и не опасна.');
  if (m.twin) parts.push('По двум: удар делится между целью и ближайшим к бьющему другим врагом в той же дальности.');
  if (m.pair) {
    parts.push(
      'Дважды: за одно действие два броска по одной цели, оба по текущему штрафу — штраф растёт уже после приёма.',
    );
  }
  const persist = m.persist ?? w.persist;
  if (persist) {
    parts.push(
      `Оставляет ${persistRu(persist.type ?? type ?? 'fire')} −${persist.dmg}/ход: тление гасится броском d20 ≥ ${PERSIST_DC} в конце хода жертвы, помощь «сбить пламя» роняет порог до ${PERSIST_DC_ASSISTED}.`,
    );
  }
  if (m.ap !== undefined) parts.push('Весь ход в один приём: ни шага, ни обороны после него не останется.');
  if (m.dmgType && m.dmgType !== w.dmgType) {
    parts.push(`Тип урона — ${DAMAGE_TYPE_RU[m.dmgType]}, не как у оружия: против чужой брони это другой разговор.`);
  }
  return {
    name: m.name,
    meta: `${w.name} · ${SLOT_RU[m.slot]} темп · ${apRu(ap)} · ${dmgTypeRu(type)} · ${rangeRu(m.range ?? w.range)}`,
    chips: [
      { tone: 'ink', text: mapLadder(w, arch) },
      { tone: 'red', text: `урон ${Math.round(w.dmg * m.mult)}` },
      ...moveMarks(w, m).map((t): CardChip => ({ tone: 'line', text: t })),
    ],
    text: parts.join(' '),
    word: SLOT_WORD[m.slot],
  };
}

/** Чипс реакции класса: у ударных — бросок, у защитных — бонус к КБ. */
function reactionChips(r: ReactionKind, arch: HeroArchetype): CardChip[] {
  const melee = arch.weapons.find((w) => w.range === 1) ?? arch.weapons[0]!;
  const shot = arch.weapons.find((w) => w.range > 1) ?? melee;
  const strike = (w: WeaponSpec): CardChip[] => {
    const moves = movesOf(w);
    const m = moves.find((x) => x.slot === 'attack' && !x.ap) ?? moves[0]!;
    return [
      { tone: 'ink', text: `${signed(attackBonusOf(w))} · без повтора` },
      { tone: 'red', text: `урон ${Math.round(w.dmg * m.mult)}` },
    ];
  };
  switch (r) {
    case 'reactiveStrike':
    case 'noEscape':
    case 'retributiveStrike':
      return strike(melee);
    case 'disruptPrey':
      return strike(shot);
    case 'succor':
      return [{ tone: 'red', text: `+${SUCCOR_HEAL} hp` }];
    case 'nimbleDodge':
      return [{ tone: 'ink', text: `+${DODGE_AC} к КБ` }];
    case 'deflectArrow':
      return [{ tone: 'ink', text: `+${DEFLECT_AC} к КБ` }];
    case 'arcaneShield':
      return [
        { tone: 'ink', text: `+${ARCANE_SHIELD_AC} к КБ` },
        { tone: 'line', text: `гасит ${ARCANE_SHIELD_SOAK}` },
      ];
  }
}

/** Строки активов класса — та же азбука ромбов, что у приёмов. */
function activeRows(arch: HeroArchetype): CardRow[] {
  const a = arch.active;
  if (!a) return [];
  const rows: CardRow[] = [];
  const row = (key: string, name: string, ap: number, chips: CardChip[], text: string): CardRow => ({
    key,
    cost: '◆'.repeat(ap),
    name,
    marks: ['гейт словом'],
    chips,
    detail: { name, meta: `актив класса · ${apRu(ap)}`, chips, text },
  });
  if (a.rage) {
    rows.push(
      row('act:rage', 'впасть в ярость', AP_COST.rage, [
        { tone: 'red', text: `урон ×${a.rage.dmgMult}` },
        { tone: 'line', text: `входящий ×${a.rage.vulnMult}` },
      ], 'Раз в бой и до конца боя: бьёт крепче, но и получает больнее. Раз войдя — назад не выйти, поэтому вся цена в моменте.'),
    );
  }
  if (a.wall) {
    rows.push(
      row('act:wall', 'стена', AP_COST.wall, [
        { tone: 'ink', text: `+${COVER_AC} к КБ строю` },
        { tone: 'line', text: `${a.wall.usesPerBattle} на бой` },
      ], `Прикрытие себе и всем смежным своим до их следующего хода. Своего слова не просит — жмётся правилами «защищать» и «прикрывать отход».`),
    );
  }
  if (a.heal) {
    rows.push(
      row('act:heal', 'лечить', AP_COST.heal, [
        { tone: 'red', text: `+${a.heal.amount} hp` },
        { tone: 'line', text: `даль ${a.heal.range}` },
        { tone: 'line', text: `${a.heal.usesPerBattle} на бой` },
      ], 'Своему в дальности — очки жизни назад, но не выше максимума. Гейт — слово «лечить»: условие и вес выбирает игрок.'),
    );
  }
  if (a.bless) {
    rows.push(
      row('act:bless', 'благословить', AP_COST.bless, [
        { tone: 'red', text: `урон своего ×${a.bless.dmgMult}` },
        { tone: 'line', text: `даль ${a.bless.range}` },
        { tone: 'line', text: `${a.bless.usesPerBattle} на бой` },
      ], 'Атаки своего крепче до конца боя. Своего слова у благословения нет — жмётся врождённым правилом, цель выбирает скоринг.'),
    );
  }
  if (a.feint) {
    rows.push(
      row('act:feint', 'финт', AP_COST.feint, [{ tone: 'line', text: `открывает ×${SELFLESS_VULN_MULT}` }],
        'Смежный враг открыт до своего хода: входящее по нему идёт крепче — от всех сразу. Сетап под своих: «финт → все бьют».'),
    );
  }
  return rows;
}

/**
 * Строки площадных форм оружия (план aoe) — та же азбука ромбов: игрок видит
 * цену и урон зоны до того, как возьмёт слово каста.
 */
function aoeRows(w: WeaponSpec, wi: number): CardRow[] {
  const a = w.aoe;
  if (!a) return [];
  const rows: CardRow[] = [];
  const save = `Зона бьёт всех, кто в ней, — своих тоже; каждая жертва бросает спасбросок против ${SAVE_DC}: успех — половина урона, крит-успех — ничего.`;
  const add = (
    id: string,
    name: string,
    ap: number,
    mult: number,
    dmgType: DamageType | undefined,
    chips: CardChip[],
    text: string,
  ): void => {
    const all: CardChip[] = [{ tone: 'red', text: `${Math.round(w.dmg * mult)}` }, ...chips];
    rows.push({
      key: `aoe:${wi}:${id}`,
      cost: '◆'.repeat(ap),
      name,
      marks: ['гейт словом'],
      chips: all,
      detail: {
        name,
        meta: `${w.name} · площадное · ${apRu(ap)} · ${dmgTypeRu(dmgType ?? w.dmgType)}`,
        chips: all,
        text,
      },
    });
  };
  if (a.blast) {
    add('blast', 'заряд 3×3', AP_COST.aoeBlast, a.blast.mult, a.blast.dmgType, [
      { tone: 'line', text: `даль ${a.blast.range}` },
      ...(a.blast.usesPerBattle ? [{ tone: 'line' as const, text: `${a.blast.usesPerBattle} на бой` }] : []),
    ], `Мгновенный взрыв 3×3 вокруг выбранной клетки в дальности ${a.blast.range}. ${save}`);
  }
  if (a.line) {
    add('line', `волна 1×${a.line.len}`, AP_COST.aoeLine, a.line.mult, a.line.dmgType, [
      { tone: 'line', text: `длина ${a.line.len}` },
    ], `Мгновенная полоса 1×${a.line.len} от себя в одном из восьми направлений; камень обрывает взмах. ${save}`);
  }
  if (a.ritual) {
    const pulses = a.ritual.pulses && a.ritual.pulses > 1 ? ` Зона держится и жжёт ${a.ritual.pulses} хода подряд.` : '';
    const limit = a.ritual.cooldown
      ? `раз в ${a.ritual.cooldown} раунда`
      : a.ritual.usesPerBattle
        ? `${a.ritual.usesPerBattle} на бой`
        : 'без лимита';
    add('ritual', 'ритуал 5×5', AP_COST.aoeRitual, a.ritual.mult, a.ritual.dmgType, [
      { tone: 'line', text: `даль ${a.ritual.range}` },
      { tone: 'line', text: limit },
    ], `Замах — весь ход: зона 5×5 объявлена и видна, а бьёт в начале следующего хода кастера, по тем, кто из неё не вышел. Смерть кастера отменяет замах.${pulses} ${save}`);
  }
  return rows;
}

/** Секции вкладки «Приёмы»: по оружию, затем общие действия и реакция. */
function moveSections(arch: HeroArchetype): CardSection[] {
  const sections: CardSection[] = arch.weapons.map((w, wi) => ({
    title: w.name,
    meta: `${dmgTypeRu(w.dmgType)} · ${w.dmg} · ${rangeRu(w.range)}`,
    right: signed(attackBonusOf(w)),
    key: `w:${wi}`,
    detail: weaponDetail(w, arch),
    rows: [...movesOf(w).map((m): CardRow => {
      const detail = moveDetail(w, m, arch);
      return {
        key: `m:${wi}:${m.id}`,
        cost: '◆'.repeat(m.ap ?? AP_COST[m.slot]),
        name: m.name,
        marks: moveMarks(w, m),
        chips: [
          { tone: 'ink', text: mapLadder(w, arch) },
          { tone: 'red', text: String(Math.round(w.dmg * m.mult)) },
        ],
        detail,
      };
    }), ...aoeRows(w, wi)],
  }));

  const actives = activeRows(arch);
  if (actives.length > 0) {
    sections.push({ title: 'Классовое', meta: 'актив — раз в бой', right: 'своё у класса', rows: actives });
  }

  // цены общих действий — зеркало `apCostFor`: медленному осторожный шаг
  // стоит два очка, бастиону глухая оборона — два вместо трёх
  const stepAp = arch.stats.move <= 1 ? 2 : AP_COST.carefulStep;
  const braceAp = arch.passives?.steadfast ? 2 : AP_COST.fullCover;
  const common: CardRow[] = [
    {
      key: 'a:step',
      cost: '◆'.repeat(stepAp),
      name: 'осторожный шаг',
      marks: [],
      chips: [{ tone: 'line', text: 'без ответа' }],
      detail: {
        name: 'осторожный шаг',
        meta: `общее · ${apRu(stepAp)} · до ${arch.stats.move} кл.`,
        chips: [{ tone: 'line', text: 'не провоцирует' }],
        text: 'Выйти из контакта, ничего не заплатив. Бегом то же расстояние стоит удара от всякого, у кого цела реакция.',
      },
    },
    {
      key: 'a:cover',
      cost: '◆'.repeat(AP_COST.cover),
      name: 'прикрыться',
      marks: [],
      chips: [{ tone: 'ink', text: `+${COVER_AC} к КБ` }],
      detail: {
        name: 'прикрыться',
        meta: `общее · ${apRu(AP_COST.cover)} · до своего хода`,
        chips: [{ tone: 'ink', text: `+${COVER_AC} к КБ` }],
        text: `Бонус обстоятельств. С камнем, приманкой и щитом своего не складывается — берётся высший; за камнем прикрытие поднимается ступенью выше, до +${BRACE_AC}.`,
      },
    },
    {
      key: 'a:brace',
      cost: '◆'.repeat(braceAp),
      name: 'глухая оборона',
      marks: ['весь ход'],
      chips: [{ tone: 'ink', text: `+${BRACE_AC} к КБ` }],
      detail: {
        name: 'глухая оборона',
        meta: `общее · ${apRu(braceAp)} · до своего хода`,
        chips: [
          { tone: 'ink', text: `+${BRACE_AC} к КБ` },
          { tone: 'red', text: `рипост ${RIPOSTE_DMG}` },
        ],
        text: `Сегодня не воюю: ход уходит в защиту целиком. Ближний удар по стоящему в глухой ранит бьющего на ${RIPOSTE_DMG} — настойчивость врага превращается в его раны. Расчётливый приём (пирс) рипоста не ловит.`,
      },
    },
  ];
  if (arch.shield) {
    const sh = arch.shield;
    common.push({
      key: 'a:shield',
      cost: '◆'.repeat(AP_COST.raiseShield),
      name: 'поднять щит',
      marks: ['блок раз в раунд'],
      chips: [
        { tone: 'ink', text: `+${sh.ac} к КБ` },
        { tone: 'line', text: `гасит ${sh.hardness}` },
      ],
      detail: {
        name: 'поднять щит',
        meta: `щит · ${apRu(AP_COST.raiseShield)} · до своего хода`,
        chips: [
          { tone: 'ink', text: `+${sh.ac} к КБ` },
          { tone: 'line', text: `гасит ${sh.hardness}` },
          { tone: 'line', text: `запас ${sh.hp}` },
        ],
        text: `Бонус к КБ и блок: раз в раунд щит съедает ${sh.hardness} урона, забирая вмятины себе. Запас ${sh.hp} — дальше щит разваливается, и герой воюет без него до конца забега.`,
      },
    });
  }
  sections.push({ title: 'Ход и оборона', meta: 'общее для всех', right: `${AP_PER_TURN} очка на ход`, rows: common });

  if (arch.reaction) {
    const r = arch.reaction;
    const chips = reactionChips(r, arch);
    sections.push({
      title: 'Реакция',
      meta: 'одна в раунд — на всё',
      right: '◇',
      rows: [
        {
          key: 'r:reaction',
          cost: '◇',
          name: REACTION_RU[r],
          marks: [],
          chips,
          detail: {
            name: REACTION_RU[r],
            meta: `реакция · одна в раунд · в чужой ход`,
            chips,
            text: `${cap(describeReaction(r))}. Штраф за повтор в чужой ход обнулён — бьёт в полную силу; но карман один: потратил на ответ — закрыть собой своего уже нечем.`,
          },
        },
      ],
    });
  }
  return sections;
}

const chipHtml = (c: CardChip): string => `<span class="chip ${c.tone}">${esc(c.text)}</span>`;

function cardRowHtml(row: CardRow, open: string | null): string {
  return `<div class="mv-row ${open === row.key ? 'on' : ''}" data-action="card-move" data-move="${row.key}">
    <span class="cost">${row.cost}</span>
    <span class="nm">${esc(row.name)}</span>
    ${row.marks.map((m) => `<span class="rider">${esc(m)}</span>`).join('')}
    <span class="chips">${row.chips.map(chipHtml).join('')}</span>
  </div>`;
}

function movesTabHtml(arch: HeroArchetype, open: string | null): string {
  return moveSections(arch)
    .map(
      (s) => `<div class="mv-group">
      <div class="mv-head ${s.key ? 'clickable' : ''} ${open === s.key ? 'on' : ''}" ${
        s.key ? `data-action="card-move" data-move="${s.key}"` : ''
      }>
        <span class="nm">${esc(s.title)}</span>
        <span class="meta">${esc(s.meta)}</span>
        <span class="right">${esc(s.right)}</span>
      </div>
      ${s.rows.map((r) => cardRowHtml(r, open)).join('')}
    </div>`,
    )
    .join('');
}

/** Попап выбранной строки — живёт только на вкладке «Приёмы». */
function cardPopupHtml(arch: HeroArchetype, open: string | null): string {
  if (!open) return '';
  const sections = moveSections(arch);
  const detail =
    sections.find((s) => s.key === open)?.detail ??
    sections.flatMap((s) => s.rows).find((r) => r.key === open)?.detail;
  if (!detail) return '';
  return `<div class="card-popup">
    <div class="p-head">
      <span class="nm">${esc(detail.name)}</span>
      <button data-action="card-move" data-move="${open}">закрыть</button>
    </div>
    <span class="p-meta">${esc(detail.meta)}</span>
    <div class="chips">${detail.chips.map(chipHtml).join('')}</div>
    <p class="p-text">${esc(detail.text)}</p>
    ${detail.word ? `<div class="p-word">${esc(detail.word)}</div>` : ''}
  </div>`;
}

const SAVE_RU: Record<SaveKind, string> = { fort: 'стойкость', ref: 'реакция', will: 'воля' };

/** Чем аукнется слабейший спасбросок: спасброски в бою бросают против площадных. */
const SAVE_WEAK_NOTE: Record<SaveKind, string> = {
  fort: 'ядовитые зоны и отрава берут его крепче прочих.',
  ref: 'площадные залпы и волны накрывают его целиком.',
  will: 'разумовые чары проходят по нему легче всего.',
};

function aboutTabHtml(hero: HeroState, arch: HeroArchetype, hp?: number): string {
  const d = arch.defenses;
  const saves: SaveKind[] = ['fort', 'ref', 'will'];
  const saveVal = (k: SaveKind): number => d?.[k] ?? DEFAULT_SAVE;
  const weakest = saves.reduce((a, b) => (saveVal(b) < saveVal(a) ? b : a));
  const stat = (label: string, value: string): string =>
    `<span class="s-row"><span>${label}</span><span class="v">${esc(value)}</span></span>`;

  const dmgRows: string[] = [];
  const line = (chip: CardChip, text: string): string =>
    `${chipHtml(chip)}<span class="d-text">${esc(text)}</span>`;
  for (const [t, n] of Object.entries(d?.resist ?? {})) {
    dmgRows.push(line({ tone: 'ink', text: `сопр ${n}` }, `${DAMAGE_TYPE_RU[t as DamageType]} — каждое попадание слабее на ${n}`));
  }
  for (const [t, n] of Object.entries(d?.weak ?? {})) {
    dmgRows.push(line({ tone: 'red', text: `слаб ${n}` }, `${DAMAGE_TYPE_RU[t as DamageType]} — каждое попадание крепче на ${n}`));
  }
  for (const t of d?.immune ?? []) {
    dmgRows.push(line({ tone: 'line', text: 'имм' }, `${DAMAGE_TYPE_RU[t]} — не берёт вовсе`));
  }

  // характер выучивается по бою: до реплики в бою линза стоит вопросом
  const revealed = (l: LensId): boolean =>
    debugLenses ||
    // характер открыт ровно с того кадра, где он проговорился, — раскрытия
    // из ещё не показанной части боя не спойлерим
    battleReveals.some((r) => r.unit === hero.id && r.lens === l && r.frame <= frameIdx);
  const lensChips = hero.lenses
    .map((l) =>
      revealed(l)
        ? `<span class="chip line">${esc(LENS_RU[l])}</span>`
        : `<span class="chip unknown">? ещё не открыто</span>`,
    )
    .join('');
  const lensNotes = hero.lenses
    .filter(revealed)
    .map((l) => `<div class="note">${LENS_HINT[l]}</div>`)
    .join('');

  return `<div class="card-body">
    <div class="c-block">
      <span class="kicker">характеристики</span>
      <div class="stat-grid">
        ${stat('жизни', hp === undefined ? `${arch.stats.maxHp}` : `${hp}/${arch.stats.maxHp}`)}
        ${stat('инициатива', String(arch.stats.speed))}
        ${stat('шаг', `${arch.stats.move} кл.`)}
      </div>
    </div>
    <div class="c-block">
      <span class="kicker">защиты и спасброски</span>
      <div class="chips">
        <span class="chip ink">КБ ${d?.ac ?? DEFAULT_AC}</span>
        ${saves.map((k) => `<span class="chip line">${SAVE_RU[k]} ${saveVal(k)}</span>`).join('')}
      </div>
      <div class="note serif">Слабейший спасбросок — ${SAVE_RU[weakest]}: ${SAVE_WEAK_NOTE[weakest]}</div>
    </div>
    <div class="c-block">
      <span class="kicker">урон: как его берут</span>
      ${
        dmgRows.length > 0
          ? `<div class="dmg-grid">${dmgRows.join('')}</div>`
          : '<div class="note serif">Особых сопротивлений нет: любой тип входит ровно.</div>'
      }
    </div>
    <div class="c-block">
      <span class="kicker">характер · выучивается по бою</span>
      <div class="chips">${lensChips}</div>
      ${lensNotes}
    </div>
    <div class="c-block ability">
      <span class="kicker">способность · врождённое правило</span>
      <div class="hand">${esc(arch.ability.name)} — ${esc(arch.ability.desc)}.</div>
      ${arch.passives ? `<div class="note">пассивы · ${esc(describePassives(arch.passives))}</div>` : ''}
    </div>
  </div>`;
}

/**
 * Вкладка «Инвентарь» — заглушка: предметов в коде ещё нет, но смысл вкладки
 * читается уже сейчас (оружие как источник приёмов).
 */
function bagTabHtml(arch: HeroArchetype): string {
  const items = arch.weapons
    .map(
      (w) => `<div class="bag-row">
        <span class="mark">✦</span>
        <span class="b-body">
          <span class="nm">${esc(w.name)}</span>
          <span class="sub">оружие · ${esc(dmgTypeRu(w.dmgType))} ${w.dmg} · даёт ${esc(
            movesOf(w)
              .map((m) => `«${m.name}»`)
              .join(', '),
          )}</span>
        </span>
      </div>`,
    )
    .join('');
  return `<div class="card-body bag">
    <div class="c-head">
      <span class="kicker">носит с собой</span>
      <span class="chip unknown">в разработке</span>
    </div>
    <div class="bag-list">
      ${items}
      <div class="bag-row empty"><span class="mark">+</span><span class="hand">пустой слот — сюда ляжет добыча похода</span></div>
    </div>
    <div class="hand note">Предметы — источник приёмов и слов: уберёшь молот — исчезнут и его приёмы во вкладке «Приёмы».</div>
  </div>`;
}

function unitCardHtml(id: string): string {
  const node = currentNode(run);
  const hero = run.heroes.find((h) => h.id === id);
  if (hero) {
    const arch = heroArchetype(hero.archetypeId);
    const live = unitHpInBattle(id) ?? (hero.alive ? { hp: hero.hp, alive: true } : undefined);
    // попап живёт только на вкладке приёмов — на прочих список не раскрывается
    const open = cardTab === 'moves' ? cardMove : null;
    const body =
      cardTab === 'about'
        ? aboutTabHtml(hero, arch, live?.hp)
        : cardTab === 'bag'
          ? bagTabHtml(arch)
          : `<div class="card-body">${movesTabHtml(arch, open)}</div>`;
    const tab = (t: CardTab, label: string): string =>
      `<button class="c-tab ${cardTab === t ? 'on' : ''}" data-action="card-tab" data-tab="${t}">${label}</button>`;
    return `<div class="overlay" data-close="card"><div class="card-wrap">
      <div class="modal unit-card">
        <div class="head">
          <span class="title">${esc(hero.name)}</span>
          <span class="sub">${esc(arch.class)} · ${esc(arch.title)}</span>
          <span class="meta">${live?.alive === false || !hero.alive ? 'пал(а) · ' : ''}hp ${
            live?.hp ?? hero.hp
          }/${arch.stats.maxHp} · КБ ${arch.defenses?.ac ?? DEFAULT_AC} · приказы ${hero.phrases.length}/${hero.slots}</span>
        </div>
        <div class="c-tabs">${tab('about', 'Описание')}${tab('moves', 'Приёмы')}${tab('bag', 'Инвентарь')}</div>
        ${body}
        <div class="foot-row"><span class="spacer"></span><button class="primary" data-action="close-card">закрыть</button></div>
      </div>
      ${cardPopupHtml(arch, open)}
    </div></div>`;
  }
  if (!FIGHT_KINDS.includes(node.kind)) return '';
  const spec = foesForNode(node).find((f) => f.id === id);
  if (!spec) return '';
  const live = unitHpInBattle(id);
  // принципы врага — покупка разведки (спека 2a), а не бесплатная справка узла
  const bought = run.intel.orders.includes(id);
  const principles = bought
    ? foeOrdersLines(spec).map((l) => `<div class="read-note">«${esc(l)}»</div>`).join('')
    : `<div class="orders-text"><span class="empty">принципы не куплены — прочтёшь по ходу боя</span></div>`;
  return `<div class="overlay" data-close="card"><div class="modal unit-card">
    <div class="head">
      <span class="title">${esc(spec.name)}</span>
      ${lensTagHtml(spec.lenses)}
      <span class="meta">${live?.alive === false ? 'пал' : 'противник'}</span>
    </div>
    <div class="stat-line">${statLine(spec, live?.hp)}</div>
    <div class="card-block">
      <span class="kicker">${bought ? 'принципы — они тоже читают' : 'принципы'}</span>
      ${principles}
    </div>
    <div class="foot-row"><span class="spacer"></span><button class="primary" data-action="close-card">закрыть</button></div>
  </div></div>`;
}

// ---------- оверлей: свиток боя (полный лог) ----------

/** Фактор решения человеческими словами: «твоё слово „…“», а не имя условия. */
function factorRu(f: Frame['factors'][number], side: Side | undefined): string {
  const base = f.label.startsWith(RULE_PREFIX)
    ? side === 'party'
      ? `твоё слово «${f.label.slice(RULE_PREFIX.length)}»`
      : `его правило «${f.label.slice(RULE_PREFIX.length)}»`
    : f.label;
  const twisted =
    f.label.startsWith(RULE_PREFIX) &&
    battleReveals.some((r) => r.source === f.label.slice(RULE_PREFIX.length));
  const tail = tactician ? ` · ${f.value >= 0 ? '+' : ''}${f.value.toFixed(1)}` : '';
  return `${base}${twisted ? ' — понято по-своему' : ''}${tail}`;
}

/** Блок «почему так»: ровно три главных фактора по весу в решении. */
function whyHtml(i: number, f: Frame): string {
  const side = f.units.find((u) => u.id === f.actorId)?.side;
  const top = [...f.factors].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 3);
  const gap = !f.factors.some((x) => x.label.startsWith(RULE_PREFIX));
  const lens = battleReveals.find((r) => r.unit === f.actorId)?.lens;
  const rows = top
    .map((x, n) => `<div class="wy-row"><span class="n${n === 0 ? ' lead' : ''}">${n + 1}.</span>${esc(factorRu(x, side))}</div>`)
    .join('');
  return `<div class="log-why">
    <span class="kicker">почему так · ${gap ? 'достройка пропуска' : 'три главных фактора'}</span>
    ${rows || '<div class="wy-row">решение без слагаемых: выбора не было</div>'}
    <div class="wy-acts">
      <span class="wy-chip" data-action="log-jump" data-frame="${i}">↩ к этому кадру</span>
      ${
        side === 'party'
          ? `<span class="wy-chip" data-action="log-rewrite" data-hero="${f.actorId}">переписать это слово</span>`
          : ''
      }
      <span class="wy-chip off">${debugLenses && lens ? esc(LENS_RU[lens]) : 'имя характера — только в debug'}</span>
    </div>
  </div>`;
}

/** Остаток очков хода у героев в этом раунде — ромбами, той же азбукой. */
function roundPipsHtml(round: number): string {
  const spent = new Map<string, number>();
  for (const f of frames) {
    if (f.round === round && f.cost > 0) spent.set(f.actorId, (spent.get(f.actorId) ?? 0) + f.cost);
  }
  const parts = run.heroes
    .filter((h) => h.alive)
    .map((h) => {
      const used = Math.min(AP_PER_TURN, spent.get(h.id) ?? 0);
      return `${esc(h.name)} ${'◆'.repeat(AP_PER_TURN - used)}${'◇'.repeat(used)}`;
    });
  return parts.length ? `очки: ${parts.join(' · ')}` : '';
}

function battleLogHtml(): string {
  if (!battle) return '';
  const node = currentNode(run);
  const deadline = nodeDeadline(node);
  const rows: string[] = [];
  let round = 0;
  frames.forEach((f, i) => {
    if (i === 0) return;
    if (f.round !== round) {
      round = f.round;
      rows.push(`<div class="log-round">
        <span class="lr-t">— ход ${round} —</span><span class="lr-line"></span>
        <span class="lr-pips">${roundPipsHtml(round)}</span>
      </div>`);
    }
    // реплика характера — только на первое срабатывание; дальше строка идёт сухо
    const quip = battleReveals.find((r) => r.frame === i && r.unit === f.actorId);
    const open = tactician || logRow === i;
    rows.push(`<div class="log-item">
      <div class="log-row ${i === frameIdx ? 'cur' : ''}${open ? ' open' : ''}" data-action="log-row" data-row="${i}">
        <span class="t">${f.round}.${i}</span>
        <span class="c">${costPips(f.cost)}</span>
        <span class="x"><b>${esc(f.actorName)}</b> ${esc(f.text)}</span>
      </div>
      ${quip ? `<div class="log-voice ${quip.side === 'party' ? 'own' : 'foe'}">${esc(quip.quip)}</div>` : ''}
      ${open ? whyHtml(i, f) : ''}
    </div>`);
  });
  const outcome =
    battle.winner === 'party' ? 'поле за тобой' : battle.winner === 'draw' ? 'ничья' : 'отряд разбит';
  const cur = frames[frameIdx]!;
  return `<div class="overlay" data-close="log"><div class="modal battle-log">
    <div class="head">
      <span class="title">Свиток боя</span>
      <span class="meta">seed ${run.runSeed} · ${frames.length - 1} решений</span>
      ${deadline ? `<span class="chip red" style="margin-left:auto">раунд ${cur.round} из ${deadline}</span>` : ''}
    </div>
    <div class="log-scroll">${rows.join('')}
      <div class="log-end">исход: ${outcome} · раундов: ${battle.rounds}</div>
    </div>
    <div class="foot-row">
      <span class="log-note">реплика — только на первое срабатывание; дальше та же строка идёт сухо, без спама</span>
      <span class="spacer"></span>
      <button class="tact-btn ${tactician ? 'on' : ''}" data-action="toggle-tact">режим тактика</button>
      <button class="primary" data-action="close-log">закрыть</button>
    </div>
  </div></div>`;
}

// ---------- оверлей: конец забега ----------

function runEndHtml(): string {
  const won = run.status === 'won';
  const title = won ? 'Вождь орды пал' : 'Забег окончен';
  const quip = won
    ? 'Поход пройден. Дневник можно переплести в кожу получше.'
    : 'Слова кончились раньше, чем враги.';
  const lines = run.log.slice(-5).map((l) => `<div>${esc(l)}</div>`).join('');
  return `<div class="overlay">
    <div class="modal aftermath ${won ? '' : 'loss'}">
      <div class="head"><span class="title">${title}</span></div>
      <div class="ab-voice" style="margin-left:0">${esc(quip)}</div>
      <div class="ab-lines">${lines}</div>
      <div class="btn-row" style="margin-top:4px">
        <button data-action="export-build">${won ? 'вот мой билд, побей мой сид' : 'экспорт билда'}</button>
        <button data-action="export-journal">журнал плейтеста</button>
        <button data-action="open-debug">собрать бой</button>
        <span class="spacer"></span>
        <button class="primary" data-action="new-run">новый забег (seed ${run.runSeed + 1})</button>
      </div>
    </div>
  </div>`;
}

// ---------- сборка и биндинги ----------

function computeFit(): number {
  return Math.min(1, (window.innerWidth - 16) / 960, (window.innerHeight - 16) / 640);
}

function bookTransform(): string {
  return `translate(-50%,-50%) scale(${fitScale})`;
}

function render(): void {
  const node = currentNode(run);
  const prep = prepOpen && run.status === 'ongoing' && !run.resolved && FIGHT_KINDS.includes(node.kind);
  const screen = battle
    ? battleScreenHtml()
    : prep
      ? prepScreenHtml()
      : run.status === 'ongoing' && node.kind === 'scriptorium' && !run.resolved
        ? scriptoriumHtml()
        : mapScreenHtml();
  const cardHtml = unitCardId ? unitCardHtml(unitCardId) : '';
  const overlay = debugOpen
    ? debugPanelHtml()
    : editorOpen
      ? editorHtml()
      : battle && logOpen
        ? battleLogHtml()
        : cardHtml
          ? cardHtml
          : battle && aftermathOpen
            ? aftermathHtml()
            : !battle && run.status !== 'ongoing'
              ? runEndHtml()
              : '';
  app.innerHTML = `<div class="stage">
    <div class="book" style="transform:${bookTransform()}">${screen}${overlay}</div>
  </div>`;
  bind();
  if (battle && logOpen) {
    app.querySelector('.log-row.cur')?.scrollIntoView({ block: 'center' });
  }
}

function draftsFromEditor(heroId: string): PhraseDraft[] {
  const rows = [...app.querySelectorAll<HTMLSelectElement>(`.cond-select[data-hero="${heroId}"][data-level="0"]`)];
  return rows.map((condSel) => {
    const idx = condSel.dataset.idx!;
    // глубокие чипсы: уровни условия собираются в конъюнкцию «и»
    const conds: CondLinkDraft[] = [];
    for (const lvl of [0, 1, 2]) {
      const sel = app.querySelector<HTMLSelectElement>(
        `.cond-select[data-hero="${heroId}"][data-idx="${idx}"][data-level="${lvl}"]`,
      );
      if (!sel) continue;
      const c = JSON.parse(sel.value) as SimpleConditionDraft;
      if (c.id === 'always') continue;
      // «не» — галочка рядом со звеном, а не отдельный чипс словаря
      const neg = app.querySelector<HTMLInputElement>(
        `.neg-check[data-hero="${heroId}"][data-idx="${idx}"][data-level="${lvl}"]`,
      );
      conds.push(neg?.checked ? { id: 'not', cond: c } : c);
    }
    const opSel = app.querySelector<HTMLSelectElement>(
      `.op-select[data-hero="${heroId}"][data-idx="${idx}"]`,
    );
    const op: 'and' | 'or' = opSel?.value === 'or' ? 'or' : 'and';
    const condition: ConditionDraft =
      conds.length === 0 ? { id: 'always' } : conds.length === 1 ? conds[0]! : { id: op, conds };
    const prefSel = app.querySelector<HTMLSelectElement>(`.pref-select[data-hero="${heroId}"][data-idx="${idx}"]`)!;
    // вес игроку не показывается: единственный рычаг приоритета — фокус,
    // и он живёт на самой фразе, а не в селекте важности
    const kept = run.heroes.find((h) => h.id === heroId)?.phrases[Number(idx)]?.weight ?? 1;
    return {
      condition,
      preference: JSON.parse(prefSel.value) as PreferenceDraft,
      weight: kept,
    };
  });
}

function bind(): void {
  for (const sel of app.querySelectorAll<HTMLSelectElement>('select.dbg-battle')) {
    sel.addEventListener('change', () => {
      debugDraft.battle = sel.value;
      render();
    });
  }
  for (const sel of app.querySelectorAll<HTMLSelectElement>('select.dbg-hero')) {
    sel.addEventListener('change', () => {
      const i = Number(sel.dataset.slot);
      debugDraft.party[i] = { archetypeId: sel.value, lenses: sel.value ? (debugDraft.party[i]?.lenses ?? []) : [] };
      debugError = '';
      render();
    });
  }
  for (const inp of app.querySelectorAll<HTMLInputElement>('input.dbg-nerve')) {
    inp.addEventListener('change', () => {
      debugDraft.nerve = inp.checked;
      render();
    });
  }
  for (const inp of app.querySelectorAll<HTMLInputElement>('input.dbg-seed')) {
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      debugDraft.seed = Number.isFinite(v) && v > 0 ? Math.floor(v) : 1;
      render();
    });
  }
  for (const sel of app.querySelectorAll<HTMLSelectElement>('select[data-hero]')) {
    sel.addEventListener('change', () => {
      const heroId = sel.dataset.hero!;
      const r = applyPhrases(heroId, draftsFromEditor(heroId));
      editError[heroId] = r.ok ? '' : r.error;
      delete heroUncertainty[heroId]; // правка чипсами — заметки компилятора устарели
      render();
    });
  }
  for (const inp of app.querySelectorAll<HTMLInputElement>('input.neg-check')) {
    inp.addEventListener('change', () => {
      const heroId = inp.dataset.hero!;
      const r = applyPhrases(heroId, draftsFromEditor(heroId));
      editError[heroId] = r.ok ? '' : r.error;
      delete heroUncertainty[heroId];
      render();
    });
  }
  for (const ta of app.querySelectorAll<HTMLTextAreaElement>('textarea.principle-text')) {
    const heroId = ta.dataset.hero!;
    // перерисовки на каждый ввод нет (сбила бы каретку), поэтому «применить»
    // включаем прямо здесь — иначе кнопка остаётся серой до следующего render
    const apply = app.querySelector<HTMLButtonElement>(`button[data-action="compile-text"][data-hero="${heroId}"]`);
    ta.addEventListener('input', () => {
      heroText[heroId] = ta.value;
      if (apply) apply.disabled = Boolean(compiling[heroId]) || !ta.value.trim();
    });
  }
  for (const inp of app.querySelectorAll<HTMLInputElement>('input.set-note')) {
    inp.addEventListener('change', () => {
      const hero = run.heroes.find((h) => h.id === inp.dataset.hero);
      const set = hero?.sets[hero.activeSet];
      if (set) set.note = inp.value.trim();
    });
  }
  for (const ta of app.querySelectorAll<HTMLTextAreaElement>('textarea.intent-text')) {
    ta.addEventListener('change', () => {
      const hero = run.heroes.find((h) => h.id === ta.dataset.hero);
      if (!hero) return;
      heroIntent[hero.id] = ta.value;
      recordEvent({
        t: 'intent',
        hero: hero.name,
        lenses: hero.lenses,
        vocab: run.vocab.length,
        seed: run.runSeed,
        text: ta.value,
      });
    });
  }
  // закладка A/B/C: клик переключает набор (обычный data-action), дабл-клик
  // довозит до редактора — правка того набора, на который уже перешли
  for (const el of app.querySelectorAll<HTMLElement>('.sq-set')) {
    el.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      editHero = el.dataset.hero!;
      editorOpen = true;
      render();
    });
  }
  for (const tok of app.querySelectorAll<HTMLElement>('.btoken[data-unit]')) {
    tok.addEventListener('click', () => {
      unitCardId = tok.dataset.unit!;
      cardTab = 'moves';
      cardMove = null;
      playing = false;
      stopTimer();
      render();
    });
  }
  // клик по подложке оверлея — то же, что «закрыть»; какое окно закрывать,
  // говорит data-close на самой подложке
  const backdropClose: Record<string, () => void> = {
    text: () => {
      textOpen = false;
    },
    vocab: () => {
      vocabOpen = false;
    },
    editor: () => {
      editorOpen = false;
      textOpen = false;
      vocabOpen = false;
    },
    debug: () => {
      debugOpen = false;
    },
    aftermath: () => {
      aftermathOpen = false;
    },
    card: () => {
      unitCardId = null;
    },
    log: () => {
      logOpen = false;
    },
  };
  for (const ov of app.querySelectorAll<HTMLElement>('.overlay[data-close]')) {
    // выделение текста в модалке часто кончается отпусканием мыши на подложке —
    // закрываем только когда клик и начался на ней
    let downOnBackdrop = false;
    ov.addEventListener('mousedown', (ev) => {
      downOnBackdrop = ev.target === ov;
    });
    ov.addEventListener('click', (ev) => {
      if (ev.target !== ov || !downOnBackdrop) return;
      backdropClose[ov.dataset.close!]?.();
      render();
    });
  }
  for (const el of app.querySelectorAll<HTMLElement>('[data-action]')) {
    el.addEventListener('click', (ev) => {
      // вложенные действия: кнопка комплекта внутри строки расстановки —
      // срабатывает внутреннее, а не оба сразу
      ev.stopPropagation();
      const a = el.dataset.action!;
      switch (a) {
        case 'log-row': {
          const n = Number(el.dataset.row);
          logRow = logRow === n ? null : n;
          render();
          break;
        }
        case 'log-jump':
          frameIdx = Number(el.dataset.frame);
          logOpen = false;
          logRow = null;
          aftermathOpen = false;
          playing = false;
          stopTimer();
          render();
          break;
        case 'log-rewrite':
          editHero = el.dataset.hero!;
          editorOpen = true;
          logOpen = false;
          playing = false;
          stopTimer();
          render();
          break;
        case 'prep':
          prepOpen = true;
          render();
          break;
        case 'back-to-map':
          prepOpen = false;
          deployPick = null;
          render();
          break;
        case 'buy-intel': {
          const kind = el.dataset.buy as 'map' | 'numbers' | 'orders';
          buyIntel(run, kind === 'map' ? { kind } : { kind, foeId: el.dataset.foe! });
          render();
          break;
        }
        case 'pick-node':
          mapPick = Number(el.dataset.node);
          render();
          break;
        case 'go-node': {
          const to = Number(el.dataset.node);
          if (advance(run, to).ok) {
            visited.add(to);
            fightsAtNode = 0;
            rewroteSinceBattle = false;
            mapPick = null;
            prepOpen = false;
          }
          lessonNudge = false;
          render();
          break;
        }
        case 'fight':
          startBattle();
          break;
        case 'skip-lesson':
          skipLesson(run);
          lessonNudge = false;
          prepOpen = false;
          render();
          break;
        case 'mark-foe': {
          const foe = el.dataset.foe!;
          setMark(run, run.marked === foe ? null : foe);
          render();
          break;
        }
        case 'deploy-pick': {
          const hero = el.dataset.hero!;
          deployPick = deployPick === hero ? null : hero;
          render();
          break;
        }
        case 'deploy-cell': {
          if (!deployPick) break;
          const r = setDeploy(run, deployPick, { x: Number(el.dataset.x), y: Number(el.dataset.y) });
          if (r.ok) deployPick = null;
          render();
          break;
        }
        case 'squad-tab':
          squadTab = el.dataset.tab as 'party' | 'fallen';
          render();
          break;
        case 'unit-card':
          unitCardId = el.dataset.unit!;
          // быстрый доступ с карточки отряда открывает лист сразу на своей вкладке
          cardTab = (el.dataset.cardTab as CardTab | undefined) ?? 'moves';
          cardMove = null;
          playing = false;
          stopTimer();
          render();
          break;
        case 'close-card':
          unitCardId = null;
          render();
          break;
        case 'card-tab':
          cardTab = el.dataset.tab as CardTab;
          render();
          break;
        case 'card-move': {
          // повторный клик по той же строке сворачивает попап
          const key = el.dataset.move!;
          cardMove = cardMove === key ? null : key;
          render();
          break;
        }
        case 'open-log':
          logOpen = true;
          playing = false;
          stopTimer();
          render();
          break;
        case 'close-log':
          logOpen = false;
          render();
          break;
        case 'edit-set': {
          // полоска набора ведёт в редактор на этом герое; набор уже действующий
          const heroId = el.dataset.hero!;
          if (run.heroes.some((h) => h.alive && h.id === heroId)) editHero = heroId;
          editorOpen = true;
          playing = false;
          render();
          break;
        }
        case 'open-editor': {
          const firstAlive = run.heroes.find((h) => h.alive);
          if (!run.heroes.find((h) => h.alive && h.id === editHero) && firstAlive) editHero = firstAlive.id;
          editorOpen = true;
          playing = false;
          render();
          break;
        }
        case 'close-editor':
          editorOpen = false;
          textOpen = false;
          vocabOpen = false;
          render();
          break;
        case 'sel-hero':
          editHero = el.dataset.hero!;
          render();
          break;
        case 'clear-phrase': {
          const heroId = el.dataset.hero!;
          const drafts = draftsFromEditor(heroId);
          drafts.splice(Number(el.dataset.idx), 1);
          const r = applyPhrases(heroId, drafts);
          editError[heroId] = r.ok ? '' : r.error;
          delete heroUncertainty[heroId];
          render();
          break;
        }
        case 'add-phrase': {
          const heroId = el.dataset.hero!;
          const drafts = [
            ...draftsFromEditor(heroId),
            { condition: { id: 'always' } as const, preference: { id: 'act.attack', target: 'sel.nearest' } as const },
          ];
          const r = applyPhrases(heroId, drafts);
          editError[heroId] = r.ok ? '' : r.error;
          delete heroUncertainty[heroId];
          render();
          break;
        }
        case 'switch-set': {
          const heroId = el.dataset.hero!;
          const r = switchOrderSet(run, heroId, Number(el.dataset.set));
          editError[heroId] = r.ok ? '' : r.error;
          if (r.ok) {
            ordersDirty = Boolean(battle);
            rewroteSinceBattle = true;
            delete heroUncertainty[heroId];
            delete heroText[heroId];
          }
          render();
          break;
        }
        case 'toggle-focus': {
          const heroId = el.dataset.hero!;
          const idx = Number(el.dataset.idx);
          const hero = run.heroes.find((h) => h.id === heroId)!;
          const on = (hero.phrases[idx]?.weight ?? 1) >= 3;
          const r = setFocus(run, heroId, on ? null : idx);
          editError[heroId] = r.ok ? '' : r.error;
          if (r.ok) {
            ordersDirty = Boolean(battle);
            rewroteSinceBattle = true;
          }
          render();
          break;
        }
        case 'open-text': {
          const heroId = el.dataset.hero!;
          const hero = run.heroes.find((h) => h.id === heroId)!;
          heroText[heroId] ??= hero.sets[hero.activeSet]?.text ?? '';
          textOpen = true;
          editError[heroId] = '';
          render();
          break;
        }
        case 'close-text':
          textOpen = false;
          render();
          break;
        case 'open-vocab':
          vocabOpen = true;
          render();
          break;
        case 'close-vocab':
          vocabOpen = false;
          render();
          break;
        case 'vocab-filter':
          vocabFilter = (el.dataset.cat as ConceptCategory | undefined) ?? null;
          render();
          break;
        case 'compile-text':
          void compileHeroText(el.dataset.hero!);
          break;
        case 'toggle-debug':
          debugLenses = !debugLenses;
          render();
          break;
        case 'toggle-nerve':
          // режим на весь забег: следующий бой узла считается с разбросом весов
          run.nerve = run.nerve ? 0 : NERVE_AMP;
          render();
          break;
        case 'open-debug':
          openDebugPanel();
          render();
          break;
        case 'close-debug':
          debugOpen = false;
          render();
          break;
        case 'debug-lens': {
          const slot = debugDraft.party[Number(el.dataset.slot)];
          const lens = el.dataset.lens as LensId;
          if (slot) {
            slot.lenses = slot.lenses.includes(lens)
              ? slot.lenses.filter((l) => l !== lens)
              : [...slot.lenses, lens];
          }
          render();
          break;
        }
        case 'debug-build':
          debugBuild();
          render();
          break;
        case 'free-vocab':
          unlockAllWords();
          render();
          break;
        case 'toggle-play':
          if (frameIdx >= frames.length - 1) {
            aftermathOpen = true;
            playing = false;
            render();
          } else {
            playing = !playing;
            if (playing) runTimer();
            syncBattleFrame();
          }
          break;
        case 'step-back':
          playing = false;
          aftermathOpen = false;
          if (frameIdx > 0) frameIdx--;
          if (app.querySelector('.overlay')) render();
          else syncBattleFrame();
          break;
        case 'step-fwd':
          playing = false;
          if (frameIdx < frames.length - 1) {
            frameIdx++;
            syncBattleFrame();
          } else {
            aftermathOpen = true;
            render();
          }
          break;
        case 'set-speed': {
          speed = Number(el.dataset.sp);
          if (playing) runTimer();
          render();
          break;
        }
        case 'toggle-tact':
          tactician = !tactician;
          render();
          break;
        case 'sparring':
          stopTimer();
          startBattle();
          break;
        case 'accept':
          acceptOutcome();
          break;
        case 'buy-concept':
          chooseInScriptorium(run, { kind: 'concept', id: el.dataset.concept as ConceptId });
          render();
          break;
        case 'reward-take':
          claimReward(run, { kind: 'option', index: Number(el.dataset.index) });
          render();
          break;
        case 'reward-skip':
          claimReward(run, { kind: 'skip' });
          render();
          break;
        case 'buy-slot':
          chooseInScriptorium(run, { kind: 'slot', heroId: el.dataset.hero! });
          render();
          break;
        case 'skip':
          chooseInScriptorium(run, { kind: 'skip' });
          render();
          break;
        case 'event-take':
          chooseInEvent(run, { kind: 'take' });
          render();
          break;
        case 'event-hire':
          chooseInEvent(run, { kind: 'hire' });
          render();
          break;
        case 'event-skip':
          chooseInEvent(run, { kind: 'skip' });
          render();
          break;
        case 'rest':
          rest(run);
          render();
          break;
        case 'new-run':
          location.search = `?seed=${run.runSeed + 1}`;
          break;
        case 'export-journal': {
          const report = journalReport(journal);
          const label = el.textContent;
          const download = (): void => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([report], { type: 'text/plain' }));
            a.download = 'playtest-journal.txt';
            a.click();
            URL.revokeObjectURL(a.href);
          };
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(report).then(() => {
              el.textContent = 'журнал скопирован ✓';
              setTimeout(() => {
                el.textContent = label;
              }, 1500);
            }, download);
          } else {
            download();
          }
          break;
        }
        case 'export-build': {
          const url = `${location.origin}${location.pathname}?build=${exportBuild(run)}`;
          const label = el.textContent;
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(url).then(
              () => {
                el.textContent = 'ссылка скопирована ✓';
                setTimeout(() => {
                  el.textContent = label;
                }, 1500);
              },
              () => window.prompt('Скопируй ссылку на билд:', url),
            );
          } else {
            window.prompt('Скопируй ссылку на билд:', url);
          }
          break;
        }
      }
    });
  }
}

// ---------- старт ----------

// ленту решений и полосу отряда перерисовывает syncBattleFrame на каждом кадре,
// поэтому их клики и клавиши транспорта висят делегированно — один раз на всё
app.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-feed],[data-party]');
  if (!el) return;
  if (el.dataset.feed !== undefined) {
    frameIdx = Number(el.dataset.feed);
    playing = false;
    stopTimer();
  } else {
    unitCardId = el.dataset.party!;
    cardTab = 'moves';
    cardMove = null;
    playing = false;
    stopTimer();
  }
  render();
});

window.addEventListener('keydown', (ev) => {
  if (!battle || editorOpen || logOpen || debugOpen || unitCardId || aftermathOpen) return;
  if (ev.key === ' ') {
    ev.preventDefault();
    playing = !playing;
    if (playing) runTimer();
    else stopTimer();
    syncBattleFrame();
  } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    ev.preventDefault();
    playing = false;
    stopTimer();
    frameIdx = Math.min(frames.length - 1, Math.max(0, frameIdx + (ev.key === 'ArrowRight' ? 1 : -1)));
    syncBattleFrame();
  }
});

fitScale = computeFit();
window.addEventListener('resize', () => {
  fitScale = computeFit();
  const book = app.querySelector<HTMLElement>('.book');
  if (book) book.style.transform = bookTransform();
});
render();
