import { type BattleResult, runBattle } from '../battle.js';
import { understandingCard } from '../cards.js';
import { type ConditionDraft, type PhraseDraft, type PreferenceDraft, compilePhrase } from '../constructor.js';
import { type ModelCall, anthropicModelCall, compileFreeText } from '../compiler/compile.js';
import type { CompilerCache } from '../compiler/cache.js';
import type { CompilerOutput } from '../compiler/schema.js';
import type { Rule } from '../ir.js';
import { CONCEPTS, type ConceptId } from '../vocab.js';
import {
  NODES,
  type RunState,
  battleSeed,
  chooseInScriptorium,
  currentNode,
  foesForFight,
  heroNames,
  heroSpecs,
  playFight,
  scriptoriumOffer,
  setPhrases,
  startRun,
} from '../run.js';

/** Фаза 2: «играбельно и уродливо». Чистый DOM, никакого фреймворка. */

const app = document.getElementById('app')!;

const urlSeed = Number(new URLSearchParams(location.search).get('seed') ?? 1);
const run: RunState = startRun(Number.isFinite(urlSeed) ? urlSeed : 1);
let battle: BattleResult | null = null;
let playIdx = 0;
let timer: number | null = null;
let editError: Record<string, string> = {};

// ---------- LLM-компилятор свободного текста (опционален: без ключа — конструктор) ----------

const API_KEY: string | undefined = (import.meta as unknown as { env?: Record<string, string> }).env
  ?.VITE_ANTHROPIC_API_KEY;
const textMode: Record<string, boolean> = {};
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
    modelCall = anthropicModelCall(new Anthropic({ apiKey: API_KEY, dangerouslyAllowBrowser: true }));
  }
  return modelCall;
}

