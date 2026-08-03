import { describe, expect, it } from 'vitest';
import { type BattleEvent, runBattle } from '../src/battle.js';
import { makeFoes, makeIrSets, makeRushVariant } from '../src/scenarios.js';

/** Критерии Ворот A в виде тестов (уменьшенная выборка сидов для скорости). */

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

function actionTrace(events: readonly BattleEvent[]): string {
  return JSON.stringify(events.filter((e) => e.t !== 'decision' && e.t !== 'round'));
}

describe('Ворота A', () => {
  it('критерий 1: разные наборы правил дают разные исходы', () => {
    const winrates = makeIrSets().map((set) => {
      let wins = 0;
      for (const seed of SEEDS) {
        if (runBattle(seed, [...set.party, ...makeFoes()]).winner === 'party') wins++;
      }
      return wins / SEEDS.length;
    });
    const spread = Math.max(...winrates) - Math.min(...winrates);
    // между лучшим и худшим набором — ощутимая разница
    expect(spread).toBeGreaterThanOrEqual(0.3);
  });

  it('критерий 2: смена одного правила меняет ход боя в ≥60% сидов', () => {
    const base = makeIrSets()[0]!;
    const variant = makeRushVariant();
    let diverged = 0;
    for (const seed of SEEDS) {
      const a = runBattle(seed, [...base.party, ...makeFoes()]);
      const b = runBattle(seed, [...variant.party, ...makeFoes()]);
      if (actionTrace(a.events) !== actionTrace(b.events)) diverged++;
    }
    expect(diverged / SEEDS.length).toBeGreaterThanOrEqual(0.6);
  });

  it('критерий 3: у каждого решения есть читаемые факторы (основа разбора)', () => {
    const set = makeIrSets()[3]!; // guard-mage: самый насыщенный правилами
    const r = runBattle(1, [...set.party, ...makeFoes()]);
    const decisions = r.events.filter((e) => e.t === 'decision');
    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      if (d.t !== 'decision') continue;
      expect(d.factors.length).toBeGreaterThan(0);
      for (const f of d.factors) {
        expect(f.label.length).toBeGreaterThan(0);
        expect(Number.isFinite(f.value)).toBe(true);
      }
    }
    // правила реально участвуют в решениях, а не только инстинкты
    const ruleDriven = decisions.filter(
      (d) => d.t === 'decision' && d.factors.some((f) => f.label.startsWith('правило:')),
    );
    expect(ruleDriven.length / decisions.length).toBeGreaterThan(0.5);
  });
});
