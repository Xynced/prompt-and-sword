import { readFileSync, readdirSync } from 'node:fs';
import { type BattleEvent, type BattleResult, runBattle } from './battle.js';
import { type IrSet, makeFoes, makeIrSets, makeRushVariant } from './scenarios.js';
import { understandingCard } from './cards.js';
import { describeDraft } from './constructor.js';
import { type CompileRequest, anthropicModelCall, compileFreeText, type ModelCall } from './compiler/compile.js';
import { fileCache } from './compiler/cache-node.js';
import {
  chooseInScriptorium,
  currentNode,
  heroNames,
  heroSpecs,
  playFight,
  scriptoriumOffer,
  startRun,
} from './run.js';

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);

function run(set: IrSet, seed: number): BattleResult {
  return runBattle(seed, [...set.party, ...makeFoes()]);
}

/** Последовательность «физических» событий боя — для сравнения дивергенции. */
function actionTrace(events: readonly BattleEvent[]): string {
  return JSON.stringify(events.filter((e) => e.t !== 'decision' && e.t !== 'round'));
}

interface SetStats {
  name: string;
  desc: string;
  winrate: number;
  avgRounds: number;
  avgSurvivors: number;
  avgPartyX: number;
}

function collectStats(set: IrSet): SetStats {
  let wins = 0;
  let rounds = 0;
  let survivors = 0;
  let partyX = 0;
  for (const seed of SEEDS) {
    const r = run(set, seed);
    if (r.winner === 'party') wins++;
    rounds += r.rounds;
    const alive = r.units.filter((u) => u.side === 'party' && u.alive);
    survivors += alive.length;
    const party = r.units.filter((u) => u.side === 'party');
    partyX += party.reduce((s, u) => s + u.pos.x, 0) / party.length;
  }
  const n = SEEDS.length;
  return {
    name: set.name,
    desc: set.desc,
    winrate: wins / n,
    avgRounds: rounds / n,
    avgSurvivors: survivors / n,
    avgPartyX: partyX / n,
  };
}

function gateA(): void {
  console.log(`Ворота A: 5 наборов IR × ${SEEDS.length} сидов\n`);
  console.log('набор           winrate  раунды  выжившие  centroid.x  — описание');
  const stats = makeIrSets().map(collectStats);
  for (const s of stats) {
    console.log(
      `${s.name.padEnd(15)} ${(s.winrate * 100).toFixed(0).padStart(6)}%  ${s.avgRounds
        .toFixed(1)
        .padStart(6)}  ${s.avgSurvivors.toFixed(2).padStart(8)}  ${s.avgPartyX
        .toFixed(2)
        .padStart(10)}  — ${s.desc}`,
    );
  }

  // Критерий 2: изменение одного правила меняет ход боя в ≥60% сидов
  const base = makeIrSets()[0]!;
  const variant = makeRushVariant();
  let diverged = 0;
  let outcomeFlips = 0;
  for (const seed of SEEDS) {
    const a = run(base, seed);
    const b = run(variant, seed);
    if (actionTrace(a.events) !== actionTrace(b.events)) diverged++;
    if (a.winner !== b.winner) outcomeFlips++;
  }
  const pct = (diverged / SEEDS.length) * 100;
  console.log(`\nДивергенция от смены 1 правила (Гром: nearest→leader):`);
  console.log(`  ход боя изменился: ${pct.toFixed(0)}% сидов (цель ≥60%)`);
  console.log(`  исход перевернулся: ${((outcomeFlips / SEEDS.length) * 100).toFixed(0)}% сидов`);
  console.log(`\nВорота A, критерий 2: ${pct >= 60 ? 'PASS' : 'FAIL'}`);
}

function fmtPos(p: { x: number; y: number }): string {
  return `(${p.x},${p.y})`;
}

