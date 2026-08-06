import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import {
  AOE_BLAST_RADIUS,
  type Fighter,
  aoeDamage,
  aoeVictims,
  castVictims,
  decide,
  generateCandidates,
  isAttack,
  lineCells,
  makeCtx,
} from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { dist, posKey } from '../src/grid.js';
import { shaman } from '../src/foes.js';
import { expectedDamage } from '../src/tuning.js';
import type { AoeSpec, CombatUnit, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Залп (план АОЕ, шаг 1): мгновенный взрыв 3×3 вокруг центра в дальности
 * каста, 2 AP. Урон фиксированный (без rng), friendly fire включён — бьёт
 * всех в зоне. Оружие — spec.aoe (носителей единицы), гейт — правило
 * «накрыть скопление»: без него кандидатов нет. Окупается от двух накрытых,
 * по одному бьют обычной атакой.
 */

const BLAST: AoeSpec = { blast: { range: 4, mult: 0.75 } };

function fighter(id: string, side: Side, pos: Pos, over: Partial<CombatUnit> = {}, rules: Rule[] = []): Fighter {
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
    coverLevel: 0,
    exposed: false,
    tags: [],
    lenses: ['plain'],
    ...over,
    compiled: applyLens(['plain'], rules),
  };
}

const rule = (then: Rule['then'], weight = 2): Rule => ({
  when: { kind: 'always' },
  then,
  weight,
  scope: 'self',
  source: 'тест',
});

const blockedBy = (tiles: Pos[]) => {
  const set = new Set(tiles.map(posKey));
  return (p: Pos): boolean => set.has(posKey(p));
};

const castsIn = (events: readonly BattleEvent[]): Extract<BattleEvent, { t: 'aoeCast' }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: 'aoeCast' }> => e.t === 'aoeCast');

const hitsIn = (events: readonly BattleEvent[]): Extract<BattleEvent, { t: 'aoeHit' }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: 'aoeHit' }> => e.t === 'aoeHit');

describe('кандидаты залпа', () => {
  const barrage = [rule({ kind: 'barrage' })];

  it('с оружием и правилом — центры только вокруг врага, в дальности каста', () => {
    const self = fighter('s', 'party', { x: 5, y: 5 }, { aoe: BLAST }, barrage);
    const enemy = fighter('e', 'foe', { x: 8, y: 5 });
    const blasts = generateCandidates(self, [self, enemy]).filter((c) => c.action === 'aoeBlast');
    expect(blasts.length).toBe(9); // все 3×3 вокруг цели в пределах дальности 4
    for (const c of blasts) {
      expect(dist(c.at!, enemy.pos)).toBeLessThanOrEqual(AOE_BLAST_RADIUS);
      expect(dist(self.pos, c.at!)).toBeLessThanOrEqual(BLAST.blast!.range);
    }
    // враг дальше дальности — кандидатов нет
    const far = fighter('f', 'foe', { x: 12, y: 5 });
    expect(generateCandidates(self, [self, far]).some((c) => c.action === 'aoeBlast')).toBe(false);
  });

  it('без правила «накрыть скопление» и без оружия кандидатов нет', () => {
    const noWord = fighter('s', 'party', { x: 5, y: 5 }, { aoe: BLAST }, [rule({ kind: 'attack', target: 'nearest' })]);
    const enemy = fighter('e', 'foe', { x: 8, y: 5 });
    expect(generateCandidates(noWord, [noWord, enemy]).some((c) => c.action === 'aoeBlast')).toBe(false);

    const noWeapon = fighter('s2', 'party', { x: 5, y: 5 }, {}, [rule({ kind: 'barrage' })]);
    expect(generateCandidates(noWeapon, [noWeapon, enemy]).some((c) => c.action === 'aoeBlast')).toBe(false);
  });

  it('за камнем (нет LoS до центра) залпа нет — каменоломня остаётся контром', () => {
    const self = fighter('s', 'party', { x: 5, y: 5 }, { aoe: BLAST }, barrage);
    const enemy = fighter('e', 'foe', { x: 9, y: 5 });
    const wall = blockedBy([3, 4, 5, 6, 7].map((y) => ({ x: 7, y })));
    const cands = generateCandidates(self, [self, enemy], makeCtx(wall));
    expect(cands.some((c) => c.action === 'aoeBlast')).toBe(false);
  });
});

