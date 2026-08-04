import {
  type NodeKind,
  type RunState,
  advance,
  chooseInEvent,
  chooseInScriptorium,
  currentNode,
  eventOffer,
  playFight,
  rest,
  scriptoriumOffer,
  setPhrases,
  startRun,
} from './run.js';
import { mulberry32 } from './rng.js';

/**
 * Фаза 5: автобаланс прогонами. Детерминированный бот играет забег целиком:
 * дефолтные принципы; после поражения в уроке — кайт-переформулировка (та же,
 * что предлагает онбординг), дальше принципы не трогает; путь по карте —
 * случайный от сида; скрипторий — первый концепт, событие — взять/нанять.
 *
 * Бот — «слабый игрок»: не подстраивает принципы под разведку и линзы.
 * Его winrate — нижняя граница; интересна форма кривой (где стены и провалы),
 * а не абсолютные проценты.
 */

/** Кайт: Гром держит их, стрелки отходят и жгут слабейших (онбординг урока). */
export function kiteRewrite(state: RunState): void {
  const results = [
    setPhrases(state, 'grom', [
      { condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.nearest' }, weight: 2 },
    ]),
    ...['dart', 'lia'].map((id) =>
      setPhrases(state, id, [
        { condition: { id: 'always' }, preference: { id: 'act.retreat' } },
        { condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.weakest' }, weight: 2 },
      ]),
    ),
  ];
  for (const r of results) {
    if (!r.ok) throw new Error(`kiteRewrite: ${r.error}`);
  }
}

export interface FightRecord {
  layer: number;
  kind: NodeKind;
  won: boolean;
  /** Суммарное hp партии после боя (и перевязки) / сумма maxHp; мёртвые = 0. */
  partyHpFrac: number;
}

export interface RunOutcome {
  runSeed: number;
  won: boolean;
  /** Попыток на урок: 1 — дефолтом, 2 — кайтом после поражения. */
  lessonTries: number;
  /** Кайт тоже проиграл — бот бросает забег (повтор с теми же костями идентичен). */
  lessonStuck: boolean;
  fights: FightRecord[];
  /** Слой и тип рокового боя, если забег проигран в бою. */
  deathLayer?: number;
  deathKind?: NodeKind;
  /** id героев, погибших по ходу забега (наёмник может заменить погибшего). */
  heroDeaths: string[];
  mercHired: boolean;
  /** hp партии на входе к боссу (если дошли). */
  bossEntryHpFrac?: number;
}

function partyHpFrac(state: RunState): number {
  let hp = 0;
  let max = 0;
  for (const h of state.heroes) {
    max += h.stats.maxHp;
    if (h.alive) hp += h.hp;
  }
  return hp / max;
}

const FIGHT_KINDS: NodeKind[] = ['lesson', 'fight', 'elite', 'boss'];

export function playBotRun(runSeed: number): RunOutcome {
  const pathRng = mulberry32(runSeed * 7919 + 3);
  const state = startRun(runSeed);
  const out: RunOutcome = {
    runSeed,
    won: false,
    lessonTries: 0,
    lessonStuck: false,
    fights: [],
    heroDeaths: [],
    mercHired: false,
  };

  while (state.status === 'ongoing') {
    const node = currentNode(state);
    if (FIGHT_KINDS.includes(node.kind)) {
      if (node.kind === 'boss') out.bossEntryHpFrac = partyHpFrac(state);
      const aliveBefore = new Set(state.heroes.filter((h) => h.alive).map((h) => h.id));
      const r = playFight(state);
      const won = r.winner === 'party';
      out.fights.push({ layer: node.layer, kind: node.kind, won, partyHpFrac: partyHpFrac(state) });
      if (node.kind === 'lesson') {
        out.lessonTries++;
        if (!won) {
          if (out.lessonTries >= 2) {
            // тот же seed + те же принципы = тот же бой: третья попытка бессмысленна
            out.lessonStuck = true;
            out.deathLayer = node.layer;
            out.deathKind = node.kind;
            return out;
          }
          kiteRewrite(state);
          continue;
        }
      }
      for (const h of state.heroes) {
        if (aliveBefore.has(h.id) && !h.alive) out.heroDeaths.push(h.id);
      }
      if (!won && node.kind !== 'lesson') {
        // playFight уже перевёл забег в 'lost'
        out.deathLayer = node.layer;
        out.deathKind = node.kind;
      }
    } else if (node.kind === 'scriptorium') {
      const offer = scriptoriumOffer(state);
      const choice = offer.concepts[0]
        ? ({ kind: 'concept', id: offer.concepts[0] } as const)
        : offer.slotHero
          ? ({ kind: 'slot', heroId: offer.slotHero } as const)
          : ({ kind: 'skip' } as const);
      chooseInScriptorium(state, choice);
    } else if (node.kind === 'event') {
      const offer = eventOffer(state);
      if (offer.mercenary) {
        chooseInEvent(state, { kind: 'hire' });
        out.mercHired = true;
      } else if (offer.concept || offer.slotHero) {
        chooseInEvent(state, { kind: 'take' });
      } else {
        chooseInEvent(state, { kind: 'skip' });
      }
    } else {
      rest(state);
    }
    if (state.status === 'ongoing' && state.resolved) {
      const next = currentNode(state).next;
      advance(state, next[Math.floor(pathRng() * next.length)]!);
    }
  }

  out.won = state.status === 'won';
  return out;
}

// ---- Агрегация по многим сидам ----

export interface CurvePoint {
  layer: number;
  kind: NodeKind;
  played: number;
  won: number;
  /** Среднее hp партии после победы в этом бою (истощение по ходу забега). */
  avgHpAfterWin: number;
}

export interface BalanceReport {
  seeds: number;
  runsWon: number;
  lessonFirstTry: number;
  lessonStuck: number;
  curve: CurvePoint[];
  /** Роковые бои (конец забега) по слоям карты. */
  deathsByLayer: Map<number, number>;
  heroDeaths: Map<string, number>;
  mercHired: number;
  bossReached: number;
  avgBossEntryHpFrac: number;
}

export function balanceSweep(seeds: readonly number[]): BalanceReport {
  const curve = new Map<string, CurvePoint & { hpAfterWinSum: number }>();
  const deathsByLayer = new Map<number, number>();
  const heroDeaths = new Map<string, number>();
  let runsWon = 0;
  let lessonFirstTry = 0;
  let lessonStuck = 0;
  let mercHired = 0;
  let bossReached = 0;
  let bossEntryHpSum = 0;

  for (const seed of seeds) {
    const out = playBotRun(seed);
    if (out.won) runsWon++;
    if (out.lessonTries === 1 && !out.lessonStuck) lessonFirstTry++;
    if (out.lessonStuck) lessonStuck++;
    if (out.mercHired) mercHired++;
    if (out.bossEntryHpFrac !== undefined) {
      bossReached++;
      bossEntryHpSum += out.bossEntryHpFrac;
    }
    if (out.deathLayer !== undefined && !out.lessonStuck) {
      deathsByLayer.set(out.deathLayer, (deathsByLayer.get(out.deathLayer) ?? 0) + 1);
    }
    for (const id of out.heroDeaths) heroDeaths.set(id, (heroDeaths.get(id) ?? 0) + 1);
    for (const f of out.fights) {
      const key = `${f.layer}:${f.kind}`;
      const p = curve.get(key) ?? {
        layer: f.layer,
        kind: f.kind,
        played: 0,
        won: 0,
        avgHpAfterWin: 0,
        hpAfterWinSum: 0,
      };
      p.played++;
      if (f.won) {
        p.won++;
        p.hpAfterWinSum += f.partyHpFrac;
      }
      curve.set(key, p);
    }
  }

  const points: CurvePoint[] = [...curve.values()]
    .map(({ hpAfterWinSum, ...p }) => ({
      ...p,
      avgHpAfterWin: p.won > 0 ? hpAfterWinSum / p.won : 0,
    }))
    .sort((a, b) => a.layer - b.layer || a.kind.localeCompare(b.kind));

  return {
    seeds: seeds.length,
    runsWon,
    lessonFirstTry,
    lessonStuck,
    curve: points,
    deathsByLayer,
    heroDeaths,
    mercHired,
    bossReached,
    avgBossEntryHpFrac: bossReached > 0 ? bossEntryHpSum / bossReached : 0,
  };
}
