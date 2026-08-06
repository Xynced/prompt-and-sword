import { describe, expect, it } from 'vitest';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { isFlanking } from '../src/grid.js';
import { wolf } from '../src/foes.js';
import { PARTY_SPAWNS, heroArchetype } from '../src/heroes.js';
import type { Rule } from '../src/ir.js';

/**
 * План защиты: оборона получает собственную валюту.
 * 1. Строй ломает фланги: смежный союзник прикрывает цели спину.
 * 2. Перехват: телохранитель принимает удар, предназначенный подопечному.
 * 3. Рипост: ближний удар по глухой обороне ранит бьющего.
 */

const r = (rule: Omit<Rule, 'scope'>): Rule => ({ ...rule, scope: 'self' });
const atkNearest = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 2, source: 'бей ближайшего' });

function hero(archId: string, slot: number, rules: Rule[]): UnitSpec {
  const a = heroArchetype(archId);
  return {
    id: a.id,
    name: a.name,
    side: 'party',
    lenses: ['plain'],
    rules: [...rules, ...a.innate],
    maxHp: a.stats.maxHp,
    speed: a.stats.speed,
    move: a.stats.move,
    weapons: a.weapons,
    active: a.active,
    passives: a.passives,
    spawn: { ...PARTY_SPAWNS[slot]! },
  };
}

const attacks = (events: readonly BattleEvent[]): Extract<BattleEvent, { t: 'attack' }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: 'attack' }> => e.t === 'attack');

describe('строй ломает фланги', () => {
  const target = { x: 5, y: 5 };
  const attacker = { x: 4, y: 5 };
  const opposite = { x: 6, y: 5 };

  it('гео: смежный союзник цели отменяет фланг, дальний — нет', () => {
    expect(isFlanking(attacker, target, [opposite])).toBe(true);
    expect(isFlanking(attacker, target, [opposite], [{ x: 5, y: 6 }])).toBe(false);
    expect(isFlanking(attacker, target, [opposite], [{ x: 5, y: 7 }])).toBe(true);
  });

  it('в бою: одиночку фланкируют, прикрытого строем — нет', () => {
    // толстые тела: сцена меряет геометрию флангов, а не исход боя — сосед
    // не должен умереть (мёртвый строй фланги не ломает)
    const dummy = (id: string, spawn: { x: number; y: number }, extra: Partial<UnitSpec> = {}): UnitSpec => ({
      id,
      name: id,
      side: 'party',
      maxHp: 600,
      atk: 5,
      range: 1,
      speed: 4,
      move: 0,
      lenses: ['plain'],
      rules: [atkNearest],
      spawn,
      ...extra,
    });
    const foes = (): UnitSpec[] => [
      { ...dummy('w1', { x: 4, y: 8 }), side: 'foe', speed: 7 },
      { ...dummy('w2', { x: 6, y: 8 }), side: 'foe', speed: 7 },
    ];
    // одинокая цель между двумя врагами — фланг есть
    const alone = runBattle(5, [dummy('t', { x: 5, y: 8 }), ...foes()]);
    expect(attacks(alone.events).some((e) => e.target === 't' && e.flank)).toBe(true);
    // та же сцена, но рядом союзник — флангов по цели нет вовсе
    const braced = runBattle(5, [dummy('t', { x: 5, y: 8 }), dummy('ally', { x: 5, y: 7 }), ...foes()]);
    expect(attacks(braced.events).some((e) => e.target === 't' && e.flank)).toBe(false);
  });

  it('смоук: телохранитель против стаи — из ловушки в лучший ответ', () => {
    const wolves = () => Array.from({ length: 4 }, (_, i) => wolf(i + 1));
    const naive = () => [
      hero('grom', 0, [atkNearest]),
      hero('lia', 1, [atkNearest]),
      hero('zhalo', 2, [atkNearest]),
    ];
    const guard = () => [
      hero('grom', 0, [atkNearest, r({ when: { kind: 'always' }, then: { kind: 'protect', ally: 'lia' }, weight: 1.5, source: 'прикрывай Лию' })]),
      hero('lia', 1, [atkNearest, r({ when: { kind: 'always' }, then: { kind: 'behind', ref: { type: 'ally', id: 'grom' } }, weight: 1.5, source: 'держись за Громом' })]),
      hero('zhalo', 2, [atkNearest]),
    ];
    let hpNaive = 0;
    let hpGuard = 0;
    let flanksNaive = 0;
    let flanksGuard = 0;
    for (let s = 1; s <= 20; s++) {
      const seed = s * 17 + 3;
      const n = runBattle(seed, [...naive(), ...wolves()], 'late');
      const g = runBattle(seed, [...guard(), ...wolves()], 'late');
      const frac = (res: typeof n): number => {
        const pu = res.units.filter((u) => u.side === 'party');
        return pu.reduce((a, u) => a + (u.alive ? u.hp : 0), 0) / pu.reduce((a, u) => a + u.maxHp, 0);
      };
      hpNaive += frac(n);
      hpGuard += frac(g);
      flanksNaive += attacks(n.events).filter((e) => e.unit.startsWith('wolf') && e.flank).length;
      flanksGuard += attacks(g.events).filter((e) => e.unit.startsWith('wolf') && e.flank).length;
    }
    expect(hpGuard).toBeGreaterThan(hpNaive); // строй бережёт, а не топит
    expect(flanksGuard).toBeLessThan(flanksNaive); // потому что спины прикрыты
  });
});