describe('выбор: залп против атаки', () => {
  const bothRules = [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'barrage' })];

  it('скопление — залп; одиночная цель — обычная атака', () => {
    const self = fighter('s', 'party', { x: 5, y: 5 }, { atk: 6, range: 4, aoe: BLAST }, bothRules);
    const cluster = [
      fighter('e1', 'foe', { x: 8, y: 5 }),
      fighter('e2', 'foe', { x: 9, y: 5 }),
      fighter('e3', 'foe', { x: 8, y: 6 }),
    ];
    const packed = decide(self, [self, ...cluster]);
    expect(packed.chosen.action).toBe('aoeBlast');

    const single = decide(self, [self, fighter('e', 'foe', { x: 8, y: 5 })]);
    expect(isAttack(single.chosen.action)).toBe(true);
  });

  it('центр выбирается так, чтобы не накрыть своих (friendly fire в минус)', () => {
    const self = fighter('s', 'party', { x: 5, y: 5 }, { atk: 6, aoe: BLAST }, [rule({ kind: 'barrage' })]);
    const e1 = fighter('e1', 'foe', { x: 8, y: 8 });
    const e2 = fighter('e2', 'foe', { x: 9, y: 8 });
    const ally = fighter('a', 'party', { x: 8, y: 9 }, { move: 0 });
    const d = decide(self, [self, e1, e2, ally]);
    expect(d.chosen.action).toBe('aoeBlast');
    // оба врага накрываются из y ∈ {7, 8, 9}, но только ряд y=7 не задевает союзника
    expect(d.chosen.at!.y).toBe(7);
  });
});

describe('урон залпа', () => {
  it('фиксированный, прикрытие и открытость работают, минимум 1', () => {
    const caster = fighter('c', 'foe', { x: 0, y: 0 }, { atk: 6 });
    const base = Math.round(expectedDamage(6) * 0.75); // 2.7 → 3
    const clean = fighter('t', 'party', { x: 1, y: 1 });
    expect(aoeDamage(caster, 0.75, clean)).toBe(base);
    const covered = fighter('t2', 'party', { x: 1, y: 1 }, { coverLevel: 0.25 });
    expect(aoeDamage(caster, 0.75, covered)).toBe(Math.round(2.7 * 0.75));
    const exposed = fighter('t3', 'party', { x: 1, y: 1 }, { exposed: true });
    expect(aoeDamage(caster, 0.75, exposed)).toBe(Math.round(2.7 * 1.35));
    const weak = fighter('c2', 'foe', { x: 0, y: 0 }, { atk: 1 });
    expect(aoeDamage(weak, 0.75, clean)).toBe(1);
  });

  it('зона бьёт обе стороны — friendly fire включён', () => {
    const center = { x: 5, y: 5 };
    const units = [
      fighter('foe1', 'foe', { x: 5, y: 5 }),
      fighter('ally', 'party', { x: 6, y: 6 }),
      fighter('out', 'party', { x: 7, y: 7 }),
      fighter('dead', 'foe', { x: 5, y: 6 }, { alive: false }),
    ];
    expect(aoeVictims(center, units).map((u) => u.id)).toEqual(['foe1', 'ally']);
  });
});

