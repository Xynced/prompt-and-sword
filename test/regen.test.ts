import { describe, expect, it } from 'vitest';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { describePassives } from '../src/cards.js';
import type { Rule } from '../src/ir.js';

/** Пассив regen (план врагов): юнит зарастает в начале своего хода. */

const attackNearest: Rule = {
  when: { kind: 'always' },
  then: { kind: 'attack', target: 'nearest' },
  weight: 1.5,
  scope: 'self',
  source: 'тест: рубить ближайшего',
};

const troll = (over: Partial<UnitSpec> = {}): UnitSpec => ({
  id: 'troll',
  name: 'Тролль',
  side: 'foe',
  maxHp: 88,
  atk: 8,
  range: 1,
  speed: 4,
  move: 2,
  lenses: ['plain'],
  rules: [attackNearest],
  passives: { regen: { amount: 6 } },
  spawn: { x: 15, y: 8 },
  ...over,
});

const dummy = (over: Partial<UnitSpec> = {}): UnitSpec => ({
  id: 'dummy',
  name: 'Чучело',
  side: 'party',
  maxHp: 60,
  atk: 1,
  range: 1,
  speed: 5,
  move: 0,
  lenses: ['plain'],
  rules: [attackNearest],
  spawn: { x: 2, y: 8 },
  ...over,
});

const regens = (events: readonly BattleEvent[]): Extract<BattleEvent, { t: 'regen' }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: 'regen' }> => e.t === 'regen');

describe('регенерация (пассив regen)', () => {
  it('раненый зарастает на amount в начале своего хода', () => {
    const r = runBattle(1, [troll({ hp: 50 }), dummy()]);
    const first = regens(r.events)[0]!;
    expect(first.unit).toBe('troll');
    expect(first.amount).toBe(6);
    expect(first.hp).toBe(56);
  });

  it('зарастание не поднимает hp выше максимума', () => {
    const r = runBattle(1, [troll({ hp: 85 }), dummy()]);
    const first = regens(r.events)[0]!;
    expect(first.amount).toBe(3);
    expect(first.hp).toBe(88);
    for (const e of regens(r.events)) expect(e.hp).toBeLessThanOrEqual(88);
  });

  it('на полном hp события нет — пассив молчит, пока не ранят', () => {
    // оба без шага и вне досягаемости: боя нет, ран нет — и зарастания нет
    const r = runBattle(1, [troll({ move: 0 }), dummy()]);
    expect(regens(r.events)).toEqual([]);
  });

  it('без пассива зарастания нет', () => {
    const r = runBattle(1, [troll({ hp: 50, passives: {} }), dummy()]);
    expect(regens(r.events)).toEqual([]);
  });

  it('пассив виден в карточке и разведке', () => {
    // разведка называет и контр-тактику: огонь с кислотой гасят реген (волна 6 damage-types)
    expect(describePassives({ regen: { amount: 6 } })).toBe('зарастает +6 в ход (огонь и кислота не дают)');
  });
});
