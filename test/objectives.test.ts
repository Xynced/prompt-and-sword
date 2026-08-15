import { describe, expect, it } from 'vitest';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { objectiveRewrite } from '../src/balance.js';
import { ritualist } from '../src/foes.js';
import { dist } from '../src/grid.js';
import { PARTY_SPAWNS, heroArchetype } from '../src/heroes.js';
import type { Rule } from '../src/ir.js';
import { AMBUSH_WAVE_ROUND, RITUAL_DEADLINE, scenarioForNode } from '../src/objectives.js';
import { type MapNode, currentNode, deployedSpawn, foesForNode, generateMap, setDeploy, startRun } from '../src/run.js';

/**
 * План objectives, волна 1: задачи боя (killTarget / killBefore / survive),
 * волны подкреплений, слабый инстинкт цели (quarry), четыре сценария узлов.
 * Смоуки парные — «наив vs контр» на общих сидах (критерий плана: задача
 * обязана заставлять переписать принципы).
 */

const r = (rule: Omit<Rule, 'scope'>): Rule => ({ ...rule, scope: 'self' });
const atkNearest = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 2, source: 'бей ближайшего' });
const atkLeader = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'leader' }, weight: 2, source: 'вали вожака' });

function dummy(id: string, side: 'party' | 'foe', over: Partial<UnitSpec> = {}): UnitSpec {
  return {
    id,
    name: id,
    side,
    maxHp: 30,
    atk: 5,
    range: 1,
    speed: 5,
    move: 2,
    lenses: ['plain'],
    rules: [atkNearest],
    ...over,
  };
}

/** Герой из пула с заданными приказами (конвенция foe-patterns). */
function hero(archId: string, slot: number, rules: Rule[], spawn = PARTY_SPAWNS[slot]!): UnitSpec {
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
    defenses: a.defenses,
    spawn: { ...spawn },
  };
}

const node = (kind: MapNode['kind'], layer: number, slot: number): MapNode => ({
  id: 0,
  layer,
  slot,
  kind,
  next: [],
});

interface SweepStats {
  wins: number;
  hpFrac: number;
  rounds: number;
}

function sweep(
  party: () => UnitSpec[],
  foes: () => UnitSpec[],
  arena: 'early' | 'late' | 'elite',
  setup?: Parameters<typeof runBattle>[3],
  seeds = 20,
): SweepStats {
  let wins = 0;
  let hpFrac = 0;
  let rounds = 0;
  for (let s = 1; s <= seeds; s++) {
    const res = runBattle(s * 17 + 3, [...party(), ...foes()], arena, setup);
    if (res.winner === 'party') wins++;
    const pu = res.units.filter((u) => u.side === 'party');
    hpFrac += pu.reduce((a, u) => a + (u.alive ? u.hp : 0), 0) / pu.reduce((a, u) => a + u.maxHp, 0);
    rounds += res.rounds;
  }
  return { wins, hpFrac: hpFrac / seeds, rounds: rounds / seeds };
}

// ---- Семантика задач ----

describe('objective: killTarget', () => {
  const specs = (): UnitSpec[] => [
    dummy('grom', 'party', { atk: 12, spawn: { x: 2, y: 8 } }),
    dummy('boss', 'foe', { maxHp: 10, spawn: { x: 3, y: 8 } }),
    dummy('far1', 'foe', { spawn: { x: 17, y: 0 }, rules: [] }),
    dummy('far2', 'foe', { spawn: { x: 17, y: 17 }, rules: [] }),
  ];

  it('смерть цели решает бой мгновенно — свита ещё жива', () => {
    const res = runBattle(7, specs(), 'late', { objective: { kind: 'killTarget', targetId: 'boss' } });
    expect(res.winner).toBe('party');
    expect(res.units.filter((u) => u.side === 'foe' && u.alive).length).toBeGreaterThan(0);
    expect(res.events.at(-1)).toEqual({ t: 'end', winner: 'party', rounds: res.rounds });
  });

  it('партия пала — поражение, задача не спасает', () => {
    const doomed = [
      dummy('grom', 'party', { maxHp: 8, atk: 1, spawn: { x: 2, y: 8 } }),
      dummy('boss', 'foe', { maxHp: 200, atk: 12, spawn: { x: 3, y: 8 } }),
    ];
    const res = runBattle(7, doomed, 'late', { objective: { kind: 'killTarget', targetId: 'boss' } });
    expect(res.winner).toBe('foe');
  });

  it('цель несёт тег quarry', () => {
    const res = runBattle(7, specs(), 'late', { objective: { kind: 'killTarget', targetId: 'boss' } });
    expect(res.units.find((u) => u.id === 'boss')!.tags).toContain('quarry');
  });
});

