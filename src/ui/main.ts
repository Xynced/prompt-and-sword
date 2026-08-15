import { type BattleEvent, type BattleResult, type UnitSpec, runBattle, spawnPreview } from '../battle.js';
import { type Tile, pickTerrain } from '../terrain.js';
import { GRID_H, GRID_W } from '../grid.js';
import { describeActive, describePassives, describeWeapons, driftQuip, lensQuip, understandingCard } from '../cards.js';
import {
  ROLE_CONCEPT,
  type ConditionDraft,
  type PhraseDraft,
  type PreferenceDraft,
  type SimpleConditionDraft,
  compilePhrase,
  describeDraft,
} from '../constructor.js';
import { type ModelCall, anthropicModelCall, compileFreeText } from '../compiler/compile.js';
import type { CompilerCache } from '../compiler/cache.js';
import type { CompilerOutput } from '../compiler/schema.js';
import { ALLY_ROLE_RU, BATTLE_DRAGS_ROUND, type AllyRef, type AllyRole, type Rule } from '../ir.js';
import { CONCEPTS, type ConceptId } from '../vocab.js';
import {
  type MapNode,
  type NodeKind,
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
  foeSpecs,
  foesForNode,
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
import { foeIntel } from '../foes.js';
import { DEBUG_BATTLES, type DebugSetup, MAX_DEBUG_PARTY, debugBattleById, debugBrief, debugRun } from '../debug.js';
import { scenarioForNode } from '../objectives.js';
import { HERO_POOL, heroArchetype } from '../heroes.js';
import { type JournalEvent, appendEvent, journalReport, lastIntent } from '../playtest.js';
import { exportBuild, importBuild } from '../share.js';
import { LENS_RU, applyLens } from '../lens.js';
import { AOE_BLAST_RADIUS, AOE_RITUAL_RADIUS, lineCells } from '../scoring.js';
import { AP_PER_TURN, FULL_COVER } from '../tuning.js';
import type { LensId, Side, WeaponSpec } from '../types.js';

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
let editHero = run.heroes[0]!.id;
let aftermathOpen = false;
/** Реплики характеров, раскрывшиеся в текущем бою, — для разбора после боя. */
let battleReveals: Reveal[] = [];
/** Оверлей «свиток боя» — полный лог решений. */
let logOpen = false;
/** Карточка юнита (герой или враг) — по клику на фишку или имя в реестре. */
let unitCardId: string | null = null;
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
const debugDraft: { battle: string; seed: number; party: { archetypeId: string; lenses: LensId[] }[] } = {
  battle: DEBUG_BATTLES[0]!.id,
  seed: 1,
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
const textMode: Record<string, boolean> = {};

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

/**
 * Свободный текст — режим по умолчанию, когда компилятор доступен; без ключа —
 * только чипсы. Вне debug-режима чипсы при живом компиляторе скрыты совсем:
 * игрок видит только свои слова и «как прочёл» (план линз).
 */
const inText = (heroId: string): boolean =>
  API_KEY ? !debugLenses || (textMode[heroId] ?? true) : false;
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

const NUM = ['i.', 'ii.', 'iii.', 'iv.', 'v.', 'vi.'];

const NODE_GLYPH: Record<NodeKind, string> = {
  lesson: 'α',
  fight: '×',
  elite: '✕',
  event: '?',
  rest: '~',
  scriptorium: '§',
  boss: 'Ω',
};

const NODE_RU: Record<NodeKind, string> = {
  lesson: 'урок',
  fight: 'бой',
  elite: 'элита',
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
  return `${a.name} — ${a.desc} · оружие: ${describeWeapons(arch.weapons)}${act}${pas}`;
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
};

/** Приказы героя как связный текст (до линзы — как написано). */
function ordersSentence(h: { phrases: PhraseDraft[] }): string {
  const names = heroNames(run);
  if (h.phrases.length === 0) return '';
  return h.phrases
    .map((d) => cap(describeDraft(d, names)) + ((d.weight ?? 1) >= 2 ? ' (важно)' : ''))
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
  cover?: 'half' | 'full' | 'ally';
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
}

function buildFrames(
  result: BattleResult,
  leaderIds: Set<string>,
  specs: readonly UnitSpec[],
  names: Record<string, string>,
): { frames: Frame[]; reveals: Reveal[] } {
  const units = new Map<string, FrameUnit>();
  const nm = (id: string): string => units.get(id)?.name ?? id;
  const snap = (): FrameUnit[] => [...units.values()].map((u) => ({ ...u }));
  // висящие зоны замаха по кастерам: от телеграфа до залпа или смерти кастера
  const activeZones = new Map<string, { x: number; y: number }>();
  const out: Frame[] = [];
  let round = 0;
  let pending: { actorId: string; factors: Frame['factors']; parts: string[]; fx: Fx[]; callout?: string } | null = null;
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
    for (const r of applyLens(s.lenses, s.rules).rules) {
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
  const reveal = (unitId: string, lens: LensId, quip: string): void => {
    const u = units.get(unitId)!;
    reveals.push({ unit: unitId, name: u.name, side: u.side, lens, quip });
    if (pending && pending.callout === undefined) pending.callout = `${u.name}: «${quip}»`;
  };

  const flush = (): void => {
    if (!pending) return;
    out.push({
      round,
      actorId: pending.actorId,
      actorName: nm(pending.actorId),
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
        pending = { actorId: e.unit, factors: e.factors, parts: [], fx: [] };
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
          reveal(e.unit, mark.lens, lensQuip(mark, names, r));
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
        pending?.parts.push(`${verb} ${nm(e.target)}: −${e.dmg}${e.flank ? ' (фланг)' : ''}`);
        pending?.fx.push({ kind: 'cells', cells: [{ x: t.x, y: t.y }], form: 'hit' });
        float(e.target, `−${e.dmg}${e.flank ? ' ⚑' : ''}`, 'dmg');
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
          pending = { actorId: e.unit, factors: [], parts: [`ритуал обрушивается на ${cellName(e.at.x, e.at.y)}`], fx: [] };
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
        pending?.parts.push(`${nm(e.unit)} накрыт: −${e.dmg}`);
        float(e.unit, `−${e.dmg}`, 'dmg');
        break;
      }
      case 'die': {
        units.get(e.unit)!.alive = false;
        units.get(e.unit)!.cover = undefined;
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
        pending = { actorId: e.unit, factors: [], parts: [`зарастает: +${e.amount}`], fx: [] };
        float(e.unit, `+${e.amount}`, 'heal');
        break;
      }
      case 'moodShift': {
        // сдвиг характера — свой кадр с репликой; попадает и в разбор после боя
        flush();
        const quip = driftQuip(e.lens);
        const u = units.get(e.unit)!;
        reveals.push({ unit: e.unit, name: u.name, side: u.side, lens: e.lens, quip });
        pending = { actorId: e.unit, factors: [], parts: [`«${quip}»`], fx: [], callout: `${u.name}: «${quip}»` };
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
      case 'cover': {
        pending?.parts.push(
          e.ally
            ? `прикрыл ${nm(e.ally)} (−${Math.round(e.level * 100)}% урона)`
            : `прикрылся (−${Math.round(e.level * 100)}% урона)`,
        );
        if (e.ally) {
          const a = units.get(e.ally);
          // щит союзника не понижает уже взятую глухую оборону
          if (a && a.cover !== 'full') a.cover = 'ally';
          float(e.ally, '⛨ прикрыт', 'buff');
        } else {
          const u = units.get(e.unit);
          const full = e.level >= FULL_COVER;
          if (u) u.cover = full ? 'full' : 'half';
          float(e.unit, full ? '⛨ глухая оборона' : '⛨ прикрытие', 'buff');
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
  ({ frames, reveals: battleReveals } = buildFrames(battle, leaderIds, specs, heroNames(run)));
  frameIdx = 0;
  playing = true;
  aftermathOpen = false;
  editorOpen = false;
  logOpen = false;
  unitCardId = null;
  ordersDirty = false;
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
  battle = null;
  frames = [];
  aftermathOpen = false;
  logOpen = false;
  unitCardId = null;
  render();
}

// ---------- правая страница: реестр приказов ----------

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

function rosterHtml(compact: boolean): string {
  return run.heroes
    .map((h) => {
      const live = heroHpNow(h.id);
      const dead = !h.alive || (live !== null && !live.alive);
      if (!h.alive) {
        return `<div class="roster-row dead">
          <div class="numerals">✝</div>
          <div class="r-body"><div class="r-head"><span class="r-name">${esc(h.name)}</span>
            ${lensTagHtml(h.lenses)}
            <span class="r-hp">пал(а)</span></div></div>
        </div>`;
      }
      const numerals = h.phrases.map((_, j) => NUM[j]).join('\n');
      const hpTxt = live ? `hp ${live.hp}/${live.maxHp}` : '—';
      const low = live !== null && live.hp / live.maxHp <= 0.35;
      const orders = ordersSentence(h);
      return `<div class="roster-row ${dead ? 'dead' : ''}">
        <div class="numerals">${numerals}</div>
        <div class="r-body">
          <div class="r-head">
            <span class="r-name clickable" data-action="unit-card" data-unit="${h.id}" title="карточка юнита">${esc(h.name)}</span>
            ${classTag(h.archetypeId)}
            ${lensTagHtml(h.lenses)}
            <span class="r-hp ${low ? 'low' : ''}" data-hp="${h.id}">${hpTxt}</span>
          </div>
          <div class="orders-text" ${compact ? 'style="font-size:12.5px"' : ''}>${
            orders ? esc(orders) : '<span class="empty">— приказов нет —</span>'
          }</div>
          ${readNoteHtml(readingLines(h), compact)}
        </div>
      </div>`;
    })
    .join('');
}

// ---------- экран: карта похода ----------

function mapSvg(): string {
  const layerW = new Map<number, number>();
  for (const n of run.map) layerW.set(n.layer, (layerW.get(n.layer) ?? 0) + 1);
  const pos = (n: MapNode): { x: number; y: number } => ({
    x: 48 + n.layer * 106,
    y: 118 + (n.slot - (layerW.get(n.layer)! - 1) / 2) * 76,
  });
  const canGo = run.status === 'ongoing' && run.resolved && !run.pendingReward;
  const nextIds = new Set(canGo ? currentNode(run).next : []);

  const edges = run.map
    .flatMap((n) =>
      n.next.map((to) => {
        const a = pos(n);
        const b = pos(run.map[to]!);
        const active = nextIds.has(to) && n.id === run.at;
        return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="edge ${active ? 'active' : ''}"/>`;
      }),
    )
    .join('');
  const nodes = run.map
    .map((n) => {
      const { x, y } = pos(n);
      const cls = [
        'mnode',
        visited.has(n.id) && n.id !== run.at ? 'done' : '',
        n.id === run.at ? 'current' : '',
        nextIds.has(n.id) ? 'selectable' : '',
      ].join(' ');
      const here =
        n.id === run.at
          ? `<text class="mnote" x="${x}" y="${y - 22}" text-anchor="middle" transform="rotate(-4 ${x} ${y - 22})">ты здесь</text>`
          : '';
      return `<g class="${cls}" data-node="${n.id}">
        <rect x="${x - 13}" y="${y - 13}" width="26" height="26" transform="rotate(45 ${x} ${y})"/>
        <text class="glyph" x="${x}" y="${y + 4.5}" text-anchor="middle">${NODE_GLYPH[n.kind]}</text>
        <text class="mkind" x="${x}" y="${y + 32}" text-anchor="middle">${NODE_RU[n.kind]}</text>
        ${here}
        <title>${NODE_RU[n.kind]}</title>
      </g>`;
    })
    .join('');
  return `<svg class="map" viewBox="0 0 850 240" role="img" aria-label="Карта похода">${edges}${nodes}</svg>`;
}

function intelHtml(node: MapNode): string {
  if (!intelVisible(node)) return '';
  const rows = foeIntel(foesForNode(node))
    .map((i) => `<div><b>${esc(i.name)}</b> — ${i.lines.map(esc).join(' · ')}</div>`)
    .join('');
  return `<div class="intel"><span class="kicker">они тоже читают — принципы врага видны</span>${rows}</div>`;
}

/** Мини-поле расстановки: зона партии слева, камни и высоты арены, враги при разведке. */
function deployHtml(node: MapNode): string {
  const layout = pickTerrain(battleSeed(run), arenaForNode(node));
  // сценарий с фикс-спавнами (разбитый лагерь): расстановка не в руках игрока
  const fixedSpawns = Boolean(scenarioForNode(node)?.heroSpawns);
  const cells: string[] = [];
  if (!fixedSpawns) {
    for (let y = 0; y < layout.tiles.length; y++) {
      for (let x = 0; x <= 2; x++) {
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
      const pick = fixedSpawns ? '' : ` data-action="deploy-pick" data-hero="${h.id}"`;
      return `<div class="btoken${deployPick === h.id ? ' pick' : ''}"${pick}
        style="left:${p.x * CELL}%;top:${p.y * CELL}%"><span class="dm"><span>${esc(glyphOf(h.name))}</span></span></div>`;
    })
    .join('');
  const intel = intelVisible(node);
  let foeTokens = '';
  if (intel) {
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
  const hint = fixedSpawns
    ? 'лагерь разбит: расстановка не в ваших руках'
    : deployPick
      ? 'поставь на клетку зоны'
      : `расстановка: герой → клетка${intel ? '; врагов выдаёт разведка' : ''}`;
  return `<div class="deploy">
    <span class="arena-line"><b>${esc(layout.name)}</b> — ${esc(layout.scenario)}</span>
    <span class="kicker">${hint}</span>
    <div class="bfield mini" style="--cell:${CELL}%">
      ${fixedSpawns ? '' : `<div class="dzone" style="width:${3 * CELL}%"></div>`}
      ${tilesLayerHtml(layout.tiles)}${cells.join('')}${foeTokens}${heroTokens}
    </div>
  </div>`;
}

function nodePanelHtml(): string {
  const node = currentNode(run);
  if (run.status !== 'ongoing') return '';
  if (run.resolved) {
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
            <span class="s-cost">${option.length > 1 ? `взять оба` : 'взять'}</span>
          </button>`;
        })
        .join('');
      const isBundle = run.pendingReward.some((o) => o.length > 1);
      const desc = isBundle
        ? 'В обозе врага — обрывки чужих наставлений. Пара расхожих слов — или одно редкое.'
        : 'В обозе врага — обрывки чужих наставлений. Одно слово можно разобрать.';
      return `<div class="node-panel">
        <h2>Трофей боя</h2>
        <div class="desc">${desc}</div>
        <div class="shop">${items}</div>
        <div class="btn-row"><button data-action="reward-skip">оставить на поле</button></div>
      </div>`;
    }
    return `<div class="node-panel">
      <h2>Куда дальше?</h2>
      <div class="desc">Пути расходятся. Выбери следующий узел на карте — красный ромб зовёт.</div>
    </div>`;
  }
  if (FIGHT_KINDS.includes(node.kind)) {
    // задача боя (план objectives) видна всегда — честная часть разведки
    const scenario = scenarioForNode(node);
    const taskHtml = scenario
      ? `<div class="task-line"><span class="kicker">задача боя</span><b>⚑ ${esc(scenario.title)}</b> — ${esc(scenario.brief)}</div>`
      : '';
    const canMark = run.vocab.includes('sel.marked');
    const foeRows = foesForNode(node)
      .map((f) => {
        const marked = run.marked === f.id;
        const markBtn = canMark
          ? `<button class="mini mark-btn ${marked ? 'on' : ''}" data-action="mark-foe" data-foe="${f.id}"
               title="метка: правила «атаковать помеченного» целятся в него">${marked ? '◎ помечен' : '◎ пометить'}</button>`
          : '';
        return `<div class="foe-row"><b>${marked ? '◎ ' : ''}${esc(f.name)}</b> — ${statLine(f)}${markBtn}</div>`;
      })
      .join('');
    const nudge = lessonNudge
      ? `<div class="onboarding">Первый приказ почти никогда не выигрывает этот бой — так задумано.
         В дневник вписано новое слово: «держать дистанцию».
         Перепиши принципы под то, что видно в разведке, и переиграй: <b>кости те же</b>.</div>`
      : node.kind === 'lesson'
        ? `<div class="flavor">учебный бой: поражение ничего не стоит — экспериментируй.</div>`
        : '';
    return `<div class="node-panel">
      <h2>${esc(nodeTitle(node))}</h2>
      ${taskHtml}
      <div class="node-cols">
        <div class="node-cols-l">
          <div class="foe-list"><span class="kicker">противник — разведка числом</span>${foeRows}</div>
          ${intelHtml(node)}
        </div>
        ${deployHtml(node)}
      </div>
      ${nudge}
      <div class="btn-row"><button class="primary" data-action="fight">⚔ выступить</button>
        <button data-action="open-editor">переписать приказы</button>
        ${
          node.kind === 'lesson'
            ? `<button class="linkish" data-action="skip-lesson"
                 title="забрать трофей урока и начать забег, не играя учебный бой">пропустить урок</button>`
            : ''
        }</div>
    </div>`;
  }
  if (node.kind === 'event') {
    const offer = eventOffer(run);
    const names = heroNames(run);
    const parts: string[] = [];
    if (offer.concept) {
      parts.push(`<div class="desc">Странствующий книжник готов растолковать концепт
        «${CONCEPTS[offer.concept].label}» — задаром, из любви к слову.</div>
        <div class="btn-row"><button class="primary" data-action="event-take">изучить</button></div>`);
    } else if (offer.slotHero) {
      parts.push(`<div class="desc">В тайнике — чистый лист для полевого дневника:
        +1 слот приказа для ${names[offer.slotHero]}.</div>
        <div class="btn-row"><button class="primary" data-action="event-take">забрать</button></div>`);
    }
    if (offer.mercenary) {
      parts.push(`<div class="desc">У костра сидит наёмник ${esc(offer.mercenary.name)}${
        debugLenses ? ` [${lensTag(offer.mercenary.lenses)}]` : ''
      } — займёт место павшего, но прежние принципы
        прочтёт по-своему.</div>
        <div class="btn-row"><button data-action="event-hire">нанять</button></div>`);
    }
    return `<div class="node-panel">
      <h2>${esc(nodeTitle(node))}</h2>
      ${parts.join('')}
      <div class="btn-row"><button data-action="event-skip">пройти мимо</button></div>
    </div>`;
  }
  if (node.kind === 'rest') {
    return `<div class="node-panel">
      <h2>${esc(nodeTitle(node))}</h2>
      <div class="desc">Костёр, тишина, иголка с ниткой. Живые герои восстановят большую часть здоровья;
        приказы можно переписывать сколько угодно.</div>
      <div class="btn-row"><button class="primary" data-action="rest">отдохнуть</button>
        <button data-action="open-editor">переписать приказы</button></div>
    </div>`;
  }
  return '';
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
        <span class="title">Поход — западный тракт</span>
        <span class="meta">fol. ${run.at + 1}r · seed ${run.runSeed}</span>
      </div>
      ${mapSvg()}
      ${nodePanelHtml()}
      <div class="foot">
        <span>словарь: <b>${run.vocab.length}</b> слов</span><span>·</span>
        <span>узел ${run.at + 1} из ${run.map.length}</span>
        <span class="spacer"></span>
        <button class="linkish" data-action="toggle-debug">${debugLenses ? 'debug: скрыть характеры' : 'debug'}</button>
        <button class="linkish" data-action="open-debug" title="отладка: любой сценарий, партия и характеры">собрать бой</button>
        ${freeVocabBtnHtml()}
        <button class="linkish" data-action="export-journal">журнал плейтеста</button>
        <span>${
          run.resolved && run.status === 'ongoing'
            ? run.pendingReward
              ? 'сначала реши судьбу трофея'
              : 'кликни следующий узел, чтобы идти'
            : ''
        }</span>
      </div>
    </div>
    <div class="gutter"></div>
    <div class="page-r">
      <div class="page-head">
        <span class="title">Действующие приказы</span>
        <button class="linkish" data-action="export-build">экспорт билда</button>
        <button class="linkish" data-action="open-editor">переписать ▾</button>
      </div>
      <div class="roster">${rosterHtml(false)}</div>
      <div class="foot solid">Приказы компилируются один раз, до боя. Сам бой — арифметика:
        те же кости, тот же исход, каждый раз.</div>
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

function marginLogHtml(): string {
  const rows = frames
    .slice(1, frameIdx + 1)
    .slice(-7)
    .reverse()
    .map((f, i) => {
      const fade = i === 0 ? 1 : Math.max(0.35, 1 - i * 0.12);
      return `<div class="row" style="opacity:${fade}">
        <span class="t">${f.round}.</span>
        <span><b>${esc(f.actorName)}</b> ${esc(f.text)} <span class="why">${esc(fmtFactors(f.factors))}</span></span>
      </div>`;
    });
  return rows.join('');
}

/** Подписи значков прикрытия: что даёт и почём. */
const COVER_BADGE_TITLE: Record<NonNullable<FrameUnit['cover']>, string> = {
  half: 'прикрытие: −25% входящего урона до своего хода',
  full: 'глухая оборона: −66% входящего урона, ближний удар ловит рипост',
  ally: 'прикрыт союзником, пока тот жив и рядом',
};

function coverBadgeHtml(cover: FrameUnit['cover']): string {
  return cover ? `<span class="cov ${cover}" title="${COVER_BADGE_TITLE[cover]}">⛨</span>` : '';
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
        ${mark}${coverBadgeHtml(u.cover)}<span class="dm"><span>${esc(glyphOf(u.name))}</span></span>
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

function tilesLayerHtml(tiles: readonly Tile[][]): string {
  const out: string[] = [];
  tiles.forEach((row, y) =>
    row.forEach((t, x) => {
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
  const taskHtml = scenario
    ? `<div class="task-line">⚑ <b>${esc(scenario.title)}</b> — ${esc(scenario.brief)}</div>`
    : '';
  const intel = intelVisible(node);
  const enemyLines = intel
    ? foeIntel(foesForNode(node))
        .map((i) => `<div><b>${esc(i.name)}</b> — ${i.lines.map(esc).join(' · ')}</div>`)
        .join('')
    : `<div>${esc(foesForNode(node).map((f) => f.name).join(' · '))} — принципы скрыты</div>`;
  return `<div class="spread">
    <div class="page-l" style="padding:20px 24px 14px 28px;gap:10px">
      <div class="page-head">
        <span class="title">${esc(nodeTitle(node))}</span>
        <span class="meta"><span id="turnlabel">ход ${f.round}</span> · ${esc(battle!.terrain.name)} · seed ${run.runSeed}</span>
      </div>
      ${taskHtml}
      <div class="bfield" id="bfield" style="--cell:${CELL}%">
        ${terrainHtml()}
        <div class="zones-layer" id="zoneslayer">${zonesHtml()}</div>
        ${tokensHtml()}
        <div class="fx-layer" id="fxlayer">${fxHtml()}</div>
        <span class="callout" id="callout" style="left:24%;top:90%">${esc(f.callout ?? '')}</span>
      </div>
      <div class="controls-row">
        <button data-action="toggle-play" id="playbtn">${playing ? '❙❙' : '▶'}</button>
        <button data-action="step-back">◂</button>
        <button data-action="step-fwd">▸|</button>
        <button data-action="cycle-speed" id="speedbtn">×${speed}</button>
        <span class="progress"><span id="progressbar" style="width:${Math.round((100 * frameIdx) / Math.max(1, frames.length - 1))}%"></span></span>
        <span id="framelabel">${frameIdx}/${frames.length - 1}</span>
        <button data-action="open-log" title="полный лог боя">свиток</button>
      </div>
      <div class="enemy-strip">
        <span class="kicker">${intel ? 'они тоже читают — принципы врага видны' : 'противник'}</span>
        ${enemyLines}
      </div>
    </div>
    <div class="gutter"></div>
    <div class="page-r" style="padding:20px 24px 14px 20px">
      <div class="page-head">
        <span class="title">Действующие приказы</span>
        <button class="tact-btn ${tactician ? 'on' : ''}" data-action="toggle-tact">режим тактика</button>
      </div>
      <div class="roster" style="overflow:visible;gap:9px" id="battle-roster">${rosterHtml(true)}</div>
      <div class="margin-log">
        <span class="kicker">на полях — почему они так поступили</span>
        <div id="mlog">${marginLogHtml()}</div>
      </div>
      <div class="btn-row">
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
  }
  const fxl = document.getElementById('fxlayer');
  if (fxl) fxl.innerHTML = fxHtml();
  const set = (id: string, text: string): void => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set('turnlabel', `ход ${f.round}`);
  set('framelabel', `${frameIdx}/${frames.length - 1}`);
  set('callout', f.callout ?? '');
  const zl = document.getElementById('zoneslayer');
  if (zl) zl.innerHTML = zonesHtml();
  const play = document.getElementById('playbtn');
  if (play) play.textContent = playing ? '❙❙' : '▶';
  const bar = document.getElementById('progressbar');
  if (bar) bar.style.width = `${Math.round((100 * frameIdx) / Math.max(1, frames.length - 1))}%`;
  const mlog = document.getElementById('mlog');
  if (mlog) mlog.innerHTML = marginLogHtml();
  for (const h of run.heroes) {
    const el = app.querySelector<HTMLElement>(`[data-hp="${h.id}"]`);
    if (!el) continue;
    const live = heroHpNow(h.id);
    el.textContent = live ? `hp ${live.hp}/${live.maxHp}` : '—';
    el.classList.toggle('low', live !== null && live.hp / live.maxHp <= 0.35);
    const row = el.closest('.roster-row');
    if (row) row.classList.toggle('dead', live === null || !live.alive);
  }
}

// ---------- оверлей: редактор приказов ----------

function editorHtml(): string {
  const alive = run.heroes.filter((h) => h.alive);
  const eh = alive.find((h) => h.id === editHero) ?? alive[0]!;
  const names = heroNames(run);
  const heroCards = run.heroes
    .map((h) => {
      if (!h.alive) {
        return `<div class="eh-card dead"><div class="nm"><span>${esc(h.name)}</span>
          ${lensTagHtml(h.lenses, 'ch')}</div>
          <div class="sub">пал(а) в бою</div></div>`;
      }
      return `<div class="eh-card ${h.id === eh.id ? 'sel' : ''}" data-action="sel-hero" data-hero="${h.id}">
        <div class="nm"><span>${esc(h.name)}</span>${lensTagHtml(h.lenses, 'ch')}</div>
        <div class="sub klass-line">${esc(heroArchetype(h.archetypeId).class)}</div>
        <div class="sub">${h.phrases.length}/${h.slots} приказов · ${statLine({ ...h.stats, weapons: heroArchetype(h.archetypeId).weapons }, h.hp)}</div>
        <div class="sub ability">${esc(abilityLine(h.archetypeId))}</div>
      </div>`;
    })
    .join('');

  const inTextMode = inText(eh.id);
  // Ворота C: замысел словами до конструктора — уходит в журнал плейтеста.
  // В текстовом режиме сам свободный текст и есть формулировка — блок не нужен.
  const intentBlock = inTextMode
    ? ''
    : `<div class="intent-block">
        <span class="kicker">сначала — замысел словами, в полевой журнал</span>
        <textarea class="intent-text" data-hero="${eh.id}" rows="2"
          placeholder="Чего ты хочешь от ${esc(eh.name)}? Напиши как думаешь — потом собери из чипсов.">${esc(
            heroIntent[eh.id] ?? lastIntent(journal, eh.name),
          )}</textarea>
      </div>`;
  const slotRows = inTextMode
    ? `<textarea class="principle-text" data-hero="${eh.id}" rows="4"
        placeholder="Опиши принципы словами — ${esc(eh.name)} поймёт по-своему">${esc(heroText[eh.id] ?? '')}</textarea>
      <div class="btn-row"><button data-action="compile-text" data-hero="${eh.id}" ${compiling[eh.id] ? 'disabled' : ''}>
        ${compiling[eh.id] ? '…понимает' : 'понять'}</button></div>`
    : Array.from({ length: eh.slots })
        .map((_, i) => {
          const ph = eh.phrases[i];
          if (!ph) {
            return `<div class="slot-row empty">
              <span class="mark">${NUM[i]}</span>
              <span style="flex:1">— пустой слот —</span>
              <button class="mini" data-action="add-phrase" data-hero="${eh.id}">заполнить</button>
            </div>`;
          }
          // глубокие чипсы: условие фразы — цепочка до трёх уровней со связкой
          // «и»/«или» (одна на фразу); следующий уровень появляется, когда
          // выбран предыдущий
          const chain: SimpleConditionDraft[] =
            ph.condition.id === 'and' || ph.condition.id === 'or'
              ? ph.condition.conds
              : ph.condition.id === 'always'
                ? []
                : [ph.condition];
          const op: 'and' | 'or' = ph.condition.id === 'or' ? 'or' : 'and';
          const opChip = (lvl: number): string =>
            lvl === 1
              ? `<select class="op-select" data-hero="${eh.id}" data-idx="${i}">
                  <option value="and" ${op === 'and' ? 'selected' : ''}>и</option>
                  <option value="or" ${op === 'or' ? 'selected' : ''}>или</option>
                </select>`
              : `<span class="nest">${op === 'or' ? 'или' : 'и'}</span>`;
          const condSelects = [
            selectHtml('cond-select', eh.id, i, conditionOptions(), chain[0] ?? { id: 'always' }, 'data-level="0"'),
          ];
          for (let lvl = 1; lvl < 3 && chain.length >= lvl; lvl++) {
            condSelects.push(
              `<span class="nest">⌞</span>${opChip(lvl)}${selectHtml(
                'cond-select',
                eh.id,
                i,
                moreConditionOptions(),
                chain[lvl] ?? { id: 'always' },
                `data-level="${lvl}"`,
              )}`,
            );
          }
          return `<div class="slot-row">
            <span class="mark">${NUM[i]}</span>
            <span class="fields">
              ${condSelects.join('')}
              ${selectHtml('pref-select', eh.id, i, preferenceOptions(eh.id), ph.preference)}
              <select class="weight-select" data-hero="${eh.id}" data-idx="${i}">
                <option value="1" ${(ph.weight ?? 1) === 1 ? 'selected' : ''}>обычно</option>
                <option value="2" ${(ph.weight ?? 1) === 2 ? 'selected' : ''}>важно</option>
              </select>
            </span>
            <button class="mini" data-action="clear-phrase" data-hero="${eh.id}" data-idx="${i}">стереть</button>
          </div>`;
        })
        .join('');

  // вне debug чипсы при живом компиляторе скрыты — тумблер не показываем
  const toggle = API_KEY && debugLenses
    ? `<button class="mini" data-action="toggle-text" data-hero="${eh.id}">${inTextMode ? '⬒ чипсы' : '✎ текстом'}</button>`
    : '';
  const err = editError[eh.id] ? `<div class="error">${esc(editError[eh.id]!)}</div>` : '';
  const replay = battle
    ? `<button class="primary" data-action="sparring">↻ те же кости, новые приказы</button>`
    : `<button class="primary" data-action="close-editor">к походу</button>`;

  return `<div class="overlay">
    <div class="modal editor">
      <div class="head">
        <span class="title">Пиши их приказы</span>
        <span class="meta">компилируются до боя · каждый прочтёт по-своему</span>
      </div>
      <div class="cols">
        <div class="heroes-col">
          ${heroCards}
          ${debugLenses ? `<div class="lens-hint">${eh.lenses.map((l) => `<div>${LENS_HINT[l]}</div>`).join('')}</div>` : ''}
        </div>
        <div class="slots-col">
          ${intentBlock}
          <div style="display:flex;align-items:center;gap:8px">
            <span class="kicker">слоты — занято ${eh.phrases.length} из ${eh.slots}</span>
            <span class="spacer"></span>${toggle}
          </div>
          ${slotRows}
          ${err}
          <div class="readings">
            <span class="kicker">как прочёл ${esc(eh.name)}</span>
            ${readNoteHtml(readingLines(eh), false)}
          </div>
        </div>
      </div>
      <div class="foot-row">
        <button data-action="close-editor">закрыть</button>
        ${freeVocabBtnHtml()}
        <span class="spacer"></span>
        ${replay}
      </div>
    </div>
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

  return `<div class="overlay">
    <div class="modal debug-panel">
      <div class="head">
        <span class="title">Отладка: собрать бой</span>
        <span class="meta">любой сценарий × любая партия × любые характеры</span>
      </div>
      <div class="dbg-row">
        <label>бой <select class="dbg-battle">${battleOpts}</select></label>
        <label>сид <input class="dbg-seed" type="number" min="1" step="1" value="${debugDraft.seed}"></label>
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

// ---------- оверлей: исход боя ----------

function aftermathHtml(): string {
  if (!battle) return '';
  const node = currentNode(run);
  const won = battle.winner === 'party';
  const fallen = battle.units
    .filter((u) => u.side === 'party' && !u.alive)
    .map((u) => u.name);
  const title = won ? 'Поле за тобой' : battle.winner === 'draw' ? 'Ничья — бой увял' : 'Отряд разбит';
  const quip = won
    ? fallen.length
      ? `Победа. ${fallen.join(' и ')} предпочли бы фразу почётче.`
      : 'Победа — и они даже примерно сделали то, что ты просил.'
    : 'Они выполнили твои приказы. Дословно. В землю.';
  const contLabel = won
    ? 'продолжить поход'
    : node.kind === 'lesson'
      ? 'вернуться к приказам'
      : 'принять поражение';
  const contHint = ordersDirty ? 'title="приказы переписаны — сперва переиграй с теми же костями"' : '';
  const lessonLine =
    !won && node.kind === 'lesson'
      ? `<div>это ничего не стоило: урок прощает — перепиши приказ и переиграй</div>`
      : '';
  // разбор (план линз): только то, что реально сработало в этом бою —
  // непроявившиеся прочтения остаются загадкой на следующий
  const partyReveals = battleReveals.filter((r) => r.side === 'party');
  const debrief = partyReveals.length
    ? `<div class="a-debrief">
        <span class="kicker">разбор — как они тебя поняли</span>
        ${partyReveals
          .map(
            (r) =>
              `<div><b>${esc(r.name)}</b> — «${esc(r.quip)}»${debugLenses ? ` <span class="why">(${LENS_RU[r.lens]})</span>` : ''}</div>`,
          )
          .join('')}
      </div>`
    : '';
  return `<div class="overlay">
    <div class="modal aftermath ${won ? '' : 'loss'}">
      <div class="a-title">${title}</div>
      <div class="a-quip">${esc(quip)}</div>
      <div class="a-lines">
        <div>раундов: ${battle.rounds} · seed ${run.runSeed} · те же кости доступны</div>
        <div>${fallen.length ? `пали: ${esc(fallen.join(', '))}` : 'пали: никто'}</div>
        ${lessonLine}
        <div>перепиши одну фразу и переиграй тот же бой — в этом вся игра</div>
      </div>
      ${debrief}
      <div class="btn-row" style="margin-top:4px">
        <button data-action="open-editor">переписать приказы</button>
        <button data-action="sparring">↻ те же кости</button>
        <button data-action="open-log">полный лог</button>
        <span class="spacer"></span>
        <button class="primary" data-action="accept" ${ordersDirty ? 'disabled' : ''} ${contHint}>${contLabel}</button>
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

function unitCardHtml(id: string): string {
  const node = currentNode(run);
  const hero = run.heroes.find((h) => h.id === id);
  if (hero) {
    const live = unitHpInBattle(id) ?? (hero.alive ? { hp: hero.hp, alive: true } : undefined);
    const hints = debugLenses
      ? `<div class="lens-hint">${hero.lenses.map((l) => `<div>${LENS_HINT[l]}</div>`).join('')}</div>`
      : '';
    return `<div class="overlay"><div class="modal unit-card">
      <div class="head">
        <span class="title">${esc(hero.name)}</span>
        ${classTag(hero.archetypeId)}
        ${lensTagHtml(hero.lenses)}
        <span class="meta">${live?.alive === false || !hero.alive ? 'пал(а)' : 'наш отряд'}</span>
      </div>
      <div class="stat-line">${statLine({ ...hero.stats, weapons: heroArchetype(hero.archetypeId).weapons }, live?.hp)}</div>
      <div class="ability-note">способность · ${esc(abilityLine(hero.archetypeId))}</div>
      <div class="card-block">
        <span class="kicker">приказы</span>
        <div class="orders-text">${
          ordersSentence(hero) ? esc(ordersSentence(hero)) : '<span class="empty">— приказов нет —</span>'
        }</div>
      </div>
      <div class="card-block">
        <span class="kicker">как прочёл</span>
        ${readNoteHtml(readingLines(hero), false)}
      </div>
      ${hints}
      <div class="foot-row"><span class="spacer"></span><button class="primary" data-action="close-card">закрыть</button></div>
    </div></div>`;
  }
  if (!FIGHT_KINDS.includes(node.kind)) return '';
  const spec = foesForNode(node).find((f) => f.id === id);
  if (!spec) return '';
  const live = unitHpInBattle(id);
  const principles = intelVisible(node)
    ? foeIntel([spec])[0]!.lines.map((l) => `<div class="read-note">«${esc(l)}»</div>`).join('')
    : `<div class="orders-text"><span class="empty">принципы скрыты — прочтёшь по ходу боя</span></div>`;
  return `<div class="overlay"><div class="modal unit-card">
    <div class="head">
      <span class="title">${esc(spec.name)}</span>
      ${lensTagHtml(spec.lenses)}
      <span class="meta">${live?.alive === false ? 'пал' : 'противник'}</span>
    </div>
    <div class="stat-line">${statLine(spec, live?.hp)}</div>
    <div class="card-block">
      <span class="kicker">${intelVisible(node) ? 'принципы — они тоже читают' : 'принципы'}</span>
      ${principles}
    </div>
    <div class="foot-row"><span class="spacer"></span><button class="primary" data-action="close-card">закрыть</button></div>
  </div></div>`;
}

// ---------- оверлей: свиток боя (полный лог) ----------

function battleLogHtml(): string {
  if (!battle) return '';
  const rows: string[] = [];
  let round = 0;
  frames.forEach((f, i) => {
    if (i === 0) return;
    if (f.round !== round) {
      round = f.round;
      rows.push(`<div class="log-round">— ход ${round} —</div>`);
    }
    rows.push(`<div class="log-row ${i === frameIdx ? 'cur' : ''}" data-frame="${i}">
      <span class="t">${f.round}.</span>
      <span><b>${esc(f.actorName)}</b> ${esc(f.text)} <span class="why">${esc(fmtFactors(f.factors))}</span></span>
    </div>`);
  });
  const outcome =
    battle.winner === 'party' ? 'поле за тобой' : battle.winner === 'draw' ? 'ничья' : 'отряд разбит';
  return `<div class="overlay"><div class="modal battle-log">
    <div class="head">
      <span class="title">Свиток боя</span>
      <span class="meta">${frames.length - 1} решений · seed ${run.runSeed} · клик по строке — к кадру</span>
    </div>
    <div class="log-scroll">${rows.join('')}
      <div class="log-end">исход: ${outcome} · раундов: ${battle.rounds}</div>
    </div>
    <div class="foot-row">
      <button class="tact-btn ${tactician ? 'on' : ''}" data-action="toggle-tact">режим тактика</button>
      <span class="spacer"></span>
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
      <div class="a-title">${title}</div>
      <div class="a-quip">${esc(quip)}</div>
      <div class="a-lines">${lines}</div>
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
  const screen = battle
    ? battleScreenHtml()
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
    const conds: SimpleConditionDraft[] = [];
    for (const lvl of [0, 1, 2]) {
      const sel = app.querySelector<HTMLSelectElement>(
        `.cond-select[data-hero="${heroId}"][data-idx="${idx}"][data-level="${lvl}"]`,
      );
      if (!sel) continue;
      const c = JSON.parse(sel.value) as SimpleConditionDraft;
      if (c.id !== 'always') conds.push(c);
    }
    const opSel = app.querySelector<HTMLSelectElement>(
      `.op-select[data-hero="${heroId}"][data-idx="${idx}"]`,
    );
    const op: 'and' | 'or' = opSel?.value === 'or' ? 'or' : 'and';
    const condition: ConditionDraft =
      conds.length === 0 ? { id: 'always' } : conds.length === 1 ? conds[0]! : { id: op, conds };
    const prefSel = app.querySelector<HTMLSelectElement>(`.pref-select[data-hero="${heroId}"][data-idx="${idx}"]`)!;
    const wSel = app.querySelector<HTMLSelectElement>(`.weight-select[data-hero="${heroId}"][data-idx="${idx}"]`)!;
    return {
      condition,
      preference: JSON.parse(prefSel.value) as PreferenceDraft,
      weight: Number(wSel.value),
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
  for (const ta of app.querySelectorAll<HTMLTextAreaElement>('textarea.principle-text')) {
    ta.addEventListener('input', () => {
      heroText[ta.dataset.hero!] = ta.value;
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
  for (const g of app.querySelectorAll<SVGGElement>('.mnode.selectable')) {
    g.addEventListener('click', () => {
      const to = Number(g.dataset.node);
      if (advance(run, to).ok) {
        visited.add(to);
        fightsAtNode = 0;
        rewroteSinceBattle = false;
      }
      lessonNudge = false;
      render();
    });
  }
  for (const tok of app.querySelectorAll<HTMLElement>('.btoken[data-unit]')) {
    tok.addEventListener('click', () => {
      unitCardId = tok.dataset.unit!;
      playing = false;
      stopTimer();
      render();
    });
  }
  for (const row of app.querySelectorAll<HTMLElement>('.log-row[data-frame]')) {
    row.addEventListener('click', () => {
      frameIdx = Number(row.dataset.frame);
      logOpen = false;
      aftermathOpen = false;
      playing = false;
      stopTimer();
      render();
    });
  }
  for (const el of app.querySelectorAll<HTMLElement>('[data-action]')) {
    el.addEventListener('click', () => {
      const a = el.dataset.action!;
      switch (a) {
        case 'fight':
          startBattle();
          break;
        case 'skip-lesson':
          skipLesson(run);
          lessonNudge = false;
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
        case 'unit-card':
          unitCardId = el.dataset.unit!;
          playing = false;
          stopTimer();
          render();
          break;
        case 'close-card':
          unitCardId = null;
          render();
          break;
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
        case 'toggle-text': {
          const heroId = el.dataset.hero!;
          textMode[heroId] = !inText(heroId);
          editError[heroId] = '';
          render();
          break;
        }
        case 'compile-text':
          void compileHeroText(el.dataset.hero!);
          break;
        case 'toggle-debug':
          debugLenses = !debugLenses;
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
        case 'cycle-speed': {
          speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
          const b = document.getElementById('speedbtn');
          if (b) b.textContent = `×${speed}`;
          if (playing) runTimer();
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

fitScale = computeFit();
window.addEventListener('resize', () => {
  fitScale = computeFit();
  const book = app.querySelector<HTMLElement>('.book');
  if (book) book.style.transform = bookTransform();
});
render();
