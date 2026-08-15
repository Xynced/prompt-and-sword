import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import { type Fighter, decide, mapPenaltyOf, makeCtx, movesOf } from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { heroArchetype } from '../src/heroes.js';
import {
  MAP_STEP,
  MAP_STEP_AGILE,
  MAP_STEP_FLURRY,
  MAP_STEP_FLURRY_AGILE,
  OFTEN_STANCE_MAP_RELIEF,
  mapPenalty,
} from '../src/tuning.js';
import type { CombatUnit, Pos, Side, WeaponSpec } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Штраф за множественные атаки (MAP, план action-economy, волна 6): второй
 * удар за ход бьёт со штрафом, третий — с двойным; ловкое оружие и пассив
 * следопыта смягчают лестницу, парный приём проводит два удара по одному
 * штрафу. Счётчик живёт ход и сбрасывается в начале своего хода.
 */

function fighter(
  id: string,
  side: Side,
  pos: Pos,
  over: Partial<CombatUnit> = {},
  rules: Rule[] = [],
): Fighter {
  return {
    id,
    name: id,
    side,
    maxHp: 40,
    hp: 40,
    atk: 5,
    range: 1,
    speed: 5,
    move: 2,
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

const rule = (then: Rule['then'], weight = 2): Rule => ({
  when: { kind: 'always' },
  then,
  weight,
  scope: 'self',
  source: 'тест',
});

/**
 * Ступени бойцов из смоуков ниже: они держат приказ «бить часто», а его стойка
 * смягчает штраф на единицу — иначе слово заказывало бы ровно то, что MAP
 * штрафует. Без приказа скоринг сам частить не станет, поэтому фикстуры
 * штрафа неизбежно живут в этой стойке.
 */
const OFTEN_STEP = MAP_STEP - OFTEN_STANCE_MAP_RELIEF;
const OFTEN_STEP_AGILE = MAP_STEP_AGILE - OFTEN_STANCE_MAP_RELIEF;

const attacks = (events: readonly BattleEvent[], unit: string): Extract<BattleEvent, { t: 'attack' }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: 'attack' }> => e.t === 'attack' && e.unit === unit);

/** Юнит-мешок: стоит вплотную, ничего не делает, переживает любой ход. */
const dummy = (id: string, pos: Pos): UnitSpec => ({
  id,
  name: id,
  side: 'foe',
  maxHp: 400,
  atk: 1,
  range: 1,
  speed: 1,
  move: 0,
  lenses: ['plain'],
  rules: [],
  spawn: pos,
});

describe('лестница штрафа', () => {
  it('две ступени и не выше: 0 / −5 / −10, дальше без роста', () => {
    expect(mapPenalty(0)).toBe(0);
    expect(mapPenalty(1)).toBe(MAP_STEP);
    expect(mapPenalty(2)).toBe(2 * MAP_STEP);
    expect(mapPenalty(3)).toBe(2 * MAP_STEP); // третий удар — уже потолок
    expect(mapPenalty(9)).toBe(2 * MAP_STEP);
  });

  it('ловкое оружие и пассив следопыта смягчают ступень (agile / flurry pf2e)', () => {
    expect(mapPenalty(1, { agile: true })).toBe(MAP_STEP_AGILE);
    expect(mapPenalty(1, { flurry: true })).toBe(MAP_STEP_FLURRY);
    expect(mapPenalty(2, { flurry: true, agile: true })).toBe(2 * MAP_STEP_FLURRY_AGILE);
  });

  it('штраф юнита читается с оружия и пассива', () => {
    const sword: WeaponSpec = { name: 'меч', dmg: 7, range: 1 };
    const knives: WeaponSpec = { name: 'ножи', dmg: 6, range: 1, agile: true };
    const u = fighter('u', 'party', { x: 1, y: 1 }, { strikes: 1 });
    expect(mapPenaltyOf(u, sword)).toBe(MAP_STEP);
    expect(mapPenaltyOf(u, knives)).toBe(MAP_STEP_AGILE);
    const ranger = fighter('r', 'party', { x: 1, y: 1 }, { strikes: 1, passives: { flurry: true } });
    expect(mapPenaltyOf(ranger, sword)).toBe(MAP_STEP_FLURRY);
    // до первого удара штрафа нет ни у кого
    expect(mapPenaltyOf(fighter('f', 'party', { x: 1, y: 1 }), sword)).toBe(0);
  });
});

