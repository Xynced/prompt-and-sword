import { describe, expect, it } from 'vitest';
import { evalCondition, resolveSelector } from '../src/ir.js';
import type { CombatUnit, Pos } from '../src/types.js';

function unit(id: string, side: 'party' | 'foe', pos: Pos, over: Partial<CombatUnit> = {}): CombatUnit {
  return {
    id,
    name: id,
    side,
    maxHp: 20,
    hp: 20,
    atk: 5,
    range: 1,
    speed: 5,
    move: 3,
    pos,
    startPos: { ...pos },
    alive: true,
    defending: false,
    tags: [],
    lenses: ['plain'],
    ...over,
  };
}

describe('evalCondition', () => {
  it('hpBelow self', () => {
    const self = unit('a', 'party', { x: 0, y: 0 }, { hp: 5 });
    expect(evalCondition({ kind: 'hpBelow', who: 'self', frac: 0.3 }, self, [self])).toBe(true);
    expect(evalCondition({ kind: 'hpBelow', who: 'self', frac: 0.2 }, self, [self])).toBe(false);
  });

  it('hpBelow ally — по id, мёртвый союзник = false', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const ally = unit('b', 'party', { x: 1, y: 0 }, { hp: 4 });
    const units = [self, ally];
    expect(evalCondition({ kind: 'hpBelow', who: { ally: 'b' }, frac: 0.5 }, self, units)).toBe(true);
    ally.alive = false;
    expect(evalCondition({ kind: 'hpBelow', who: { ally: 'b' }, frac: 0.5 }, self, units)).toBe(false);
  });

  it('outnumbered: врагов строго больше, чем нас (вместе со мной)', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const e1 = unit('e1', 'foe', { x: 5, y: 5 });
    const e2 = unit('e2', 'foe', { x: 6, y: 5 });
    expect(evalCondition({ kind: 'outnumbered' }, self, [self, e1, e2])).toBe(true);
    expect(evalCondition({ kind: 'outnumbered' }, self, [self, e1])).toBe(false);
  });

  it('allyInDanger: низкий hp ИЛИ ≥2 смежных врагов', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const ally = unit('b', 'party', { x: 4, y: 4 });
    const e1 = unit('e1', 'foe', { x: 3, y: 4 });
    const e2 = unit('e2', 'foe', { x: 5, y: 4 });
    expect(evalCondition({ kind: 'allyInDanger', ally: 'b' }, self, [self, ally, e1, e2])).toBe(true);
    expect(evalCondition({ kind: 'allyInDanger', ally: 'b' }, self, [self, ally, e1])).toBe(false);
    ally.hp = 5;
    expect(evalCondition({ kind: 'allyInDanger', ally: 'b' }, self, [self, ally, e1])).toBe(true);
  });
});

describe('resolveSelector', () => {
  const self = unit('a', 'party', { x: 0, y: 0 });

  it('nearest — минимальная дистанция, тайбрейк по id', () => {
    const e1 = unit('e1', 'foe', { x: 3, y: 0 });
    const e2 = unit('e2', 'foe', { x: 0, y: 3 });
    const e3 = unit('e3', 'foe', { x: 5, y: 5 });
    expect(resolveSelector('nearest', self, [self, e3, e2, e1])?.id).toBe('e1');
  });

  it('weakest — минимальный hp', () => {
    const e1 = unit('e1', 'foe', { x: 3, y: 0 }, { hp: 10 });
    const e2 = unit('e2', 'foe', { x: 4, y: 0 }, { hp: 3 });
    expect(resolveSelector('weakest', self, [self, e1, e2])?.id).toBe('e2');
  });

  it('leader — по тегу, fallback на ближайшего', () => {
    const e1 = unit('e1', 'foe', { x: 3, y: 0 });
    const boss = unit('boss', 'foe', { x: 7, y: 7 }, { tags: ['leader'] });
    expect(resolveSelector('leader', self, [self, e1, boss])?.id).toBe('boss');
    boss.alive = false;
    expect(resolveSelector('leader', self, [self, e1, boss])?.id).toBe('e1');
  });

  it('мёртвые враги не выбираются, при отсутствии врагов — undefined', () => {
    const e1 = unit('e1', 'foe', { x: 3, y: 0 }, { alive: false });
    expect(resolveSelector('nearest', self, [self, e1])).toBeUndefined();
  });
});