describe('залп в бою (гать, сид 4)', () => {
  const dummy = (id: string, side: Side, spawn: Pos, hp: number): UnitSpec => ({
    id, name: id, side, maxHp: hp, atk: 1, range: 1, speed: 1, move: 0,
    lenses: ['plain'], rules: [], spawn,
  });

  it('шаман накрывает пару манекенов: фиксированный урон обоим, добивает', () => {
    const specs = [
      dummy('d1', 'party', { x: 8, y: 5 }, 6),
      dummy('d2', 'party', { x: 9, y: 5 }, 6),
      // ритуал отрезан: здесь проверяется именно залп (ритуал — ritual.test.ts)
      { ...shaman('nobody'), aoe: { blast: { range: 4, mult: 0.75 } }, spawn: { x: 8, y: 8 } },
    ];
    const r = runBattle(4, specs);
    expect(r.terrain.name).toBe('гать');
    const casts = castsIn(r.events);
    expect(casts.length).toBeGreaterThan(0);
    expect(casts[0]!.form).toBe('blast');
    // первый залп — до первого хода манекенов: прикрытий ещё нет,
    // урон обоим ровно по формуле, одно число в логе у всех накрытых
    const firstTwo = hitsIn(r.events).slice(0, 2);
    expect(firstTwo.map((h) => h.unit).sort()).toEqual(['d1', 'd2']);
    const expected = Math.round(expectedDamage(4) * 0.75); // 1.8 → 2
    for (const h of firstTwo) {
      expect(h.by).toBe('shaman');
      expect(h.dmg).toBe(expected);
    }
    expect(r.winner).toBe('foe');
  });

  it('когда чистого центра нет — накрывает вместе со своим: союзник кастера получает урон', () => {
    const specs = [
      {
        ...dummy('c', 'party', { x: 5, y: 8 }, 40),
        atk: 6, range: 4, speed: 9, move: 2,
        aoe: BLAST,
        rules: [rule({ kind: 'barrage' })],
      },
      dummy('mate', 'party', { x: 9, y: 8 }, 20),
      dummy('f1', 'foe', { x: 8, y: 8 }, 4),
      dummy('f2', 'foe', { x: 10, y: 8 }, 4),
    ];
    const r = runBattle(4, specs);
    // оба врага накрываются только центрами x=9 — все они задевают союзника
    const mateHits = hitsIn(r.events).filter((h) => h.unit === 'mate');
    expect(mateHits.length).toBeGreaterThan(0);
    expect(mateHits[0]!.by).toBe('c');
    expect(r.winner).toBe('party');
  });

  it('волна клинка в бою: полоса бьёт колонну, камень обрывает взмах', () => {
    // спеллблейд с копьём и колонна врагов по прямой
    const specs = [
      {
        ...dummy('c', 'party', { x: 6, y: 8 }, 60),
        atk: 6, range: 2, speed: 9, move: 2,
        aoe: { line: { len: 4, mult: 0.75 } },
        rules: [rule({ kind: 'barrage' })],
      },
      dummy('f1', 'foe', { x: 7, y: 8 }, 30),
      dummy('f2', 'foe', { x: 8, y: 8 }, 30),
      dummy('f3', 'foe', { x: 9, y: 8 }, 30),
    ];
    const r = runBattle(4, specs);
    const lines = castsIn(r.events).filter((c) => c.form === 'line');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]!.at).toEqual({ x: 7, y: 8 }); // направление — вдоль колонны
    const firstHits = hitsIn(r.events).slice(0, 3).map((h) => h.unit).sort();
    expect(firstHits).toEqual(['f1', 'f2', 'f3']);
  });

  it('lineCells: камень и край поля обрывают полосу', () => {
    const blocked = (p: Pos): boolean => p.x === 7 && p.y === 8;
    expect(lineCells({ x: 5, y: 8 }, { x: 1, y: 0 }, 4, blocked)).toEqual([{ x: 6, y: 8 }]);
    expect(lineCells({ x: 16, y: 8 }, { x: 1, y: 0 }, 4, () => false)).toEqual([{ x: 17, y: 8 }]);
    // жертвы линии: только на клетках взмаха
    const self = fighter('s', 'party', { x: 5, y: 8 }, { aoe: { line: { len: 4, mult: 0.75 } } });
    const on = fighter('e1', 'foe', { x: 8, y: 8 });
    const off = fighter('e2', 'foe', { x: 8, y: 9 });
    const ids = castVictims('aoeLine', { x: 6, y: 8 }, self, [self, on, off], () => false).map((u) => u.id);
    expect(ids).toEqual(['e1']);
  });

  it('без правила «накрыть скопление» залпов в логе нет — даже с оружием', () => {
    const specs = [
      {
        ...dummy('c', 'party', { x: 5, y: 8 }, 40),
        atk: 6, range: 4, speed: 9, move: 2,
        aoe: BLAST,
        rules: [rule({ kind: 'attack', target: 'nearest' })],
      },
      dummy('f1', 'foe', { x: 8, y: 8 }, 4),
      dummy('f2', 'foe', { x: 9, y: 8 }, 4),
    ];
    const r = runBattle(4, specs);
    expect(castsIn(r.events).length).toBe(0);
  });
});
