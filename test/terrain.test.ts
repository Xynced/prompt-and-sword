import { describe, expect, it } from 'vitest';
import { TERRAIN_LAYOUTS, pickTerrain } from '../src/terrain.js';
import { distanceField, dist, posEq, posKey } from '../src/grid.js';
import { applyLens } from '../src/lens.js';
import { type Fighter, decide, generateCandidates, makeCtx } from '../src/scoring.js';
import { type UnitSpec, runBattle } from '../src/battle.js';
import type { CombatUnit, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

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

const attackRule = (target: 'nearest' = 'nearest'): Rule => ({
  when: { kind: 'always' },
  then: { kind: 'attack', target },
  weight: 2,
  scope: 'self',
  source: 'тест',
});

const blockedBy = (tiles: Pos[]) => {
  const set = new Set(tiles.map(posKey));
  return (p: Pos): boolean => set.has(posKey(p));
};

describe('схемы террейна', () => {
  it('не занимают зоны спавна (колонки x ≤ 2 и x ≥ 9)', () => {
    for (const layout of TERRAIN_LAYOUTS) {
      for (const t of layout.tiles) {
        expect(t.x, `${layout.name}: (${t.x},${t.y})`).toBeGreaterThan(2);
        expect(t.x, `${layout.name}: (${t.x},${t.y})`).toBeLessThan(9);
      }
    }
  });

  it('pickTerrain детерминирован и покрывает все схемы', () => {
    expect(pickTerrain(7)).toBe(pickTerrain(7));
    const names = new Set([1, 2, 3, 4].map((s) => pickTerrain(s).name));
    expect(names.size).toBe(TERRAIN_LAYOUTS.length);
  });
});

describe('террейн в бою', () => {
  it('камни не входят в достижимые клетки кандидатов', () => {
    const self = fighter('a', 'party', { x: 4, y: 4 });
    const rock = { x: 5, y: 4 };
    const cands = generateCandidates(self, [self], blockedBy([rock]));
    expect(cands.some((c) => posEq(c.to, rock))).toBe(false);
  });

  it('камень режет линию видимости стрелка', () => {
    const shooter = fighter('a', 'party', { x: 3, y: 4 }, { range: 4, move: 0 });
    const target = fighter('e', 'foe', { x: 7, y: 4 });
    const rock = { x: 5, y: 4 };
    const open = generateCandidates(shooter, [shooter, target]);
    expect(open.some((c) => c.action === 'attack')).toBe(true);
    const walled = generateCandidates(shooter, [shooter, target], blockedBy([rock]));
    expect(walled.some((c) => c.action === 'attack')).toBe(false);
  });

  it('distanceField обходит стену: путь длиннее прямой', () => {
    const wall = [{ x: 6, y: 3 }, { x: 6, y: 4 }, { x: 6, y: 5 }];
    const target = { x: 7, y: 4 };
    const field = distanceField(target, blockedBy(wall));
    const before = { x: 5, y: 4 };
    expect(dist(before, target)).toBe(2);
    expect(field.get(posKey(before))!).toBeGreaterThan(2);
    expect(field.has(posKey(wall[1]!))).toBe(false);
  });

  it('тяга к цели ведёт в обход стены, а не в залипание', () => {
    // стена x=6 (y 2..6), проход снизу; цель за стеной
    const wall = [2, 3, 4, 5, 6].map((y) => ({ x: 6, y }));
    const blocked = blockedBy(wall);
    const self = fighter('a', 'party', { x: 5, y: 4 }, {}, [attackRule()]);
    const enemy = fighter('e', 'foe', { x: 7, y: 4 }, { move: 0 });
    const d = decide(self, [self, enemy], 1, blocked);
    // выбранная клетка ближе к цели по путевой дистанции, чем стартовая
    const ctx = makeCtx(blocked);
    expect(ctx.distTo(enemy.pos, d.chosen.to)).toBeLessThan(ctx.distTo(enemy.pos, self.pos));
  });

  it('камень на точке спавна уступает место юниту', () => {
    // сид подбирается так, чтобы выпала схема с камнем, и спавним юнита прямо на него
    const seed = [1, 2, 3, 4].find((s) => pickTerrain(s).tiles.length > 0)!;
    const rock = pickTerrain(seed).tiles[0]!;
    const specs: UnitSpec[] = [
      { id: 'a', name: 'a', side: 'party', maxHp: 20, atk: 5, range: 1, speed: 5, move: 3, lenses: ['plain'], rules: [attackRule()], spawn: rock },
      { id: 'e', name: 'e', side: 'foe', maxHp: 20, atk: 5, range: 1, speed: 4, move: 3, lenses: ['plain'], rules: [attackRule()], spawn: { x: 9, y: 9 } },
    ];
    const r = runBattle(seed, specs);
    expect(r.terrain.tiles.some((t) => posEq(t, rock))).toBe(false);
  });

  it('бой с террейном детерминирован: тот же сид — тот же лог и та же схема', () => {
    const specs: UnitSpec[] = [
      { id: 'a', name: 'a', side: 'party', maxHp: 30, atk: 5, range: 1, speed: 5, move: 3, lenses: ['plain'], rules: [attackRule()], spawn: { x: 2, y: 5 } },
      { id: 'e', name: 'e', side: 'foe', maxHp: 30, atk: 5, range: 1, speed: 4, move: 3, lenses: ['plain'], rules: [attackRule()] },
    ];
    const a = runBattle(3, specs);
    const b = runBattle(3, specs);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.terrain).toEqual(b.terrain);
    expect(a.terrain.name).toBe(pickTerrain(3).name);
  });
});