describe('штраф в бою', () => {
  const brawler = (over: Partial<UnitSpec> = {}): UnitSpec => ({
    id: 'a',
    name: 'a',
    side: 'party',
    maxHp: 60,
    weapons: [{ name: 'меч', dmg: 7, range: 1 }],
    speed: 9,
    move: 0,
    lenses: ['plain'],
    rules: [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'strikeOften' })],
    spawn: { x: 4, y: 4 },
    ...over,
  });

  it('второй и третий удары за ход помечены штрафом, первый — нет', () => {
    const res = runBattle(7, [brawler(), dummy('e', { x: 5, y: 4 })]);
    const first = attacks(res.events, 'a').slice(0, 3);
    expect(first.length).toBe(3); // три быстрых удара за ход
    expect(first[0]!.map).toBeUndefined();
    expect(first[1]!.map).toBe(OFTEN_STEP);
    expect(first[2]!.map).toBe(2 * OFTEN_STEP);
  });

  it('счётчик живёт ход: первый удар следующего хода снова без штрафа', () => {
    const res = runBattle(7, [brawler(), dummy('e', { x: 5, y: 4 })]);
    const all = attacks(res.events, 'a');
    // ход — три удара; четвёртый принадлежит следующему ходу
    expect(all[3]!.map).toBeUndefined();
  });

  it('промах тоже считается: штраф растёт с попыток, а не с попаданий', () => {
    // мешок с непробиваемым КБ: все удары мимо, но штраф идёт своим чередом
    const res = runBattle(7, [brawler(), { ...dummy('e', { x: 5, y: 4 }), defenses: { ac: 40 } }]);
    const first = attacks(res.events, 'a').slice(0, 3);
    expect(first.every((e) => e.outcome === 'miss')).toBe(true);
    expect(first.map((e) => e.map ?? 0)).toEqual([0, OFTEN_STEP, 2 * OFTEN_STEP]);
  });

  it('ловкое оружие платит мягче — и это видно в самом событии', () => {
    const res = runBattle(7, [
      brawler({ weapons: [{ name: 'ножи', dmg: 7, range: 1, agile: true }] }),
      dummy('e', { x: 5, y: 4 }),
    ]);
    expect(attacks(res.events, 'a')[1]!.map).toBe(OFTEN_STEP_AGILE);
  });

  it('стойка «бить часто» смягчает ступень: без приказа о темпе платится полная', () => {
    // тот же боец без слова о темпе: бьёт полным ударом и добирает быстрым —
    // второй удар за ход идёт по полной ступени, а не по смягчённой
    const plain = runBattle(7, [
      brawler({ rules: [rule({ kind: 'attack', target: 'nearest' })] }),
      dummy('e', { x: 5, y: 4 }),
    ]);
    const shots = attacks(plain.events, 'a');
    expect(shots[0]!.map).toBeUndefined();
    expect(shots[1]!.map).toBe(MAP_STEP);
    expect(MAP_STEP).toBeGreaterThan(OFTEN_STEP);
  });

  it('скоринг видит штраф: тот же удар по той же цели после первого стоит дешевле', () => {
    const units = [
      fighter('a', 'party', { x: 4, y: 4 }, { weapons: [{ name: 'меч', dmg: 7, range: 1 }] }, [
        rule({ kind: 'attack', target: 'nearest' }),
      ]),
      fighter('e', 'foe', { x: 5, y: 4 }, { maxHp: 400, hp: 400 }),
    ];
    const ctx = makeCtx();
    const fresh = decide(units[0]!, units, 1, undefined, 3, ctx).score;
    units[0]!.strikes = 2;
    const tired = decide(units[0]!, units, 1, undefined, 3, ctx).score;
    expect(tired).toBeLessThan(fresh);
  });
});