function verboseRun(setName: string, seed: number): void {
  const set = [...makeIrSets(), makeRushVariant()].find((s) => s.name === setName);
  if (!set) {
    console.error(`Неизвестный набор: ${setName}`);
    return;
  }
  const specs = [...set.party, ...makeFoes()];
  const names = new Map(specs.map((s) => [s.id, s.name]));
  const nm = (id: string): string => names.get(id) ?? id;
  const r = runBattle(seed, specs);
  console.log(`${set.desc} | seed=${seed}\n`);
  for (const e of r.events) {
    switch (e.t) {
      case 'round':
        console.log(`— раунд ${e.n} —`);
        break;
      case 'decision': {
        const facts = e.factors
          .map((f) => `${f.label} ${f.value >= 0 ? '+' : ''}${f.value.toFixed(1)}`)
          .join(', ');
        const act = e.action === 'attack' ? `атака ${nm(e.target!)}` : e.action;
        console.log(`${nm(e.unit)} → ${act} @${fmtPos(e.to)}  [${facts}]`);
        break;
      }
      case 'attack':
        console.log(
          `  ${nm(e.unit)} бьёт ${nm(e.target)}: ${e.dmg} урона${e.flank ? ' (фланг!)' : ''}, hp=${e.targetHp}`,
        );
        break;
      case 'die':
        console.log(`  ✝ ${nm(e.unit)} погибает`);
        break;
      case 'end':
        console.log(`\nИтог: ${e.winner === 'party' ? 'победа партии' : e.winner === 'foe' ? 'поражение' : 'ничья'} за ${e.rounds} раундов`);
        break;
      default:
        break;
    }
  }
}

/** Демо мини-забега: дефолтные принципы, в скриптории берём первый концепт. */
function demoRun(runSeed: number): void {
  const state = startRun(runSeed);
  console.log(`Мини-забег, seed=${runSeed}\n`);

  console.log('Карточки «как понял» перед стартом:');
  const names = heroNames(state);
  for (const spec of heroSpecs(state)) {
    const card = understandingCard({ name: spec.name, character: spec.character }, spec.rules, names);
    console.log(`  ${card.heroName} [${card.character}]`);
    for (const line of card.lines) console.log(`    · ${line}`);
  }
  console.log('');

  while (state.status === 'ongoing') {
    const node = currentNode(state)!;
    if (node.kind === 'fight') {
      const alive = state.heroes.filter((h) => h.alive).map((h) => h.name);
      const r = playFight(state);
      console.log(
        `Бой ${node.index + 1}: [${alive.join(', ')}] → ${
          r.winner === 'party' ? 'победа' : r.winner === 'foe' ? 'поражение' : 'ничья'
        } за ${r.rounds} раундов`,
      );
    } else {
      const offer = scriptoriumOffer(state);
      const choice = offer.concepts[0]
        ? ({ kind: 'concept', id: offer.concepts[0] } as const)
        : offer.slotHero
          ? ({ kind: 'slot', heroId: offer.slotHero } as const)
          : ({ kind: 'skip' } as const);
      chooseInScriptorium(state, choice);
      console.log(`Скрипторий: ${state.log.at(-1)}`);
    }
  }
  console.log(`\nИтог забега: ${state.status === 'won' ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ'}`);
  console.log(state.log.map((l) => `  ${l}`).join('\n'));
}

// ---------- LLM-компилятор (живые вызовы; кэш в .cache/) ----------

/** Контекст компиляции из стартового состояния забега (STARTING_VOCAB). */
function compileRequest(text: string, heroId: string): CompileRequest {
  const state = startRun(1);
  const hero = state.heroes.find((h) => h.id === heroId);
  if (!hero) throw new Error(`Нет героя ${heroId} (есть: ${state.heroes.map((h) => h.id).join(', ')})`);
  const allies = Object.fromEntries(
    state.heroes.filter((h) => h.id !== heroId).map((h) => [h.id, h.name]),
  );
  return {
    text,
    heroId: hero.id,
    heroName: hero.name,
    character: hero.character,
    vocab: state.vocab,
    allies,
    maxPhrases: hero.slots,
  };
}

async function liveCall(): Promise<ModelCall> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return anthropicModelCall(new Anthropic());
}

