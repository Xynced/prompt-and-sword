import { type BattleEvent, type BattleResult, runBattle } from './battle.js';
import { type IrSet, makeFoes, makeIrSets, makeRushVariant } from './scenarios.js';
import { understandingCard } from './cards.js';
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

const [cmd = 'gateA', ...rest] = process.argv.slice(2);
if (cmd === 'gateA') {
  gateA();
} else if (cmd === 'run') {
  const setName = rest[0] ?? 'rush';
  const seed = Number(rest[1] ?? 1);
  verboseRun(setName, seed);
} else if (cmd === 'demo-run') {
  demoRun(Number(rest[0] ?? 1));
} else {
  console.log('Использование: pnpm sim [gateA | run <набор> <seed> | demo-run <seed>]');
}
