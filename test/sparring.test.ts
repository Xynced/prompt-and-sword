import { describe, expect, it } from 'vitest';
import { sparring } from '../src/sparring.js';
import { makeFoes, makeIrSets } from '../src/scenarios.js';

describe('sparring («переиграть с теми же костями»)', () => {
  it('те же принципы — идентичный бой, дивергенции нет', () => {
    const party = makeIrSets()[0]!.party;
    const s = sparring(7, makeFoes(), party, party);
    expect(s.diff.firstDivergenceRound).toBeNull();
    expect(s.diff.winnerBefore).toBe(s.diff.winnerAfter);
    expect(s.diff.roundsBefore).toBe(s.diff.roundsAfter);
  });

  it('переписанные принципы — бой расходится, дивергенция указывает раунд', () => {
    const rush = makeIrSets()[0]!.party;
    const guard = makeIrSets()[3]!.party;
    const s = sparring(7, makeFoes(), rush, guard);
    expect(s.diff.firstDivergenceRound).not.toBeNull();
    expect(s.diff.firstDivergenceRound).toBeGreaterThanOrEqual(1);
  });

  it('спарринг детерминирован: повтор даёт тот же diff', () => {
    const rush = makeIrSets()[0]!.party;
    const kite = makeIrSets()[4]!.party;
    const a = sparring(3, makeFoes(), rush, kite);
    const b = sparring(3, makeFoes(), rush, kite);
    expect(a.diff).toEqual(b.diff);
  });

  it('в диффе видны потери до и после', () => {
    const rush = makeIrSets()[0]!.party;
    const guard = makeIrSets()[3]!.party;
    const s = sparring(2, makeFoes(), rush, guard);
    expect(Array.isArray(s.diff.casualtiesBefore)).toBe(true);
    expect(Array.isArray(s.diff.casualtiesAfter)).toBe(true);
  });
});