describe('objective: killBefore (дедлайн)', () => {
  it('цель дожила до дедлайна — поражение в начале раунда', () => {
    const specs = [
      dummy('grom', 'party', { spawn: { x: 0, y: 0 } }),
      dummy('ritualist', 'foe', { maxHp: 200, spawn: { x: 17, y: 17 }, rules: [] }),
    ];
    const res = runBattle(7, specs, 'late', {
      objective: { kind: 'killBefore', targetId: 'ritualist', round: 2 },
    });
    expect(res.winner).toBe('foe');
    expect(res.rounds).toBe(2);
  });

  it('цель убита раньше — победа', () => {
    const specs = [
      dummy('grom', 'party', { atk: 12, spawn: { x: 2, y: 8 } }),
      dummy('ritualist', 'foe', { maxHp: 10, spawn: { x: 3, y: 8 } }),
    ];
    const res = runBattle(7, specs, 'late', {
      objective: { kind: 'killBefore', targetId: 'ritualist', round: 6 },
    });
    expect(res.winner).toBe('party');
    expect(res.rounds).toBeLessThan(6);
  });
});

describe('objective: survive', () => {
  it('партия дожила до конца раунда — победа при живых врагах', () => {
    const hold = r({ when: { kind: 'always' }, then: { kind: 'holdPosition' }, weight: 3, source: 'держать позицию' });
    const specs = [
      dummy('grom', 'party', { rules: [hold], spawn: { x: 0, y: 8 } }),
      dummy('ogre', 'foe', { maxHp: 200, move: 1, speed: 1, spawn: { x: 17, y: 8 } }),
    ];
    const res = runBattle(7, specs, 'late', { objective: { kind: 'survive', rounds: 3 } });
    expect(res.winner).toBe('party');
    expect(res.rounds).toBe(3);
    expect(res.units.find((u) => u.id === 'ogre')!.alive).toBe(true);
  });
});

describe('волны подкреплений', () => {
  const late = (): UnitSpec => dummy('late1', 'foe', { spawn: { x: 17, y: 8 } });

  it('волна выходит в начале своего раунда, не раньше', () => {
    const specs = [
      dummy('grom', 'party', { atk: 12, spawn: { x: 2, y: 8 } }),
      dummy('first', 'foe', { maxHp: 10, spawn: { x: 3, y: 8 } }),
    ];
    const res = runBattle(7, specs, 'late', { waves: [{ round: 3, specs: [late()] }] });
    const events = res.events;
    const waveSpawnIdx = events.findIndex((e) => e.t === 'spawn' && e.unit === 'late1');
    const round3Idx = events.findIndex((e) => e.t === 'round' && e.n === 3);
    expect(waveSpawnIdx).toBeGreaterThan(round3Idx);
    expect(round3Idx).toBeGreaterThan(-1);
  });

  it('перебитые первые враги не кончают бой, пока волны в пути', () => {
    const specs = [
      dummy('grom', 'party', { atk: 12, spawn: { x: 2, y: 8 } }),
      dummy('first', 'foe', { maxHp: 10, spawn: { x: 3, y: 8 } }),
    ];
    const res = runBattle(7, specs, 'late', { waves: [{ round: 4, specs: [late()] }] });
    expect(res.rounds).toBeGreaterThanOrEqual(4);
    expect(res.winner).toBe('party');
  });

  it('занятая точка спавна — ближайшая свободная, детерминированно', () => {
    const hold = r({ when: { kind: 'always' }, then: { kind: 'holdPosition' }, weight: 3, source: 'держать позицию' });
    const specs = [
      dummy('grom', 'party', { rules: [hold], atk: 12, spawn: { x: 5, y: 5 } }),
      dummy('first', 'foe', { maxHp: 200, move: 1, speed: 1, spawn: { x: 17, y: 17 } }),
    ];
    const wave: UnitSpec = dummy('late1', 'foe', { spawn: { x: 5, y: 5 } });
    const res = runBattle(7, specs, 'late', { waves: [{ round: 2, specs: [wave] }] });
    const spawn = res.events.find((e): e is Extract<BattleEvent, { t: 'spawn' }> => e.t === 'spawn' && e.unit === 'late1')!;
    expect(spawn.pos).not.toEqual({ x: 5, y: 5 });
    expect(dist(spawn.pos, { x: 5, y: 5 })).toBeLessThanOrEqual(2);
  });

  it('детерминизм: тот же seed + та же задача = побайтово тот же лог', () => {
    const sc = scenarioForNode(node('elite', 5, 0))!;
    const party = (): UnitSpec[] => [hero('grom', 0, [atkNearest]), hero('lia', 1, [atkNearest]), hero('zhalo', 2, [atkNearest])];
    const a = runBattle(42, [...party(), ...foesForNode(node('elite', 5, 0))], 'elite', sc.setup);
    const b = runBattle(42, [...party(), ...foesForNode(node('elite', 5, 0))], 'elite', sc.setup);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });
});

