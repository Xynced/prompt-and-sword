import { describe, expect, it } from 'vitest';
import {
  type RunState,
  arenaForNode,
  battleSeed,
  currentNode,
  deployedSpawn,
  foeSpecs,
  heroSpecs,
  playFight,
  setDeploy,
  startRun,
} from '../src/run.js';
import { runBattle, spawnPreview } from '../src/battle.js';
import { sparring } from '../src/sparring.js';
import { PARTY_SPAWNS } from '../src/heroes.js';
import type { Pos } from '../src/types.js';

/**
 * Расстановка (план поля, шаг 7): игрок ставит героев в зону развёртывания
 * на экране узла; вход боя, а не случайность — спарринг «те же кости» играет
 * с той же расстановкой; без неё — детерминированный дефолт слотов.
 */

/** Свободная клетка зоны, не совпадающая с чужими спавнами. */
function freeCell(state: RunState, notFor: string): Pos {
  for (let y = 0; y < 18; y++) {
    for (let x = 0; x <= 2; x++) {
      const p = { x, y };
      const taken = state.heroes.some(
        (h) => h.alive && h.id !== notFor && deployedSpawn(state, h).x === x && deployedSpawn(state, h).y === y,
      );
      if (!taken) return p;
    }
  }
  throw new Error('нет свободной клетки');
}

describe('setDeploy: валидация', () => {
  it('вне зоны, в занятое и вне боевого узла — ошибка; валидная клетка — ок', () => {
    const state = startRun(1);
    const [h1, h2] = state.heroes;
    expect(setDeploy(state, h1!.id, { x: 5, y: 5 }).ok).toBe(false); // вне зоны (x > 2)
    expect(setDeploy(state, h1!.id, { x: 0, y: 18 }).ok).toBe(false); // за краем
    expect(setDeploy(state, h1!.id, { ...deployedSpawn(state, h2!) }).ok).toBe(false); // занято
    expect(setDeploy(state, 'нет-такого', { x: 0, y: 0 }).ok).toBe(false);

    const ok = setDeploy(state, h1!.id, freeCell(state, h1!.id));
    expect(ok.ok).toBe(true);
    expect(heroSpecs(state).find((s) => s.id === h1!.id)!.spawn).toEqual(state.deploy[h1!.id]);

    state.resolved = true;
    expect(setDeploy(state, h1!.id, { x: 0, y: 0 }).ok).toBe(false); // узел пройден
  });
});

describe('дефолт и детерминизм', () => {
  it('без расстановки спавны — дефолтные слоты партии', () => {
    const state = startRun(2);
    for (const [slot, h] of state.heroes.entries()) {
      expect(deployedSpawn(state, h)).toEqual(PARTY_SPAWNS[slot]);
    }
  });

  it('бой с ручной расстановкой детерминирован', () => {
    const play = (): ReturnType<typeof playFight> => {
      const s = startRun(3);
      const h = s.heroes[0]!;
      expect(setDeploy(s, h.id, { x: 2, y: 3 }).ok).toBe(true);
      return playFight(s);
    };
    const a = play();
    const b = play();
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it('расстановка — вход боя: другая клетка — другой бой', () => {
    const seedAndSpecs = (dep: Pos | null): { seed: number; events: string } => {
      const s = startRun(3);
      if (dep) expect(setDeploy(s, s.heroes[0]!.id, dep).ok).toBe(true);
      const r = runBattle(battleSeed(s), [...heroSpecs(s), ...foeSpecs(s)], arenaForNode(currentNode(s)));
      return { seed: battleSeed(s), events: JSON.stringify(r.events) };
    };
    const def = seedAndSpecs(null);
    const moved = seedAndSpecs({ x: 2, y: 3 });
    expect(def.seed).toBe(moved.seed); // те же кости —
    expect(def.events).not.toBe(moved.events); // но другая расстановка меняет бой
  });

  it('спарринг фиксирует расстановку: без правок принципов исход не дрожит', () => {
    const s = startRun(3);
    expect(setDeploy(s, s.heroes[0]!.id, { x: 2, y: 3 }).ok).toBe(true);
    const party = heroSpecs(s);
    const d = sparring(battleSeed(s), foeSpecs(s), party, party, arenaForNode(currentNode(s)));
    expect(d.diff.winnerBefore).toBe(d.diff.winnerAfter);
    expect(d.diff.firstDivergenceRound).toBeNull();
  });
});

describe('превью спавнов', () => {
  it('совпадает с фактическими позициями спавна в бою', () => {
    const s = startRun(4);
    const specs = [...heroSpecs(s), ...foeSpecs(s)];
    const preview = new Map(spawnPreview(battleSeed(s), specs).map((u) => [u.id, u.pos]));
    const r = runBattle(battleSeed(s), specs, arenaForNode(currentNode(s)));
    for (const e of r.events) {
      if (e.t !== 'spawn') continue;
      expect(preview.get(e.unit), e.unit).toEqual(e.pos);
    }
  });
});
