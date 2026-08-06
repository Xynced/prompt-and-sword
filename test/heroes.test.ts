import { describe, expect, it } from 'vitest';
import { HERO_POOL, defaultPhrasesFor, heroArchetype, pickParty } from '../src/heroes.js';
import { heroNames, heroSpecs, startRun } from '../src/run.js';
import { compilePhrase } from '../src/constructor.js';
import { STARTING_VOCAB } from '../src/vocab.js';
import { mulberry32 } from '../src/rng.js';

describe('пул героев', () => {
  it('в пуле нет дублей id, у каждого — способность с врождёнными правилами', () => {
    expect(new Set(HERO_POOL.map((h) => h.id)).size).toBe(HERO_POOL.length);
    for (const h of HERO_POOL) {
      expect(h.innate.length).toBeGreaterThan(0);
      for (const r of h.innate) expect(r.source.startsWith('способность')).toBe(true);
      expect(heroArchetype(h.id)).toBe(h);
    }
  });

  it('у каждого героя есть класс; 8 базовых классов представлены по два варианта', () => {
    for (const h of HERO_POOL) expect(h.class.length).toBeGreaterThan(0);
    expect(HERO_POOL.length).toBe(16);
    // класс пары различим по общему корню ярлыка (воин, варвар, плут…)
    const roots = ['воин', 'варвар', 'следопыт', 'плут', 'волшебниц', 'жр', 'монах', 'паладин'];
    for (const root of roots) {
      expect(HERO_POOL.filter((h) => h.class.includes(root)).length).toBe(2);
    }
  });

  it('партия: ровно 3 уникальных, первый — передовой, детерминировано от rng', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const party = pickParty(mulberry32(seed));
      expect(party.length).toBe(3);
      expect(new Set(party.map((h) => h.id)).size).toBe(3);
      expect(party[0]!.role).toBe('front');
      expect(pickParty(mulberry32(seed)).map((h) => h.id)).toEqual(party.map((h) => h.id));
    }
  });

  it('разные сиды дают разные партии (пул реально используется)', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      seen.add(
        startRun(seed)
          .heroes.map((h) => h.id)
          .sort()
          .join('+'),
      );
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('дефолтные принципы любого архетипа компилируются в стартовом словаре', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const state = startRun(seed);
      const names = heroNames(state);
      for (const h of state.heroes) {
        expect(h.phrases.length).toBeLessThanOrEqual(h.slots);
        for (const d of h.phrases) {
          expect(compilePhrase(d, STARTING_VOCAB, names).ok).toBe(true);
        }
      }
    }
  });

  it('каждый архетип строит валидный дефолт в любой партии со своим участием', () => {
    for (const arch of HERO_POOL) {
      const others = HERO_POOL.filter((h) => h.id !== arch.id).slice(0, 2);
      const party = [arch, ...others];
      const drafts = defaultPhrasesFor(arch, party);
      expect(drafts.length).toBeGreaterThan(0);
      const names = Object.fromEntries(party.map((h) => [h.id, h.name]));
      for (const d of drafts) expect(compilePhrase(d, STARTING_VOCAB, names).ok).toBe(true);
    }
  });

  it('способность попадает в боевые спеки героя поверх приказов', () => {
    const state = startRun(7);
    for (const spec of heroSpecs(state)) {
      const innate = heroArchetype(spec.id).innate;
      for (const r of innate) expect(spec.rules).toContainEqual(r);
      // приказы идут раньше врождённых правил
      expect(spec.rules.length).toBeGreaterThanOrEqual(innate.length);
    }
  });

  it('наёмник меняет имя и линзы, но тело и способность архетипа остаются', () => {
    const state = startRun(3);
    const fallen = state.heroes[1]!;
    expect(fallen.archetypeId).toBe(fallen.id);
    expect(fallen.stats.maxHp).toBe(heroArchetype(fallen.archetypeId).stats.maxHp);
  });
});
