import { describe, expect, it } from 'vitest';
import {
  ARENA_H,
  ARENA_W,
  type ArenaTag,
  FOE_ZONE_MIN_X,
  PARTY_ZONE_MAX_X,
  TERRAIN_LAYOUTS,
  pickTerrain,
  tileAt,
} from '../src/terrain.js';
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
    guard: 0,
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

const TAGS: ArenaTag[] = ['early', 'late', 'elite', 'boss'];

describe('схемы арен', () => {
  it('двенадцать схем, все 18×18', () => {
    expect(TERRAIN_LAYOUTS.length).toBe(12);
    for (const layout of TERRAIN_LAYOUTS) {
      expect(layout.tiles.length, layout.name).toBe(ARENA_H);
      for (const row of layout.tiles) expect(row.length, layout.name).toBe(ARENA_W);
      expect(layout.scenario.length, layout.name).toBeGreaterThan(0);
    }
  });

  it('зоны развёртывания (x ≤ 2 и x ≥ 15) свободны от камней и опасности', () => {
    for (const layout of TERRAIN_LAYOUTS) {
      layout.tiles.forEach((row, y) =>
        row.forEach((t, x) => {
          if (x > PARTY_ZONE_MAX_X && x < FOE_ZONE_MIN_X) return;
          expect(t.blocked, `${layout.name}: камень в зоне (${x},${y})`).toBeFalsy();
          expect(t.hazard, `${layout.name}: опасность в зоне (${x},${y})`).toBeUndefined();
        }),
      );
    }
  });

  it('ранний пул — без высоты и без опасных клеток', () => {
    for (const layout of TERRAIN_LAYOUTS.filter((l) => l.tags.includes('early'))) {
      for (const row of layout.tiles) {
        for (const t of row) {
          expect(t.height ?? 0, layout.name).toBe(0);
          expect(t.hazard, layout.name).toBeUndefined();
        }
      }
    }
  });

  it('поле связно: из зоны партии достижима вся свободная площадь', () => {
    for (const layout of TERRAIN_LAYOUTS) {
      const blocked = (p: Pos): boolean => tileAt(layout.tiles, p).blocked === true;
      const field = distanceField({ x: 1, y: 8 }, blocked);
      let free = 0;
      layout.tiles.forEach((row) => row.forEach((t) => { if (!t.blocked) free++; }));
      expect(field.size, `${layout.name}: есть глухие мешки`).toBe(free);
    }
  });

  it('каждый тег даёт непустой пул; pickTerrain детерминирован и перебирает пул', () => {
    for (const tag of TAGS) {
      const pool = TERRAIN_LAYOUTS.filter((l) => l.tags.includes(tag));
      expect(pool.length, tag).toBeGreaterThan(0);
      expect(pickTerrain(7, tag)).toBe(pickTerrain(7, tag));
      const names = new Set(Array.from({ length: pool.length }, (_, s) => pickTerrain(s, tag).name));
      expect(names.size, tag).toBe(pool.length);
    }
  });

  it('пул элиты и босса — свой: ранние схемы туда не попадают', () => {
    for (const layout of TERRAIN_LAYOUTS) {
      if (layout.tags.includes('boss')) expect(layout.tags).toEqual(['boss']);
      if (layout.tags.includes('elite')) expect(layout.tags.includes('early')).toBe(false);
    }
  });
});

describe('террейн в бою', () => {
  it('камни не входят в достижимые клетки кандидатов', () => {
    const self = fighter('a', 'party', { x: 4, y: 4 });
    const rock = { x: 5, y: 4 };
    const cands = generateCandidates(self, [self], makeCtx(blockedBy([rock])));
    expect(cands.some((c) => posEq(c.to, rock))).toBe(false);
  });

  it('камень режет линию видимости стрелка', () => {
    const shooter = fighter('a', 'party', { x: 3, y: 4 }, { range: 4, move: 0 });
    const target = fighter('e', 'foe', { x: 7, y: 4 });
    const rock = { x: 5, y: 4 };
    const open = generateCandidates(shooter, [shooter, target]);
    expect(open.some((c) => c.action === 'attack')).toBe(true);
    const walled = generateCandidates(shooter, [shooter, target], makeCtx(blockedBy([rock])));
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
    const pick = (): { seed: number; rock: Pos } => {
      for (let seed = 1; seed < 20; seed++) {
        const layout = pickTerrain(seed);
        for (const [y, row] of layout.tiles.entries()) {
          for (const [x, t] of row.entries()) {
            if (t.blocked) return { seed, rock: { x, y } };
          }
        }
      }
      throw new Error('нет схемы с камнем');
    };
    const { seed, rock } = pick();
    const specs: UnitSpec[] = [
      { id: 'a', name: 'a', side: 'party', maxHp: 20, atk: 5, range: 1, speed: 5, move: 3, lenses: ['plain'], rules: [attackRule()], spawn: rock },
      { id: 'e', name: 'e', side: 'foe', maxHp: 20, atk: 5, range: 1, speed: 4, move: 3, lenses: ['plain'], rules: [attackRule()], spawn: { x: 16, y: 9 } },
    ];
    const r = runBattle(seed, specs);
    expect(r.terrain.tiles[rock.y]![rock.x]!.blocked).toBeFalsy();
  });

  it('бой с террейном детерминирован: тот же сид — тот же лог и та же схема', () => {
    const specs: UnitSpec[] = [
      { id: 'a', name: 'a', side: 'party', maxHp: 30, atk: 5, range: 1, speed: 5, move: 3, lenses: ['plain'], rules: [attackRule()], spawn: { x: 2, y: 8 } },
      { id: 'e', name: 'e', side: 'foe', maxHp: 30, atk: 5, range: 1, speed: 4, move: 3, lenses: ['plain'], rules: [attackRule()] },
    ];
    const a = runBattle(3, specs);
    const b = runBattle(3, specs);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.terrain).toEqual(b.terrain);
    expect(a.terrain.name).toBe(pickTerrain(3).name);
  });

  it('пул арены меняет схему боя при том же сиде', () => {
    const specs: UnitSpec[] = [
      { id: 'a', name: 'a', side: 'party', maxHp: 30, atk: 5, range: 1, speed: 5, move: 3, lenses: ['plain'], rules: [attackRule()], spawn: { x: 2, y: 8 } },
      { id: 'e', name: 'e', side: 'foe', maxHp: 30, atk: 5, range: 1, speed: 4, move: 3, lenses: ['plain'], rules: [attackRule()] },
    ];
    const boss = runBattle(3, specs, 'boss');
    expect(boss.terrain.name).toBe('арена вожака');
    expect(boss.terrain.name).not.toBe(runBattle(3, specs).terrain.name);
  });
});