describe('слабый инстинкт цели (quarry)', () => {
  // манера без выбора цели: даёт тягу к атаке, не диктуя, кого бить, —
  // выбор цели остаётся инстинктам (правило-less юнит под угрозой черепашится)
  const often = r({ when: { kind: 'always' }, then: { kind: 'strikeOften' }, weight: 2, source: 'бить часто' });

  it('без слова о цели инстинкт тянет к жертве задачи, даже «невыгодной»', () => {
    // враги медленнее: герой решает до того, как безрульные цели встанут в
    // оборону (по броне решение честно уходит к открытой цели)
    const specs = (): UnitSpec[] => [
      dummy('grom', 'party', { rules: [often], spawn: { x: 5, y: 5 } }),
      dummy('plain', 'foe', { maxHp: 30, speed: 4, spawn: { x: 4, y: 5 }, rules: [] }),
      dummy('boss', 'foe', { maxHp: 40, speed: 4, spawn: { x: 6, y: 5 }, rules: [] }),
    ];
    // без задачи агрессия выбирает хлипкого; с задачей инстинкт перетягивает к цели
    const plain = runBattle(7, specs(), 'late');
    const firstPlain = plain.events.find((e): e is Extract<BattleEvent, { t: 'attack' }> => e.t === 'attack' && e.unit === 'grom')!;
    expect(firstPlain.target).toBe('plain');
    const tasked = runBattle(7, specs(), 'late', { objective: { kind: 'killTarget', targetId: 'boss' } });
    const first = tasked.events.find((e): e is Extract<BattleEvent, { t: 'attack' }> => e.t === 'attack' && e.unit === 'grom')!;
    expect(first.target).toBe('boss');
  });

  it('слово игрока перебивает инстинкт задачи', () => {
    const specs = [
      dummy('grom', 'party', { rules: [atkNearest], spawn: { x: 5, y: 5 } }),
      dummy('plain', 'foe', { maxHp: 30, spawn: { x: 4, y: 5 }, rules: [] }),
      dummy('boss', 'foe', { maxHp: 40, spawn: { x: 7, y: 5 }, rules: [] }),
    ];
    const res = runBattle(7, specs, 'late', { objective: { kind: 'killTarget', targetId: 'boss' } });
    const first = res.events.find((e): e is Extract<BattleEvent, { t: 'attack' }> => e.t === 'attack' && e.unit === 'grom')!;
    expect(first.target).toBe('plain');
  });
});

// ---- Раскладка по узлам ----