async function compileCmd(text: string, heroId: string): Promise<void> {
  const req = compileRequest(text, heroId);
  const r = await compileFreeText(req, await liveCall(), fileCache());
  if (!r.ok) {
    console.error(`✗ ${r.error}`);
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('  (нет ANTHROPIC_API_KEY — оффлайн-режим работает через конструктор)');
    }
    process.exitCode = 1;
    return;
  }
  console.log(`«${text}» → ${req.heroName} [${req.character}]${r.cached ? ' (из кэша)' : ''}\n`);
  const names = { ...req.allies, [req.heroId]: req.heroName };
  console.log('Фразы (до линзы):');
  for (const ph of r.phrases) console.log(`  · ${describeDraft(ph, names)}`);
  const card = understandingCard({ name: req.heroName, character: req.character }, r.rules, names, r.uncertainty);
  console.log('\nКак понял (после линзы):');
  for (const line of card.lines) console.log(`  · ${line}`);
}

/**
 * Прогон корпуса формулировок (подготовка к Воротам C).
 * Формат строки: `текст` или `текст => ожидаемое понимание` (формат describeDraft,
 * фразы через ' | '). Пустые строки и # — пропускаются.
 */
async function corpusCmd(files: string[], heroId: string): Promise<void> {
  if (files.length === 0) {
    try {
      files = readdirSync('corpus')
        .filter((f) => f.endsWith('.txt'))
        .map((f) => `corpus/${f}`);
    } catch {
      files = [];
    }
    if (files.length === 0) {
      console.error('Нет файлов корпуса (corpus/*.txt)');
      process.exitCode = 1;
      return;
    }
  }
  const call = await liveCall();
  const cache = fileCache();
  let total = 0;
  let compiled = 0;
  let uncertain = 0;
  let withIntent = 0;
  let intentMatch = 0;
  for (const file of files) {
    console.log(`— ${file} —`);
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    for (const line of lines) {
      const [text = '', expected] = line.split('=>').map((s) => s.trim());
      total++;
      const req = compileRequest(text, heroId);
      const r = await compileFreeText(req, call, cache);
      if (!r.ok) {
        console.log(`  ✗ «${text}» — ${r.error}`);
        continue;
      }
      compiled++;
      if (r.uncertainty.length > 0) uncertain++;
      const names = { ...req.allies, [req.heroId]: req.heroName };
      const actual = r.phrases.map((ph) => describeDraft(ph, names)).join(' | ');
      let mark = '✓';
      if (expected) {
        withIntent++;
        if (actual === expected) {
          intentMatch++;
        } else {
          mark = '≠';
        }
      }
      console.log(`  ${mark} «${text}»`);
      console.log(`      → ${actual}`);
      if (mark === '≠') console.log(`      ожидалось: ${expected}`);
      for (const u of r.uncertainty) console.log(`      ⚠ ${u}`);
    }
  }
  const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`);
  console.log(`\nИтог: ${total} формулировок`);
  console.log(`  скомпилировано: ${compiled} (${pct(compiled, total)}, цель Ворот C ≥85% с совпадением намерения)`);
  console.log(`  с неуверенностью: ${uncertain} (${pct(uncertain, compiled)})`);
  console.log(`  совпало с намерением: ${intentMatch}/${withIntent} (${pct(intentMatch, withIntent)} из строк с «=>»)`);
}

const [cmd = 'gateA', ...rest] = process.argv.slice(2);
if (cmd === 'gateA') {
  gateA();
} else if (cmd === 'run') {
  const setName = rest[0] ?? 'rush';
  const seed = Number(rest[1] ?? 1);
  verboseRun(setName, seed);
} else if (cmd === 'demo-run') {
  demoRun(Number(rest[0] ?? 1));
} else if (cmd === 'compile') {
  const text = rest[0];
  if (!text) {
    console.error('Использование: pnpm sim compile "<текст принципа>" [heroId=grom]');
    process.exitCode = 1;
  } else {
    await compileCmd(text, rest[1] ?? 'grom');
  }
} else if (cmd === 'corpus') {
  await corpusCmd(rest.filter((a) => a.endsWith('.txt')), 'grom');
} else {
  console.log(
    'Использование: pnpm sim [gateA | run <набор> <seed> | demo-run <seed> | compile "<текст>" [герой] | corpus [файлы…]]',
  );
}
