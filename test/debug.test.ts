import { describe, expect, it } from 'vitest';
import {
  DEBUG_BATTLES,
  MAX_DEBUG_PARTY,
  type DebugSetup,
  debugBattle,
  debugBattleById,
  debugBrief,
  debugRun,
} from '../src/debug.js';
import { scenarioForNode } from '../src/objectives.js';
import { CONCEPTS, type ConceptId } from '../src/vocab.js';
import { currentNode, foesForNode, playFight, startRun } from '../src/run.js';
import { heroArchetype } from '../src/heroes.js';

/**
 * Debug-режим: любой бой каталога × любая партия × любые характеры.
 * Главный инвариант — отладка не заводит второго пути к бою: собранный руками
 * бой обязан совпадать с тем же боем забега побайтово.
 */

const setup = (over: Partial<DebugSetup> = {}): DebugSetup => ({
  battle: 'swarm',
  party: [
    { archetypeId: 'grom', lenses: ['plain'] },
    { archetypeId: 'dart', lenses: ['coward'] },
    { archetypeId: 'lia', lenses: [] },
  ],
  seed: 3,
  ...over,
});

const log = (s: DebugSetup): string => JSON.stringify(debugBattle(s).events);

describe('каталог боёв', () => {
  it('id уникальны, каждый бой играется', () => {
    expect(new Set(DEBUG_BATTLES.map((b) => b.id)).size).toBe(DEBUG_BATTLES.length);
    for (const b of DEBUG_BATTLES) {
      const r = debugBattle(setup({ battle: b.id }));
      expect(r.rounds, b.id).toBeGreaterThan(0);
      expect(['party', 'foe', 'draw'], b.id).toContain(r.winner);
    }
  });

  it('покрывает все составы врагов и все сценарии узлов', () => {
    const compositions = new Set(
      DEBUG_BATTLES.map((b) => JSON.stringify(foesForNode({ id: 0, ...b.node, next: [] }).map((f) => f.id))),
    );
    expect(compositions.size).toBe(DEBUG_BATTLES.length);
    const scenarios = DEBUG_BATTLES.map((b) => scenarioForNode(b.node)?.id).filter(Boolean);
    expect(new Set(scenarios)).toEqual(
      new Set([
        'behead', 'camp', 'ritual', 'waves',
        // волна 2 плана objectives — виртуальные узлы каталога
        'redoubt', 'convoy', 'vigil', 'dawn', 'sabotage',
        'breakout', 'rearguard', 'escort', 'relic', 'chase',
      ]),
    );
  });

  it('задача сценария видна до боя, у обычного узла её нет', () => {
    expect(debugBrief('ritual')).toContain('Ритуалист');
    expect(debugBrief('swarm')).toBeNull();
    expect(() => debugBattleById('нет-такого')).toThrow(/Неизвестный бой/);
  });
});

describe('сборка партии', () => {
  it('ставит заказанных героев с заказанными характерами и открытым словарём', () => {
    const state = debugRun(setup({ party: [{ archetypeId: 'ulv', lenses: ['fanatic', 'hothead'] }] }));
    expect(state.heroes.map((h) => h.id)).toEqual(['ulv']);
    expect(state.heroes[0]!.lenses).toEqual(['fanatic', 'hothead']);
    expect(state.heroes[0]!.stats.maxHp).toBe(heroArchetype('ulv').stats.maxHp);
    expect(state.vocab.length).toBe((Object.keys(CONCEPTS) as ConceptId[]).length);
    expect(currentNode(state).kind).toBe('fight');
  });

  it('свои приказы вместо дефолтных', () => {
    const phrases = [{ condition: { id: 'always' as const }, preference: { id: 'act.standoff' as const } }];
    const state = debugRun(setup({ party: [{ archetypeId: 'lia', lenses: [], phrases }] }));
    expect(state.heroes[0]!.phrases).toEqual(phrases);
  });

  it('отбивает негодную сборку понятной ошибкой', () => {
    expect(() => debugRun(setup({ party: [] }))).toThrow(/от 1 до 3/);
    expect(() => debugRun(setup({ party: Array.from({ length: MAX_DEBUG_PARTY + 1 }, (_, i) => ({ archetypeId: `x${i}`, lenses: [] })) }))).toThrow(/от 1 до 3/);
    expect(() =>
      debugRun(setup({ party: [{ archetypeId: 'grom', lenses: [] }, { archetypeId: 'grom', lenses: [] }] })),
    ).toThrow(/в двух слотах/);
    expect(() => debugRun(setup({ party: [{ archetypeId: 'нетакой', lenses: [] }] }))).toThrow(/архетип/);
    expect(() =>
      debugRun(setup({ party: [{ archetypeId: 'grom', lenses: ['злюка' as never] }] })),
    ).toThrow(/Неизвестная линза/);
    expect(() =>
      debugRun(setup({ vocab: ['act.attack'], party: [{ archetypeId: 'lia', lenses: [], phrases: [{ condition: { id: 'always' }, preference: { id: 'act.standoff' } }] }] })),
    ).toThrow(/Закрытые концепты/);
  });
});

describe('прогон', () => {
  it('детерминизм: тот же setup — побайтово тот же бой', () => {
    expect(log(setup())).toBe(log(setup()));
  });

  it('характер меняет бой, состав — тем более', () => {
    const base = setup({ party: [{ archetypeId: 'grom', lenses: ['plain'] }, { archetypeId: 'dart', lenses: [] }] });
    const scared = setup({ party: [{ archetypeId: 'grom', lenses: ['coward'] }, { archetypeId: 'dart', lenses: [] }] });
    expect(log(base)).not.toBe(log(scared));
    expect(log(base)).not.toBe(log(setup({ ...base, party: [{ archetypeId: 'skala', lenses: ['plain'] }, { archetypeId: 'dart', lenses: [] }] })));
    expect(log(base)).not.toBe(log({ ...base, seed: 4 }));
  });

  it('задача сценария работает: «обезглавить» кончается смертью вожака', () => {
    const r = debugBattle(setup({ battle: 'behead', seed: 11 }));
    expect(r.winner).toBe('party');
    expect(r.units.find((u) => u.id === 'boss')!.alive).toBe(false);
    // свиту не добивали — победа пришла по задаче, а не по «перебей всех»
    expect(r.units.some((u) => u.side === 'foe' && u.alive)).toBe(true);
  });

  it('отладочный бой — тот же бой, что в забеге', () => {
    const state = startRun(7);
    const party = state.heroes.map((h) => ({
      archetypeId: h.archetypeId,
      lenses: h.lenses,
      phrases: h.phrases,
    }));
    const fromRun = JSON.stringify(playFight(state).events);
    expect(log({ battle: 'lesson', party, seed: 7 })).toBe(fromRun);
  });
});