async function compileHeroText(heroId: string): Promise<void> {
  const hero = run.heroes.find((h) => h.id === heroId);
  if (!hero || compiling[heroId]) return;
  compiling[heroId] = true;
  editError[heroId] = '';
  renderNodeScreen();
  const r = await compileFreeText(
    {
      text: heroText[heroId] ?? '',
      heroId,
      heroName: hero.name,
      character: hero.character,
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
  if (r.ok) {
    const res = setPhrases(run, heroId, r.phrases);
    editError[heroId] = res.ok ? '' : res.error;
    heroUncertainty[heroId] = r.uncertainty;
  } else {
    editError[heroId] = r.error;
  }
  renderNodeScreen();
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

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

// ---------- варианты фраз для селектов ----------

interface Opt<T> {
  value: T;
  label: string;
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
    for (const h of run.heroes.filter((h) => h.alive)) {
      out.push({
        value: { id: 'cond.hpBelow', who: { ally: h.id }, frac: 0.5 },
        label: `если hp ${names[h.id]} < 50%`,
      });
    }
  }
  if (has('cond.outnumbered')) out.push({ value: { id: 'cond.outnumbered' }, label: 'если врагов больше' });
  if (has('cond.allyInDanger')) {
    for (const h of run.heroes.filter((h) => h.alive)) {
      out.push({ value: { id: 'cond.allyInDanger', ally: h.id }, label: `если ${names[h.id]} в опасности` });
    }
  }
  return out;
}

function preferenceOptions(heroId: string): Opt<PreferenceDraft>[] {
  const names = heroNames(run);
  const out: Opt<PreferenceDraft>[] = [];
  const has = (c: ConceptId): boolean => run.vocab.includes(c);
  const selectors = (['sel.nearest', 'sel.weakest', 'sel.leader'] as const).filter(has);
  const selRu: Record<string, string> = {
    'sel.nearest': 'ближайшего',
    'sel.weakest': 'слабейшего',
    'sel.leader': 'вожака',
  };
  if (has('act.attack')) {
    for (const s of selectors) out.push({ value: { id: 'act.attack', target: s }, label: `атаковать ${selRu[s]}` });
  }
  if (has('act.protect')) {
    for (const h of run.heroes.filter((h) => h.alive && h.id !== heroId)) {
      out.push({ value: { id: 'act.protect', ally: h.id }, label: `защищать ${names[h.id]}` });
    }
  }
  if (has('act.holdPosition')) out.push({ value: { id: 'act.holdPosition' }, label: 'держать позицию' });
  if (has('act.retreat')) out.push({ value: { id: 'act.retreat' }, label: 'отступать' });
  for (const space of ['space.nearTo', 'space.behind'] as const) {
    if (!has(space)) continue;
    const verb = space === 'space.nearTo' ? 'держаться рядом с' : 'держаться позади';
    for (const h of run.heroes.filter((h) => h.alive && h.id !== heroId)) {
      out.push({ value: { id: space, ref: { ally: h.id } }, label: `${verb} ${names[h.id]}` });
    }
    for (const s of selectors) {
      out.push({ value: { id: space, ref: { enemy: s } }, label: `${verb}: враг-${selRu[s]}` });
    }
  }
  return out;
}

function selectHtml<T>(cls: string, hero: string, idx: number, opts: Opt<T>[], current: T): string {
  const cur = canon(current);
  const options = opts
    .map((o) => {
      const v = canon(o.value);
      return `<option value='${esc(v)}' ${v === cur ? 'selected' : ''}>${esc(o.label)}</option>`;
    })
    .join('');
  return `<select class="${cls}" data-hero="${hero}" data-idx="${idx}">${options}</select>`;
}

// ---------- экран узла ----------

function nodeStripHtml(): string {
  return `<div class="nodes">${NODES.map((n, i) => {
    const cls = i < run.nodeIndex ? 'done' : i === run.nodeIndex && run.status === 'ongoing' ? 'current' : '';
    const label = n.kind === 'fight' ? `⚔ ${n.index + 1}` : '✎';
    return `<span class="node ${cls}">${label}</span>`;
  }).join('')}</div>`;
}

function heroesHtml(): string {
  const names = heroNames(run);
  return run.heroes
    .map((h) => {
      if (!h.alive) {
        return `<div class="hero dead"><span class="hero-name">${h.name}</span> <span class="dim">[${h.character}] — погиб(ла)</span></div>`;
      }
      const rows = h.phrases
        .map(
          (ph, i) => `
        <div class="phrase-row">
          ${selectHtml('cond-select', h.id, i, conditionOptions(), ph.condition)}
          ${selectHtml('pref-select', h.id, i, preferenceOptions(h.id), ph.preference)}
          <select class="weight-select" data-hero="${h.id}" data-idx="${i}">
            <option value="1" ${(ph.weight ?? 1) === 1 ? 'selected' : ''}>обычно</option>
            <option value="2" ${(ph.weight ?? 1) === 2 ? 'selected' : ''}>важно</option>
          </select>
          <button data-action="del-phrase" data-hero="${h.id}" data-idx="${i}">✕</button>
        </div>`,
        )
        .join('');
      const addBtn =
        h.phrases.length < h.slots
          ? `<button data-action="add-phrase" data-hero="${h.id}">+ фраза (${h.phrases.length}/${h.slots})</button>`
          : `<span class="dim">слоты заняты (${h.phrases.length}/${h.slots})</span>`;
      const rules = h.phrases
        .map((ph) => {
          const names2 = heroNames(run);
          const r = setPhrasesPreview(h.id, ph, names2);
          return r;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      const inTextMode = !!textMode[h.id];
      const card = understandingCard(
        { name: h.name, character: h.character },
        rules,
        names,
        inTextMode ? (heroUncertainty[h.id] ?? []) : [],
      );
      const cardHtml = card.lines
        .map((l) => `<div class="card-line ${l.includes('⚠') ? 'warn' : 'dim'}">· ${esc(l)}</div>`)
        .join('');
      const err = editError[h.id] ? `<div class="error">${esc(editError[h.id]!)}</div>` : '';
      const toggle = API_KEY
        ? `<button class="mode-toggle" data-action="toggle-text" data-hero="${h.id}">${inTextMode ? '⬒ чипсы' : '✎ текстом'}</button>`
        : `<span class="dim" title="Задай VITE_ANTHROPIC_API_KEY в .env, чтобы писать принципы текстом">✎ —</span>`;
      const editor = inTextMode
        ? `<textarea class="principle-text" data-hero="${h.id}" rows="3"
             placeholder="Опиши принципы словами — ${h.name} поймёт по-своему">${esc(heroText[h.id] ?? '')}</textarea>
           <button data-action="compile-text" data-hero="${h.id}" ${compiling[h.id] ? 'disabled' : ''}>
             ${compiling[h.id] ? '…понимает' : 'Понять'}</button>`
        : `${rows}${addBtn}`;
      return `<div class="hero">
        <div class="hero-name">${h.name} <span class="dim">[${h.character}]</span> ${toggle}</div>
        ${editor}${err}
        <div class="dim" style="margin-top:6px">Как понял:</div>${cardHtml}
      </div>`;
    })
    .join('');
}

function setPhrasesPreview(heroId: string, draft: PhraseDraft, names: Record<string, string>): Rule | null {
  const r = compilePhrase(draft, run.vocab, names);
  return r.ok ? r.rule : null;
}

function actionPanelHtml(): string {
  if (run.status !== 'ongoing') {
    const cls = run.status === 'won' ? 'win' : 'loss';
    const text = run.status === 'won' ? '🏆 Забег пройден!' : '☠ Забег окончен';
    return `<div class="result-banner ${cls}">${text}</div>
      <div class="dim">${run.log.map(esc).join('<br>')}</div>
      <p><button class="primary" data-action="new-run">Новый забег (seed ${run.runSeed + 1})</button></p>`;
  }
  const node = currentNode(run)!;
  if (node.kind === 'fight') {
    const foes = foesForFight(node.index)
      .map((f) => f.name)
      .join(', ');
    return `<h2>Бой ${node.index + 1} из 5</h2>
      <div class="dim">Противник: ${esc(foes)}</div>
      <p><button class="primary" data-action="fight">⚔ В бой</button></p>`;
  }
  const offer = scriptoriumOffer(run);
  const conceptBtns = offer.concepts
    .map(
      (c) =>
        `<button data-action="buy-concept" data-concept="${c}">Открыть концепт: «${CONCEPTS[c].label}»</button>`,
    )
    .join(' ');
  const names = heroNames(run);
  const slotBtn = offer.slotHero
    ? `<button data-action="buy-slot" data-hero="${offer.slotHero}">+1 слот для ${names[offer.slotHero]}</button>`
    : '';
  return `<h2>✎ Скрипторий</h2>
    <div class="dim">Выбери одно:</div>
    <p>${conceptBtns} ${slotBtn} <button data-action="skip">Пропустить</button></p>`;
}

function vocabHtml(): string {
  return `<div class="dim">Словарь: ${run.vocab.map((c) => CONCEPTS[c].label).join(' · ')}</div>`;
}

function renderNodeScreen(): void {
  app.innerHTML = `
    <h1>Prompt &amp; Sword</h1>
    <div class="dim">Забег seed=${run.runSeed}. Билд — это текст: пиши принципы, герои поймут по-своему.</div>
    ${nodeStripHtml()}
    <div class="columns">
      <div class="col-main">
        <div class="panel">${actionPanelHtml()}</div>
        <div class="panel">${vocabHtml()}</div>
      </div>
      <div class="col-side">
        <div class="panel"><h2>Принципы</h2>${heroesHtml()}</div>
      </div>
    </div>`;
  bindNodeScreen();
}

function draftsFromDom(heroId: string): PhraseDraft[] {
  const rows = [...app.querySelectorAll<HTMLSelectElement>(`.cond-select[data-hero="${heroId}"]`)];
  return rows.map((condSel) => {
    const idx = condSel.dataset.idx!;
    const prefSel = app.querySelector<HTMLSelectElement>(`.pref-select[data-hero="${heroId}"][data-idx="${idx}"]`)!;
    const wSel = app.querySelector<HTMLSelectElement>(`.weight-select[data-hero="${heroId}"][data-idx="${idx}"]`)!;
    return {
      condition: JSON.parse(condSel.value) as ConditionDraft,
      preference: JSON.parse(prefSel.value) as PreferenceDraft,
      weight: Number(wSel.value),
    };
  });
}

function bindNodeScreen(): void {
  for (const sel of app.querySelectorAll<HTMLSelectElement>('select[data-hero]')) {
    sel.addEventListener('change', () => {
      const heroId = sel.dataset.hero!;
      const r = setPhrases(run, heroId, draftsFromDom(heroId));
      editError[heroId] = r.ok ? '' : r.error;
      delete heroUncertainty[heroId]; // правка чипсами — заметки компилятора устарели
      renderNodeScreen();
    });
  }
  for (const ta of app.querySelectorAll<HTMLTextAreaElement>('textarea.principle-text')) {
    ta.addEventListener('input', () => {
      heroText[ta.dataset.hero!] = ta.value;
    });
  }
  for (const btn of app.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
    btn.addEventListener('click', () => {
      const a = btn.dataset.action!;
      if (a === 'fight') {
        startBattle();
      } else if (a === 'buy-concept') {
        chooseInScriptorium(run, { kind: 'concept', id: btn.dataset.concept as ConceptId });
        renderNodeScreen();
      } else if (a === 'buy-slot') {
        chooseInScriptorium(run, { kind: 'slot', heroId: btn.dataset.hero! });
        renderNodeScreen();
      } else if (a === 'skip') {
        chooseInScriptorium(run, { kind: 'skip' });
        renderNodeScreen();
      } else if (a === 'new-run') {
        location.search = `?seed=${run.runSeed + 1}`;
      } else if (a === 'add-phrase') {
        const heroId = btn.dataset.hero!;
        const hero = run.heroes.find((h) => h.id === heroId)!;
        const drafts = [...draftsFromDom(heroId), { condition: { id: 'always' } as const, preference: { id: 'act.retreat' } as const }];
        const r = setPhrases(run, heroId, drafts);
        editError[heroId] = r.ok ? '' : r.error;
        delete heroUncertainty[heroId];
        renderNodeScreen();
      } else if (a === 'del-phrase') {
        const heroId = btn.dataset.hero!;
        const drafts = draftsFromDom(heroId);
        drafts.splice(Number(btn.dataset.idx), 1);
        const r = setPhrases(run, heroId, drafts);
        editError[heroId] = r.ok ? '' : r.error;
        delete heroUncertainty[heroId];
        renderNodeScreen();
      } else if (a === 'toggle-text') {
        const heroId = btn.dataset.hero!;
        textMode[heroId] = !textMode[heroId];
        editError[heroId] = '';
        renderNodeScreen();
      } else if (a === 'compile-text') {
        void compileHeroText(btn.dataset.hero!);
      }
    });
  }
}

// ---------- экран боя ----------

interface ViewUnit {
  id: string;
  name: string;
  side: 'party' | 'foe';
  pos: { x: number; y: number };
  hp: number;
  maxHp: number;
  alive: boolean;
}

function startBattle(): void {
  const node = currentNode(run);
  if (node?.kind !== 'fight') return;
  battle = runBattle(battleSeed(run), [...heroSpecs(run), ...foesForFight(node.index)]);
  playIdx = 0;
  stopTimer();
  renderBattleScreen();
  timer = window.setInterval(() => {
    if (!battle || playIdx >= battle.events.length) {
      stopTimer();
      return;
    }
    playIdx++;
    renderBattleScreen();
  }, 220);
}

function viewAt(idx: number): { units: Map<string, ViewUnit>; lines: string[] } {
  const units = new Map<string, ViewUnit>();
  const lines: string[] = [];
  if (!battle) return { units, lines };
  const nm = (id: string): string => units.get(id)?.name ?? id;
  for (const e of battle.events.slice(0, idx)) {
    switch (e.t) {
      case 'spawn':
        units.set(e.unit, { id: e.unit, name: e.name, side: e.side, pos: { ...e.pos }, hp: e.maxHp, maxHp: e.maxHp, alive: true });
        break;
      case 'round':
        lines.push(`<div class="turn"><b>— раунд ${e.n} —</b></div>`);
        break;
      case 'decision': {
        const act = e.action === 'attack' ? `атака ${nm(e.target!)}` : e.action === 'defend' ? 'защита' : 'ждёт';
        const facts = e.factors.map((f) => `${esc(f.label)} ${f.value >= 0 ? '+' : ''}${f.value.toFixed(1)}`).join(', ');
        lines.push(`<div>${nm(e.unit)} → ${act}<div class="factors">${facts}</div></div>`);
        break;
      }
      case 'move':
        units.get(e.unit)!.pos = { ...e.to };
        break;
      case 'attack': {
        const u = units.get(e.target)!;
        u.hp = e.targetHp;
        lines.push(`<div class="hit">${nm(e.unit)} бьёт ${nm(e.target)}: −${e.dmg}${e.flank ? ' (фланг!)' : ''}</div>`);
        break;
      }
      case 'die':
        units.get(e.unit)!.alive = false;
        lines.push(`<div class="death">✝ ${nm(e.unit)} погибает</div>`);
        break;
      case 'end':
        break;
      default:
        break;
    }
  }
  return { units, lines };
}

function renderBattleScreen(): void {
  if (!battle) return;
  const { units, lines } = viewAt(playIdx);
  const done = playIdx >= battle.events.length;

  const cells: string[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const u = [...units.values()].find((u) => u.pos.x === x && u.pos.y === y && u.alive);
      const token = u
        ? `<div class="token ${u.side} ${u.alive ? '' : 'dead'}" title="${esc(u.name)}">${esc(u.name[0]!)}<div class="hpbar"><span style="width:${Math.round((u.hp / u.maxHp) * 100)}%"></span></div></div>`
        : '';
      cells.push(`<div class="cell">${token}</div>`);
    }
  }

  const banner = done
    ? battle.winner === 'party'
      ? `<div class="result-banner win">Победа за ${battle.rounds} раундов</div>`
      : battle.winner === 'foe'
        ? `<div class="result-banner loss">Поражение…</div>`
        : `<div class="result-banner">Ничья (лимит раундов)</div>`
    : '';
  const doneButtons = done
    ? `<button class="primary" data-action="accept">Принять исход</button>
       <button data-action="sparring">↻ Переиграть с теми же костями</button>`
    : `<button data-action="ff">⏩ До конца</button>`;

  app.innerHTML = `
    <h1>Prompt &amp; Sword — бой</h1>
    <div class="columns">
      <div class="col-main">
        <div class="grid">${cells.join('')}</div>
        ${banner}
        <div class="controls">${doneButtons}</div>
      </div>
      <div class="col-side">
        <div class="panel"><h2>Лог решений</h2><div class="log" id="log">${lines.join('')}</div></div>
      </div>
    </div>`;

  const log = document.getElementById('log');
  if (log) log.scrollTop = log.scrollHeight;

  for (const btn of app.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
    btn.addEventListener('click', () => {
      const a = btn.dataset.action!;
      if (a === 'ff') {
        stopTimer();
        playIdx = battle!.events.length;
        renderBattleScreen();
      } else if (a === 'accept') {
        stopTimer();
        playFight(run);
        battle = null;
        renderNodeScreen();
      } else if (a === 'sparring') {
        stopTimer();
        battle = null;
        renderNodeScreen();
      }
    });
  }
}

// ---------- старт ----------

renderNodeScreen();
