import { describe, expect, it } from 'vitest';
import { type Rule, evalCondition } from '../src/ir.js';
import { applyLens } from '../src/lens.js';
import { type UnitSpec, runBattle } from '../src/battle.js';
import type { CombatUnit, Pos } from '../src/types.js';

/** Условия-триггеры и эмоциональный дрейф (план линз, шаги 6–7). */

function unit(id: string, side: 'party' | 'foe', pos: Pos, over: Partial<CombatUnit> = {}): CombatUnit {
  return {
    id,
    name: id,
    side,
    maxHp: 30,
    hp: 30,
    atk: 5,
    range: 1,
    speed: 5,
    move: 2,
    pos,
    startPos: { ...pos },
    alive: true,
    coverLevel: 0,
    exposed: false,
    tags: [],
    lenses: ['plain'],
    ...over,
  };
}

const attack = (w = 2): Rule => ({
  when: { kind: 'always' },
  then: { kind: 'attack', target: 'nearest' },
  weight: w,
  scope: 'self',
  source: 'бей ближайшего',
});

describe('условия-триггеры плана линз', () => {
  it('firstBlood: истинно, как только у кого-то не полное hp или кто-то пал', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const foe = unit('e', 'foe', { x: 5, y: 5 });
    expect(evalCondition({ kind: 'firstBlood' }, self, [self, foe])).toBe(false);
    foe.hp = 29;
    expect(evalCondition({ kind: 'firstBlood' }, self, [self, foe])).toBe(true);
    foe.hp = 30;
    foe.alive = false;
    expect(evalCondition({ kind: 'firstBlood' }, self, [self, foe])).toBe(true);
  });

  it('leaderDown: истинно, когда пал вожак противника, а не свой', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const boss = unit('b', 'foe', { x: 5, y: 5 }, { tags: ['leader'] });
    const ownLeader = unit('l', 'party', { x: 1, y: 0 }, { tags: ['leader'], alive: false });
    expect(evalCondition({ kind: 'leaderDown' }, self, [self, boss, ownLeader])).toBe(false);
    boss.alive = false;
    expect(evalCondition({ kind: 'leaderDown' }, self, [self, boss])).toBe(true);
  });

  it('wasHit: истинно после первого полученного удара', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    expect(evalCondition({ kind: 'wasHit' }, self, [self])).toBe(false);
    self.lastAttackerId = 'e';
    expect(evalCondition({ kind: 'wasHit' }, self, [self])).toBe(true);
  });

  it('hpAbove — точный комплемент hpBelow: активна ровно одна половина', () => {
    const self = unit('a', 'party', { x: 0, y: 0 }, { hp: 15, maxHp: 30 });
    expect(evalCondition({ kind: 'hpAbove', who: 'self', frac: 0.5 }, self, [self])).toBe(true);
    expect(evalCondition({ kind: 'hpBelow', who: 'self', frac: 0.5 }, self, [self])).toBe(false);
    self.hp = 14;
    expect(evalCondition({ kind: 'hpAbove', who: 'self', frac: 0.5 }, self, [self])).toBe(false);
    expect(evalCondition({ kind: 'hpBelow', who: 'self', frac: 0.5 }, self, [self])).toBe(true);
  });
});

describe('дрейф: компиляция', () => {
  it('дрейф есть у мстителя, труса, горячки, славолюба; стабильные без него', () => {
    expect(applyLens(['avenger'], [attack()]).drift?.trigger).toEqual({ kind: 'allyFallen' });
    expect(applyLens(['coward'], [attack()]).drift?.trigger).toEqual({
      kind: 'hpBelow',
      who: 'self',
      frac: 0.3,
    });
    expect(applyLens(['hothead'], [attack()]).drift?.trigger).toEqual({ kind: 'firstBlood' });
    expect(applyLens(['gloryhound'], [attack()]).drift?.trigger).toEqual({ kind: 'leaderDown' });
    for (const lens of ['plain', 'fanatic', 'literalist', 'duelist', 'guardian', 'paranoid', 'showman'] as const) {
      expect(applyLens([lens], [attack()]).drift).toBeUndefined();
    }
  });

  it('дрейф — у первой линзы с дрейфом по порядку', () => {
    expect(applyLens(['avenger', 'coward'], [attack()]).drift?.lens).toBe('avenger');
    expect(applyLens(['coward', 'avenger'], [attack()]).drift?.lens).toBe('coward');
    expect(applyLens(['fanatic', 'hothead'], [attack()]).drift?.lens).toBe('hothead');
  });

  it('режим мстителя перенацеливает атаки на обидчика', () => {
    const drift = applyLens(['avenger'], [attack()]).drift!;
    const atk = drift.rules.find((r) => r.then.kind === 'attack')!;
    expect(atk.then).toEqual({ kind: 'attack', target: 'attacker' });
    expect(drift.instincts.aggression).toBeGreaterThan(applyLens(['avenger'], []).instincts.aggression);
  });

  it('режим паники труса: бегство становится безусловным', () => {
    const drift = applyLens(['coward'], [attack()]).drift!;
    const flee = drift.rules.find((r) => r.then.kind === 'retreat')!;
    expect(flee.when).toEqual({ kind: 'always' });
  });
});

describe('дрейф: защёлка в бою', () => {
  const spec = (id: string, side: 'party' | 'foe', over: Partial<UnitSpec>): UnitSpec => ({
    id,
    name: id,
    side,
    maxHp: 60,
    atk: 6,
    range: 1,
    speed: 4,
    move: 2,
    lenses: ['plain'],
    rules: [attack()],
    spawn: { x: 4, y: 4 },
    ...over,
  });

  it('мститель сдвигается после смерти союзника — moodShift ровно один раз', () => {
    const specs: UnitSpec[] = [
      spec('avenger', 'party', { lenses: ['avenger'], spawn: { x: 3, y: 4 }, maxHp: 120 }),
      spec('frail', 'party', { maxHp: 8, spawn: { x: 5, y: 5 }, speed: 1 }),
      spec('foe1', 'foe', { spawn: { x: 6, y: 5 }, atk: 9, maxHp: 120, speed: 7 }),
    ];
    const res = runBattle(3, specs);
    const shifts = res.events.filter((e) => e.t === 'moodShift');
    const frailDies = res.events.some((e) => e.t === 'die' && e.unit === 'frail');
    expect(frailDies).toBe(true);
    expect(shifts).toEqual([{ t: 'moodShift', unit: 'avenger', lens: 'avenger' }]);
  });

  it('дрейф детерминирован: два прогона бит-в-бит', () => {
    const specs = (): UnitSpec[] => [
      spec('avenger', 'party', { lenses: ['avenger'], spawn: { x: 3, y: 4 } }),
      spec('frail', 'party', { maxHp: 8, spawn: { x: 5, y: 5 }, speed: 1 }),
      spec('foe1', 'foe', { spawn: { x: 6, y: 5 }, atk: 9, maxHp: 120, speed: 7 }),
    ];
    const a = runBattle(3, specs());
    const b = runBattle(3, specs());
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it('у юнитов без дрейфа события moodShift нет', () => {
    const specs: UnitSpec[] = [
      spec('grom', 'party', { lenses: ['fanatic'], spawn: { x: 3, y: 4 } }),
      spec('foe1', 'foe', { spawn: { x: 6, y: 5 } }),
    ];
    const res = runBattle(3, specs);
    expect(res.events.some((e) => e.t === 'moodShift')).toBe(false);
  });
});
