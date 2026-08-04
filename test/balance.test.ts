import { describe, expect, it } from 'vitest';
import { balanceSweep, kiteRewrite, playBotRun } from '../src/balance.js';
import { startRun } from '../src/run.js';

describe('автобаланс (фаза 5)', () => {
  it('бот детерминирован: тот же сид — тот же исход забега', () => {
    expect(JSON.stringify(playBotRun(7))).toBe(JSON.stringify(playBotRun(7)));
    expect(JSON.stringify(playBotRun(42))).toBe(JSON.stringify(playBotRun(42)));
  });

  it('кайт-переформулировка компилируется после поражения в уроке (слово открыто)', () => {
    const state = startRun(1);
    state.vocab.push('act.standoff'); // урок открывает слово при поражении
    expect(() => kiteRewrite(state)).not.toThrow();
  });

  it('каждый забег завершается: победа, роковой бой или брошенный урок', () => {
    const seeds = Array.from({ length: 30 }, (_, i) => i + 1);
    for (const seed of seeds) {
      const out = playBotRun(seed);
      expect(out.won || out.deathLayer !== undefined).toBe(true);
      expect(out.fights.length).toBeGreaterThan(0);
      for (const f of out.fights) {
        expect(f.partyHpFrac).toBeGreaterThanOrEqual(0);
        expect(f.partyHpFrac).toBeLessThanOrEqual(1);
      }
      if (out.won) {
        expect(out.fights.at(-1)!.kind).toBe('boss');
        expect(out.bossEntryHpFrac).toBeGreaterThan(0);
      }
    }
  });

  it('сводка согласована с исходами', () => {
    const seeds = Array.from({ length: 30 }, (_, i) => i + 1);
    const report = balanceSweep(seeds);
    expect(report.seeds).toBe(30);
    const wins = seeds.filter((s) => playBotRun(s).won).length;
    expect(report.runsWon).toBe(wins);
    const deaths = [...report.deathsByLayer.values()].reduce((a, b) => a + b, 0);
    expect(report.runsWon + report.lessonStuck + deaths).toBe(report.seeds);
  });
});