describe('парный приём', () => {
  const yuna = heroArchetype('yuna');
  const squall = movesOf(yuna.weapons[0]!).find((m) => m.pair)!;

  it('носители парных ударов — монахи и плутовка-двуручница', () => {
    for (const id of ['yuna', 'zhalo', 'lisa']) {
      const arch = heroArchetype(id);
      expect(arch.weapons.some((w) => movesOf(w).some((m) => m.pair))).toBe(true);
    }
    // у Дарта своё: не парный приём, а мягкая лестница штрафа
    expect(heroArchetype('dart').passives?.flurry).toBe(true);
  });

  it('за одно решение проходят два удара, и оба — по одному штрафу', () => {
    const monk: UnitSpec = {
      id: 'y',
      name: 'Юна',
      side: 'party',
      maxHp: yuna.stats.maxHp,
      weapons: [...yuna.weapons],
      speed: 9,
      move: 0,
      lenses: ['plain'],
      rules: [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'strikeOften' })],
      spawn: { x: 4, y: 4 },
    };
    const res = runBattle(5, [monk, dummy('e', { x: 5, y: 4 })]);
    const hits = attacks(res.events, 'y');
    expect(hits[0]!.move).toBe(squall.name);
    // два удара одного действия: штрафа нет ни у первого, ни у второго
    expect(hits[0]!.map).toBeUndefined();
    expect(hits[1]!.map).toBeUndefined();
    // следующее действие уже с третьей ступени: приём стоил двух ударов
    expect(hits[2]!.map).toBe(2 * OFTEN_STEP_AGILE);
  });

  it('удары независимы: у каждого свой бросок против того же КБ', () => {
    const monk: UnitSpec = {
      id: 'y',
      name: 'Юна',
      side: 'party',
      maxHp: yuna.stats.maxHp,
      weapons: [...yuna.weapons],
      speed: 9,
      move: 0,
      lenses: ['plain'],
      rules: [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'strikeOften' })],
      spawn: { x: 4, y: 4 },
    };
    // на длинной дистанции боя обязательно встретится пара «попал и промахнулся»
    const res = runBattle(11, [monk, dummy('e', { x: 5, y: 4 })]);
    const hits = attacks(res.events, 'y');
    const pairs = hits.length / 2;
    expect(pairs).toBeGreaterThan(4);
    const mixed = Array.from({ length: pairs }, (_, i) => [hits[i * 2]!, hits[i * 2 + 1]!]).some(
      ([a, b]) => (a!.outcome === 'miss') !== (b!.outcome === 'miss'),
    );
    expect(mixed).toBe(true);
  });
});

describe('детерминизм', () => {
  it('тот же сид — тот же лог (штраф не трогает поток rng)', () => {
    const party = (): UnitSpec[] => [
      {
        id: 'y',
        name: 'Юна',
        side: 'party',
        maxHp: 52,
        weapons: [...heroArchetype('yuna').weapons],
        speed: 9,
        move: 2,
        lenses: ['plain'],
        rules: [rule({ kind: 'attack', target: 'nearest' })],
        spawn: { x: 4, y: 4 },
      },
      {
        id: 'e',
        name: 'e',
        side: 'foe',
        maxHp: 60,
        atk: 6,
        range: 1,
        speed: 5,
        move: 2,
        lenses: ['plain'],
        rules: [rule({ kind: 'attack', target: 'nearest' })],
        spawn: { x: 8, y: 4 },
      },
    ];
    const a = runBattle(3, party());
    const b = runBattle(3, party());
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });
});
