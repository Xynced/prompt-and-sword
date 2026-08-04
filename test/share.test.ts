import { describe, expect, it } from 'vitest';
import { exportBuild, importBuild } from '../src/share.js';
import { generateMap, heroSpecs, setPhrases, startRun } from '../src/run.js';

function customState() {
  const state = startRun(5);
  state.vocab.push('sel.leader', 'space.flank', 'cond.outnumbered');
  const lead = state.heroes[0]!;
  lead.slots = 3;
  const r = setPhrases(state, lead.id, [
    { condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.leader' }, weight: 2 },
    { condition: { id: 'cond.outnumbered' }, preference: { id: 'act.retreat' } },
    { condition: { id: 'always' }, preference: { id: 'space.flank' } },
  ]);
  expect(r.ok).toBe(true);
  return state;
}

describe('экспорт билда строкой (фаза 5)', () => {
  it('round-trip: сид, словарь, слоты и принципы выживают', () => {
    const src = customState();
    const r = importBuild(exportBuild(src));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.runSeed).toBe(5);
    expect([...r.state.vocab].sort()).toEqual([...src.vocab].sort());
    for (const hero of src.heroes) {
      const imported = r.state.heroes.find((h) => h.id === hero.id)!;
      expect(imported.slots).toBe(hero.slots);
      expect(imported.phrases).toEqual(hero.phrases);
    }
    // импортированный забег стартует с начала той же карты
    expect(r.state.at).toBe(0);
    expect(r.state.map).toEqual(generateMap(5));
    expect(() => heroSpecs(r.state)).not.toThrow();
  });

  it('строка выглядит как ps1.<base64url> и переносится через URL', () => {
    const s = exportBuild(customState());
    expect(s.startsWith('ps1.')).toBe(true);
    expect(s).toBe(encodeURIComponent(s));
  });

  it('мусор и подделки отбиваются с внятной ошибкой', () => {
    for (const bad of [
      'абракадабра',
      'ps1.###не-base64###',
      `ps1.${btoa('{"truncated"')}`,
      `ps1.${btoa(JSON.stringify({ v: 99, seed: 1, vocab: [], heroes: [] }))}`,
      `ps1.${btoa(JSON.stringify({ v: 1, seed: 'x', vocab: [], heroes: [] }))}`,
      `ps1.${btoa(JSON.stringify({ v: 1, seed: 1, vocab: ['act.hackTheGibson'], heroes: [] }))}`,
      `ps1.${btoa(JSON.stringify({ v: 1, seed: 1, vocab: [], heroes: [{ id: 'evil', slots: 2, phrases: [] }] }))}`,
      `ps1.${btoa(
        JSON.stringify({
          v: 1,
          seed: 1,
          vocab: [],
          heroes: [{ id: startRun(1).heroes[0]!.id, slots: 99, phrases: [] }],
        }),
      )}`,
    ]) {
      const r = importBuild(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it('принципы на закрытых концептах не проходят импорт', () => {
    const src = customState();
    const build = JSON.parse(atob(exportBuild(src).slice(4)));
    build.vocab = build.vocab.filter((c: string) => c !== 'space.flank');
    const r = importBuild(`ps1.${btoa(JSON.stringify(build))}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(src.heroes[0]!.name);
  });
});
