import { readFileSync, readdirSync } from 'node:fs';
import { type BattleEvent, type BattleResult, runBattle } from './battle.js';
import { type IrSet, makeFoes, makeIrSets, makeRushVariant } from './scenarios.js';
import { understandingCard } from './cards.js';
import { describeDraft } from './constructor.js';
import { type CompileRequest, anthropicModelCall, compileFreeText, type ModelCall } from './compiler/compile.js';
import { fileCache } from './compiler/cache-node.js';
import { balanceSweep, kiteRewrite } from './balance.js';
import { fingerprint } from './metrics.js';
import {
  advance,
  chooseInEvent,
  chooseInScriptorium,
  claimReward,
  currentNode,
  eventOffer,
  heroNames,
  heroSpecs,
  playFight,
  rest,
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
  draws: number;
  avgRounds: number;
  avgSurvivors: number;
  avgPartyX: number;
  /** Поведенческий отпечаток (средние по сидам). */
  avgFirstContact: number;
  flankPct: number;
  condPct: number;
  avgNearestDist: number;
  focusShare: number;
}

function collectStats(set: IrSet): SetStats {
  let wins = 0;
  let draws = 0;
  let rounds = 0;
  let survivors = 0;
  let partyX = 0;
  let contactSum = 0;
  let contactN = 0;
  let flank = 0;
  let cond = 0;
  let nearest = 0;
  let focus = 0;
  for (const seed of SEEDS) {
    const r = run(set, seed);
    if (r.winner === 'party') wins++;
    if (r.winner === 'draw') draws++;
    rounds += r.rounds;
    const alive = r.units.filter((u) => u.side === 'party' && u.alive);
    survivors += alive.length;
    const party = r.units.filter((u) => u.side === 'party');
    partyX += party.reduce((s, u) => s + u.pos.x, 0) / party.length;
    const fp = fingerprint(r);
    if (fp.firstContactRound !== undefined) {
      contactSum += fp.firstContactRound;
      contactN++;
    }
    flank += fp.flankPct;
    cond += fp.condPct;
    nearest += fp.avgNearestEnemyDist;
    focus += fp.focusShare;
  }
  const n = SEEDS.length;
  return {
    name: set.name,
    desc: set.desc,
    winrate: wins / n,
    draws,
    avgRounds: rounds / n,
    avgSurvivors: survivors / n,
    avgPartyX: partyX / n,
    avgFirstContact: contactN > 0 ? contactSum / contactN : 0,
    flankPct: flank / n,
    condPct: cond / n,
    avgNearestDist: nearest / n,
    focusShare: focus / n,
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

  // Отпечаток поведения: наборы должны отличаться процессом, не только исходом
  console.log('\nОтпечаток поведения (партия):');
  console.log('набор           контакт  фланг%  усл.прав%  ср.дист  фокус%  ничьи');
  for (const s of stats) {
    console.log(
      `${s.name.padEnd(15)} ${s.avgFirstContact.toFixed(1).padStart(7)}  ${(s.flankPct * 100)
        .toFixed(0)
        .padStart(5)}%  ${(s.condPct * 100).toFixed(0).padStart(8)}%  ${s.avgNearestDist
        .toFixed(2)
        .padStart(7)}  ${(s.focusShare * 100).toFixed(0).padStart(5)}%  ${String(s.draws).padStart(5)}`,
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
  console.log(`${set.desc} | seed=${seed}`);
  console.log(`Арена: ${r.terrain.name} — ${r.terrain.scenario}\n`);
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
      case 'hazard':
        console.log(`  ${nm(e.unit)} ${e.kind === 'spikes' ? 'напоролся на шипы' : 'обожжён'}: ${e.dmg} урона, hp=${e.hp}`);
        break;
      case 'shove':
        console.log(`  ${nm(e.unit)} толкает ${nm(e.target)} в ${fmtPos(e.to)}`);
        break;
      case 'telegraph':
        console.log(`  ${nm(e.unit)} начинает замах: накроет 5×5 у ${fmtPos(e.at)} (${e.dmg} урона)`);
        break;
      case 'aoeCast':
        console.log(
          e.form === 'ritual'
            ? `  ${nm(e.unit)}: ритуал обрушивается на ${fmtPos(e.at)}`
            : e.form === 'line'
              ? `  ${nm(e.unit)} рубит волной в сторону ${fmtPos(e.at)}`
              : `  ${nm(e.unit)} накрывает залпом ${fmtPos(e.at)}`,
        );
        break;
      case 'aoeHit':
        console.log(`  ${nm(e.unit)} накрыт: ${e.dmg} урона, hp=${e.hp}`);
        break;
      case 'rage':
        console.log(`  ${nm(e.unit)} впадает в ярость`);
        break;
      case 'mark':
        console.log(`  ${nm(e.unit)} метит ${nm(e.target)}`);
        break;
      case 'heal':
        console.log(`  ${nm(e.unit)} исцеляет ${nm(e.target)}: +${e.amount}, hp=${e.hp}`);
        break;
      case 'bless':
        console.log(`  ${nm(e.unit)} благословляет ${nm(e.target)} (урон ×${e.mult})`);
        break;
      case 'feint':
        console.log(`  ${nm(e.unit)} финтит: ${nm(e.target)} открыт`);
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

/** Демо забега: дефолтные принципы, урок при поражении переигрывается с фокусом. */
function demoRun(runSeed: number): void {
  const state = startRun(runSeed);
  console.log(`Забег, seed=${runSeed} — карта из ${state.map.length} узлов\n`);

  console.log('Карточки «как понял» перед стартом:');
  const names = heroNames(state);
  for (const spec of heroSpecs(state)) {
    const card = understandingCard({ name: spec.name, lenses: spec.lenses }, spec.rules, names);
    console.log(`  ${card.heroName} [${card.lenses.join('+')}]`);
    for (const line of card.lines) console.log(`    · ${line}`);
  }
  console.log('');

  let lessonTries = 0;
  while (state.status === 'ongoing') {
    const node = currentNode(state);
    switch (node.kind) {
      case 'lesson':
      case 'fight':
      case 'elite':
      case 'boss': {
        const alive = state.heroes.filter((h) => h.alive).map((h) => `${h.name} ${h.hp}hp`);
        const r = playFight(state);
        console.log(
          `Узел ${node.id} [${node.kind}]: [${alive.join(', ')}] → ${
            r.winner === 'party' ? 'победа' : r.winner === 'foe' ? 'поражение' : 'ничья'
          } за ${r.rounds} раундов`,
        );
        if (node.kind === 'lesson' && r.winner !== 'party') {
          if (++lessonTries > 3) {
            console.log('Урок не пройден за 3 попытки — стоп');
            return;
          }
          console.log('  переписываем приказ (кайт): вся партия держит дистанцию и бьёт ближайшего — те же кости');
          kiteRewrite(state);
        }
        if (state.pendingReward?.[0]) {
          claimReward(state, { kind: 'concept', id: state.pendingReward[0] });
          console.log(`  ${state.log.at(-1)}`);
        }
        break;
      }
      case 'scriptorium': {
        const offer = scriptoriumOffer(state);
        const choice = offer.concepts[0]
          ? ({ kind: 'concept', id: offer.concepts[0] } as const)
          : offer.slotHero
            ? ({ kind: 'slot', heroId: offer.slotHero } as const)
            : ({ kind: 'skip' } as const);
        chooseInScriptorium(state, choice);
        console.log(`Узел ${node.id} [скрипторий]: ${state.log.at(-1)}`);
        break;
      }
      case 'event': {
        const offer = eventOffer(state);
        const choice = offer.mercenary
          ? ({ kind: 'hire' } as const)
          : offer.concept || offer.slotHero
            ? ({ kind: 'take' } as const)
            : ({ kind: 'skip' } as const);
        chooseInEvent(state, choice);
        console.log(`Узел ${node.id} [событие]: ${state.log.at(-1)}`);
        break;
      }
      case 'rest':
        rest(state);
        console.log(`Узел ${node.id} [привал]: ${state.log.at(-1)}`);
        break;
    }
    if (state.status === 'ongoing' && state.resolved) {
      advance(state, currentNode(state).next[0]!);
    }
  }
  console.log(`\nИтог забега: ${state.status === 'won' ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ'}`);
  console.log(state.log.map((l) => `  ${l}`).join('\n'));
}

/** Автобаланс: бот играет N забегов, печатаем кривую сложности. */
function balanceCmd(n: number): void {
  const report = balanceSweep(Array.from({ length: n }, (_, i) => i + 1));
  const pct = (x: number, d: number): string => (d === 0 ? '  —' : `${((x / d) * 100).toFixed(0).padStart(3)}%`);
  console.log(`Автобаланс: ${report.seeds} забегов. Бот: дефолт → кайт после поражения в уроке,`);
  console.log('путь случайный от сида, принципы дальше не переписываются (нижняя граница игрока).\n');
  console.log(`Забег выигран: ${pct(report.runsWon, report.seeds)}   босс достигнут: ${pct(report.bossReached, report.seeds)}, hp на подходе к боссу (до кануна): ${(report.avgBossEntryHpFrac * 100).toFixed(0)}%`);
  console.log(`Урок: с 1-й попытки ${pct(report.lessonFirstTry, report.seeds)}, кайт не спас (забег брошен): ${pct(report.lessonStuck, report.seeds)}\n`);
  console.log('Кривая (боевые узлы):');
  console.log('слой  узел    сыграно  winrate  hp после победы');
  for (const p of report.curve) {
    console.log(
      `  ${String(p.layer).padStart(2)}  ${p.kind.padEnd(7)} ${String(p.played).padStart(6)}  ${pct(p.won, p.played).padStart(6)}  ${(p.avgHpAfterWin * 100).toFixed(0).padStart(4)}%`,
    );
  }
  const deaths = [...report.deathsByLayer.entries()].sort((a, b) => a[0] - b[0]);
  const lost = deaths.reduce((s, [, n2]) => s + n2, 0);
  console.log(`\nРоковые бои по слоям (${lost} проигранных забегов, без брошенных на уроке):`);
  for (const [layer, count] of deaths) console.log(`  слой ${layer}: ${count} (${pct(count, lost)})`);
  console.log('\nСмерти героев (наёмник может заменить):');
  for (const [id, count] of [...report.heroDeaths.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id}: ${count}`);
  }
  console.log(`Наёмник нанят: ${report.mercHired} раз`);
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
    lenses: hero.lenses,
    vocab: state.vocab,
    allies,
    maxPhrases: hero.slots,
  };
}

/**
 * Провайдер настраивается через env (по умолчанию — Anthropic / claude-sonnet-5):
 *   COMPILER_MODEL     — имя модели (напр. deepseek-chat)
 *   COMPILER_BASE_URL  — Anthropic-совместимый эндпоинт (напр. https://api.deepseek.com/anthropic)
 *   COMPILER_API_KEY   — ключ провайдера (иначе ANTHROPIC_API_KEY)
 */
async function liveCall(): Promise<ModelCall> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({
    ...(process.env.COMPILER_API_KEY ? { apiKey: process.env.COMPILER_API_KEY } : {}),
    ...(process.env.COMPILER_BASE_URL ? { baseURL: process.env.COMPILER_BASE_URL } : {}),
  });
  return anthropicModelCall(client, process.env.COMPILER_MODEL);
}

async function compileCmd(text: string, heroId: string): Promise<void> {
  const req = compileRequest(text, heroId);
  const call = await liveCall();
  const r = await compileFreeText(req, call, fileCache());
  if (!r.ok) {
    console.error(`✗ ${r.error}`);
    if (!process.env.COMPILER_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      console.error('  (нет COMPILER_API_KEY/ANTHROPIC_API_KEY — оффлайн-режим работает через конструктор)');
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `«${text}» → ${req.heroName} [${req.lenses.join('+')}] · ${call.model}${r.cached ? ' (из кэша)' : ''}\n`,
  );
  const names = { ...req.allies, [req.heroId]: req.heroName };
  console.log('Фразы (до линзы):');
  for (const ph of r.phrases) console.log(`  · ${describeDraft(ph, names)}`);
  const card = understandingCard({ name: req.heroName, lenses: [...req.lenses] }, r.rules, names, r.uncertainty);
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

const [cmd = 'gateA', ...args] = process.argv.slice(2);
if (cmd === 'gateA') {
  gateA();
} else if (cmd === 'run') {
  const setName = args[0] ?? 'rush';
  const seed = Number(args[1] ?? 1);
  verboseRun(setName, seed);
} else if (cmd === 'demo-run') {
  demoRun(Number(args[0] ?? 1));
} else if (cmd === 'balance') {
  balanceCmd(Number(args[0] ?? 500));
} else if (cmd === 'compile') {
  const text = args[0];
  if (!text) {
    console.error('Использование: pnpm sim compile "<текст принципа>" [heroId=grom]');
    process.exitCode = 1;
  } else {
    await compileCmd(text, args[1] ?? 'grom');
  }
} else if (cmd === 'corpus') {
  await corpusCmd(args.filter((a) => a.endsWith('.txt')), 'grom');
} else {
  console.log(
    'Использование: pnpm sim [gateA | run <набор> <seed> | demo-run <seed> | balance [N] | compile "<текст>" [герой] | corpus [файлы…]]',
  );
}
