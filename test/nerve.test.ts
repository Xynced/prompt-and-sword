import { describe, expect, it } from 'vitest';
import { type Fighter, decide, makeCtx } from '../src/scoring.js';
import { applyLens } from '../src/lens.js';
import { nervePressure, nerveRoll } from '../src/nerve.js';
import { compilePhrase } from '../src/constructor.js';
import { type UnitSpec, runBattle } from '../src/battle.js';
import type { Rule } from '../src/ir.js';
import { FOCUS_WEIGHT, NERVE_AMP, NERVE_BLIND, NERVE_CROWD } from '../src/tuning.js';
import { makeFoes, makeIrSets } from '../src/scenarios.js';
import { type ConceptId, STARTING_VOCAB } from '../src/vocab.js';
import type { CombatUnit, LensId, Pos, Side } from '../src/types.js';

/**
 * Режим нерва (план nerve): seeded-разброс весов решения. Проверяем три вещи —
 * выключенный режим ничего не меняет, включённый детерминирован сидом, а
 * разброс растёт с давлением ситуации.
 */

const r = (rule: Omit<Rule, 'scope'>): Rule => ({ ...rule, scope: 'self' });

function fighter(
  id: string,
  side: Side,
  pos: Pos,
  over: Partial<CombatUnit> = {},
  rules: Rule[] = [],
  lenses: LensId[] = ['plain'],
): Fighter {
  return {
    id,
    name: id,
    side,
    maxHp: 40,
    hp: 40,
    atk: 6,
    range: 1,
    speed: 5,
    move: 2,
    pos,
    startPos: { ...pos },
    alive: true,
    guard: 0,
    exposed: false,
    tags: [],
    lenses,
    ...over,
    compiled: applyLens(lenses, rules),
  };
}

const specs = (): UnitSpec[] => {
  const set = makeIrSets()[0]!;
  return [...set.party, ...makeFoes()];
};

describe('нерв: выключен по умолчанию', () => {
  it('бой без режима — тот же лог, что и с nerve: 0', () => {
    const off = runBattle(11, specs());
    const zero = runBattle(11, specs(), undefined, { nerve: 0 });
    expect(JSON.stringify(zero.events)).toBe(JSON.stringify(off.events));
  });

  it('контекст решения без режима не несёт нерва', () => {
    expect(makeCtx().nerve).toBeUndefined();
    expect(makeCtx(undefined, undefined, {}, { amp: 0, seed: 1 }).nerve).toBeUndefined();
  });
});