describe('сценарии узлов (раскладка волны 1)', () => {
  it('слой/слот → сценарий: обезглавить, лагерь, ритуал, волны', () => {
    expect(scenarioForNode(node('fight', 1, 1))?.id).toBe('behead');
    expect(scenarioForNode(node('fight', 3, 0))?.id).toBe('camp');
    expect(scenarioForNode(node('elite', 5, 0))?.id).toBe('ritual');
    expect(scenarioForNode(node('fight', 5, 1))?.id).toBe('waves');
    expect(scenarioForNode(node('fight', 1, 0))).toBeNull();
    expect(scenarioForNode(node('lesson', 0, 0))).toBeNull();
  });

  it('составы сценариев: свита вожака толще, ритуалист за огром, волна с тыла', () => {
    const behead = foesForNode(node('fight', 1, 1));
    expect(behead.map((f) => f.id)).toContain('boss');
    expect(behead.length).toBe(4);
    const ritual = foesForNode(node('elite', 5, 0));
    expect(ritual.map((f) => f.id)).toEqual(['ogre', 'ritualist', 'slinger1']);
    const waves = scenarioForNode(node('fight', 5, 1))!;
    expect(foesForNode(node('fight', 5, 1)).map((f) => f.id)).toEqual(['wolf1', 'wolf2']);
    expect(waves.setup.waves![0]!.round).toBe(AMBUSH_WAVE_ROUND);
    expect(waves.setup.waves![0]!.specs.map((s) => s.id)).toEqual(['thug', 'wolf3']);
  });

  it('разбитый лагерь: расстановка не в руках игрока, спавны фиксированы', () => {
    const seed = (() => {
      for (let s = 1; s < 200; s++) {
        if (generateMap(s).some((n) => n.kind === 'fight' && n.layer === 3 && n.slot === 0)) return s;
      }
      throw new Error('нет сида с узлом лагеря');
    })();
    const state = startRun(seed);
    const campNode = state.map.find((n) => n.kind === 'fight' && n.layer === 3 && n.slot === 0)!;
    state.at = campNode.id;
    state.resolved = false;
    const res = setDeploy(state, state.heroes[0]!.id, { x: 1, y: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('расстановка');
    expect(deployedSpawn(state, state.heroes[0]!)).toEqual({ x: 2, y: 2 });
    expect(deployedSpawn(state, state.heroes[2]!)).toEqual({ x: 8, y: 8 });
  });

  it('бот: на kill-задаче при открытом «вожаке» переписывается и восстанавливается', () => {
    const state = startRun(1);
    const beheadNode = state.map.find((n) => n.kind === 'fight' && n.layer === 1 && n.slot === 1)!;
    state.at = beheadNode.id;
    state.resolved = false;
    // «вожак» — обычный трофей, не стартовое слово: без него бот играет наивом
    expect(objectiveRewrite(state)).toBeNull();
    state.vocab.push('sel.leader');
    const before = state.heroes.map((h) => h.phrases);
    const restore = objectiveRewrite(state);
    expect(restore).not.toBeNull();
    for (const h of state.heroes) {
      expect(h.phrases[0]!.preference).toEqual({ id: 'act.attack', target: 'sel.leader' });
    }
    restore!();
    state.heroes.forEach((h, i) => expect(h.phrases).toBe(before[i]!));
    state.at = 0; // урок — без задачи
    expect(objectiveRewrite(state)).toBeNull();
  });
});

// ---- Парные смоуки «наив vs контр» ----

describe('смоук: обезглавить (слой 1)', () => {
  const sc = scenarioForNode(node('fight', 1, 1))!;
  const foes = (): UnitSpec[] => foesForNode(node('fight', 1, 1));

  it('наив рубит всех подряд и платит; «вали вожака» кончает бой раньше и дешевле', () => {
    const naive = sweep(
      () => [hero('grom', 0, [atkNearest]), hero('lia', 1, [atkNearest]), hero('zhalo', 2, [atkNearest])],
      foes,
      'early',
      sc.setup,
    );
    const decap = sweep(
      () => [hero('grom', 0, [atkLeader]), hero('lia', 1, [atkLeader]), hero('zhalo', 2, [atkLeader])],
      foes,
      'early',
      sc.setup,
    );
    expect(decap.wins).toBeGreaterThanOrEqual(naive.wins);
    expect(decap.rounds).toBeLessThan(naive.rounds);
    expect(decap.hpFrac).toBeGreaterThan(naive.hpFrac);
  });
});

describe('смоук: сорвать ритуал (элитка слоя 5)', () => {
  const sc = scenarioForNode(node('elite', 5, 0))!;
  const foes = (): UnitSpec[] => foesForNode(node('elite', 5, 0));

  it('спеки: дедлайн раунда, ритуалист с тегом leader за огром', () => {
    expect(sc.setup.objective).toEqual({ kind: 'killBefore', targetId: 'ritualist', round: RITUAL_DEADLINE });
    const rit = ritualist('ogre');
    expect(rit.tags).toContain('leader');
    expect(rit.rules.some((rl) => rl.then.kind === 'behind')).toBe(true);
  });

  it('наив упирается в огра и не успевает; дайв на ритуалиста успевает', () => {
    const naive = sweep(
      () => [hero('grom', 0, [atkNearest]), hero('lia', 1, [atkNearest]), hero('zhalo', 2, [atkNearest])],
      foes,
      'elite',
      sc.setup,
    );
    const dive = sweep(
      () => [hero('grom', 0, [atkLeader]), hero('lia', 1, [atkLeader]), hero('zhalo', 2, [atkLeader])],
      foes,
      'elite',
      sc.setup,
    );
    expect(naive.wins).toBeLessThan(10);
    expect(dive.wins).toBeGreaterThan(naive.wins + 5);
  });
});

describe('смоук: разбитый лагерь (слой 3)', () => {
  const sc = scenarioForNode(node('fight', 3, 0))!;
  const foes = (): UnitSpec[] => foesForNode(node('fight', 3, 0));
  const spawns = sc.heroSpawns!;

  it('врозь стая рвёт поодиночке; сбор к танку («рядом с Громом») спасает', () => {
    const naive = sweep(
      () => [
        hero('grom', 0, [atkNearest], spawns[0]),
        hero('lia', 1, [atkNearest], spawns[1]),
        hero('zhalo', 2, [atkNearest], spawns[2]),
      ],
      foes,
      'late',
      sc.setup,
    );
    const rally = r({
      when: { kind: 'always' },
      then: { kind: 'nearTo', ref: { type: 'ally', id: 'grom' } },
      weight: 2,
      source: 'держаться Грома',
    });
    const regroup = sweep(
      () => [
        hero('grom', 0, [atkNearest], spawns[0]),
        hero('lia', 1, [rally, atkNearest], spawns[1]),
        hero('zhalo', 2, [rally, atkNearest], spawns[2]),
      ],
      foes,
      'late',
      sc.setup,
    );
    expect(regroup.wins).toBeGreaterThanOrEqual(naive.wins);
    expect(regroup.hpFrac).toBeGreaterThan(naive.hpFrac);
  });
});

describe('смоук: загонная охота (слой 5, волны)', () => {
  const sc = scenarioForNode(node('fight', 5, 1))!;
  const foes = (): UnitSpec[] => foesForNode(node('fight', 5, 1));

  const liaDeaths = (party: () => UnitSpec[]): { wins: number; deaths: number } => {
    let wins = 0;
    let deaths = 0;
    for (let s = 1; s <= 20; s++) {
      const res = runBattle(s * 17 + 3, [...party(), ...foes()], 'late', sc.setup);
      if (res.winner === 'party') wins++;
      if (!res.units.find((u) => u.id === 'lia')!.alive) deaths++;
    }
    return { wins, deaths };
  };

  it('наив побеждает, но хоронит мага в каждом бою — задача бьёт пермасмертью', () => {
    const naive = liaDeaths(() => [hero('grom', 0, [atkNearest]), hero('lia', 1, [atkNearest]), hero('zhalo', 2, [atkNearest])]);
    expect(naive.wins).toBeGreaterThanOrEqual(16);
    expect(naive.deaths).toBeGreaterThanOrEqual(15);
  });

  it('связка защиты («прикрывай Лию» + «держись за Громом») спасает мага', () => {
    const pairGuard = r({ when: { kind: 'always' }, then: { kind: 'protect', ally: 'lia' }, weight: 1.5, source: 'прикрывай Лию' });
    const pairBehind = r({ when: { kind: 'always' }, then: { kind: 'behind', ref: { type: 'ally', id: 'grom' } }, weight: 1.5, source: 'держись за Громом' });
    const naive = liaDeaths(() => [hero('grom', 0, [atkNearest]), hero('lia', 1, [atkNearest]), hero('zhalo', 2, [atkNearest])]);
    const pair = liaDeaths(() => [
      hero('grom', 0, [atkNearest, pairGuard]),
      hero('lia', 1, [atkNearest, pairBehind]),
      hero('zhalo', 2, [atkNearest]),
    ]);
    expect(pair.wins).toBeGreaterThanOrEqual(naive.wins - 2);
    expect(pair.deaths).toBeLessThanOrEqual(5);
    expect(naive.deaths - pair.deaths).toBeGreaterThanOrEqual(10);
  });
});
