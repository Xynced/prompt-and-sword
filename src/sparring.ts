import { type BattleEvent, type BattleResult, type UnitSpec, runBattle } from './battle.js';
import type { ArenaTag } from './terrain.js';

/**
 * Спарринг — «переиграть с теми же костями»: тот же seed, те же враги,
 * но принципы переписаны. Основной инструмент обучения.
 */

export interface SparringDiff {
  winnerBefore: BattleResult['winner'];
  winnerAfter: BattleResult['winner'];
  roundsBefore: number;
  roundsAfter: number;
  casualtiesBefore: string[];
  casualtiesAfter: string[];
  /** Раунд, с которого бои разошлись; null — бои идентичны. */
  firstDivergenceRound: number | null;
}

export interface SparringResult {
  before: BattleResult;
  after: BattleResult;
  diff: SparringDiff;
}

type Physical = Exclude<BattleEvent, { t: 'decision' }>;

function physicalWithRounds(events: readonly BattleEvent[]): { round: number; e: Physical }[] {
  let round = 0;
  const out: { round: number; e: Physical }[] = [];
  for (const e of events) {
    if (e.t === 'round') round = e.n;
    if (e.t !== 'decision') out.push({ round, e: e as Physical });
  }
  return out;
}

function firstDivergence(a: readonly BattleEvent[], b: readonly BattleEvent[]): number | null {
  const pa = physicalWithRounds(a);
  const pb = physicalWithRounds(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ea = pa[i];
    const eb = pb[i];
    if (!ea || !eb) return (ea ?? eb)!.round;
    if (JSON.stringify(ea.e) !== JSON.stringify(eb.e)) return Math.min(ea.round, eb.round);
  }
  return null;
}

function casualties(r: BattleResult): string[] {
  return r.units.filter((u) => u.side === 'party' && !u.alive).map((u) => u.name);
}

export function sparring(
  seed: number,
  foes: readonly UnitSpec[],
  partyBefore: readonly UnitSpec[],
  partyAfter: readonly UnitSpec[],
  arena?: ArenaTag,
): SparringResult {
  const before = runBattle(seed, [...partyBefore, ...foes], arena);
  const after = runBattle(seed, [...partyAfter, ...foes], arena);
  return {
    before,
    after,
    diff: {
      winnerBefore: before.winner,
      winnerAfter: after.winner,
      roundsBefore: before.rounds,
      roundsAfter: after.rounds,
      casualtiesBefore: casualties(before),
      casualtiesAfter: casualties(after),
      firstDivergenceRound: firstDivergence(before.events, after.events),
    },
  };
}