describe('нерв: детерминизм и влияние', () => {
  it('тот же сид + тот же режим = тот же бой', () => {
    const a = runBattle(11, specs(), undefined, { nerve: NERVE_AMP });
    const b = runBattle(11, specs(), undefined, { nerve: NERVE_AMP });
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it('режим меняет ход боя', () => {
    const off = runBattle(11, specs());
    const on = runBattle(11, specs(), undefined, { nerve: NERVE_AMP });
    expect(JSON.stringify(on.events)).not.toBe(JSON.stringify(off.events));
  });

  it('бросок детерминирован, лежит в [-1, 1] и различает метки', () => {
    const roll = (label: string, round = 1, ap = 3): number => nerveRoll(7, 'гром', round, ap, label);
    expect(roll('правило:бей ближайшего')).toBe(roll('правило:бей ближайшего'));
    const many = [
      roll('угроза'),
      roll('инстинкт:агрессия'),
      roll('угроза', 2),
      roll('угроза', 1, 2),
      nerveRoll(8, 'гром', 1, 3, 'угроза'),
      nerveRoll(7, 'мара', 1, 3, 'угроза'),
    ];
    expect(new Set(many).size).toBe(many.length);
    for (const v of many) expect(Math.abs(v)).toBeLessThanOrEqual(1);
  });
});

describe('нерв: давление ситуации', () => {
  const calm = (): Fighter => fighter('герой', 'party', { x: 4, y: 4 });

  it('целый боец в затишье со сработавшим правилом не нервничает', () => {
    const self = calm();
    const foe = fighter('враг', 'foe', { x: 12, y: 12 });
    expect(nervePressure(self, [self, foe], 1)).toBe(0);
  });

  it('раны, теснота и отсутствие приказа поднимают давление', () => {
    const hurt = fighter('раненый', 'party', { x: 4, y: 4 }, { hp: 10 });
    const far = fighter('враг', 'foe', { x: 12, y: 12 });
    expect(nervePressure(hurt, [hurt, far], 1)).toBeGreaterThan(0);

    const self = calm();
    const a = fighter('в1', 'foe', { x: 5, y: 4 });
    const b = fighter('в2', 'foe', { x: 3, y: 4 });
    expect(nervePressure(self, [self, a, b], 1)).toBeCloseTo(NERVE_CROWD, 5);
    expect(nervePressure(self, [self, far], 0)).toBeCloseTo(NERVE_BLIND, 5);
    // свои в контакте теснотой не считаются
    const ally = fighter('свой', 'party', { x: 5, y: 4 });
    expect(nervePressure(self, [self, ally, far], 1)).toBe(0);
  });

  it('давление не выходит за единицу', () => {
    const self = fighter('загнанный', 'party', { x: 4, y: 4 }, { hp: 1 });
    const foes = [
      fighter('в1', 'foe', { x: 5, y: 4 }),
      fighter('в2', 'foe', { x: 3, y: 4 }),
      fighter('в3', 'foe', { x: 4, y: 5 }),
    ];
    expect(nervePressure(self, [self, ...foes], 0)).toBe(1);
  });

  it('при нулевом давлении решение то же, что без режима', () => {
    const rules = [r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1.5, source: 'бей ближайшего' })];
    const self = fighter('герой', 'party', { x: 4, y: 4 }, {}, rules);
    const foe = fighter('враг', 'foe', { x: 9, y: 9 });
    const units = [self, foe];
    const plain = decide(self, units, 1, undefined, 3, makeCtx());
    const nervy = decide(self, units, 1, undefined, 3, makeCtx(undefined, undefined, {}, { amp: NERVE_AMP, seed: 3 }));
    expect(nervy.chosen).toEqual(plain.chosen);
    expect(nervy.score).toBeCloseTo(plain.score, 9);
  });

  it('под давлением боец иногда решает иначе', () => {
    const order = (): Rule[] => [
      r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1.5, source: 'бей ближайшего' }),
    ];
    // ранен и обступлен: давление предельное, решение перестаёт быть одним и тем же
    const chosen = new Set(
      [...Array(40).keys()].map((seed) => {
        const self = fighter('герой', 'party', { x: 6, y: 6 }, { hp: 8 }, order());
        const a = fighter('в1', 'foe', { x: 7, y: 6 });
        const b = fighter('в2', 'foe', { x: 5, y: 7 });
        const d = decide(self, [self, a, b], 1, undefined, 3, makeCtx(undefined, undefined, {}, { amp: NERVE_AMP, seed }));
        return JSON.stringify(d.chosen);
      }),
    );
    expect(chosen.size).toBeGreaterThan(1);
  });
});

describe('нерв: фокус на приказе', () => {
  it('важность «фокус» поднимает вес и метит правило', () => {
    const draft = {
      condition: { id: 'always' } as const,
      preference: { id: 'act.attack', target: 'sel.nearest' } as const,
    };
    const vocab: ConceptId[] = [...STARTING_VOCAB];
    const focus = compilePhrase({ ...draft, weight: FOCUS_WEIGHT }, vocab);
    const usual = compilePhrase({ ...draft, weight: 2 }, vocab);
    expect(focus.ok && usual.ok).toBe(true);
    if (!focus.ok || !usual.ok) return;
    expect(focus.rule.weight).toBeGreaterThan(usual.rule.weight);
    expect(focus.rule.focus).toBe(true);
    expect(usual.rule.focus).toBeUndefined();
  });

  it('приказ с фокусом держит бойца под давлением', () => {
    // те же вес и приказ — разница только в пометке фокуса
    const order = (focus: boolean): Rule[] => [
      r({
        when: { kind: 'always' },
        then: { kind: 'attack', target: 'nearest' },
        weight: FOCUS_WEIGHT * 1.5,
        source: 'бей ближайшего',
        ...(focus ? { focus: true } : {}),
      }),
    ];
    const line = (focus: boolean): string[] =>
      [...Array(60).keys()].map((seed) => {
        const self = fighter('герой', 'party', { x: 6, y: 6 }, { hp: 8 }, order(focus));
        const a = fighter('в1', 'foe', { x: 7, y: 6 });
        const b = fighter('в2', 'foe', { x: 5, y: 7 });
        const d = decide(self, [self, a, b], 1, undefined, 3, makeCtx(undefined, undefined, {}, { amp: NERVE_AMP, seed }));
        return JSON.stringify(d.chosen);
      });
    const steady = (xs: string[]): number => {
      const counts = new Map<string, number>();
      for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
      return Math.max(...counts.values());
    };
    expect(steady(line(true))).toBeGreaterThan(steady(line(false)));
  });
});
