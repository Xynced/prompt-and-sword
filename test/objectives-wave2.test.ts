import { describe, expect, it } from 'vitest';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { compilePhrase } from '../src/constructor.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import { PARTY_SPAWNS, heroArchetype } from '../src/heroes.js';
import { type Rule, evalCondition, resolveAlly, resolveSelector } from '../src/ir.js';
import { scenarioForNode } from '../src/objectives.js';
import { decide, makeCtx } from '../src/scoring.js';
import { COMMON_WORDS, CONCEPTS, RARE_WORDS, UNLOCKABLE, type ConceptId } from '../src/vocab.js';
import type { MapNode } from '../src/run.js';

/**
 * План objectives, волна 2: задачи про место и подопечных (holdZone,
 * reachZone, protect, escort, carry, intercept), объекты-юниты, уход с поля —
 * и слова задач (рубеж, выход, трофей, подопечный, прорывающийся).
 */

const FULL_VOCAB = Object.keys(CONCEPTS) as ConceptId[];

const r = (rule: Omit<Rule, 'scope'>): Rule => ({ ...rule, scope: 'self' });
const atkNearest = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 2, source: 'бей ближайшего' });
const hold = r({ when: { kind: 'always' }, then: { kind: 'holdPosition' }, weight: 3, source: 'держать позицию' });
const evacuate = r({ when: { kind: 'always' }, then: { kind: 'evacuate' }, weight: 2, source: 'уходить к выходу' });
const holdLine = r({ when: { kind: 'always' }, then: { kind: 'holdLine' }, weight: 2, source: 'держать рубеж' });
const carryRule = r({ when: { kind: 'always' }, then: { kind: 'carry' }, weight: 2, source: 'нести трофей' });

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

const HOME = { x1: 0, y1: 0, x2: 1, y2: 17 };
const FAR = { x1: 16, y1: 0, x2: 17, y2: 17 };

const ev = <T extends BattleEvent['t']>(events: readonly BattleEvent[], t: T) =>
  events.filter((e): e is Extract<BattleEvent, { t: T }> => e.t === t);

// ---- Семантика задач ----

describe('objective: holdZone (оборона рубежа)', () => {
  it('враг, оставшийся в конце раунда в зоне без наших, закрепился — поражение', () => {
    const specs = [
      dummy('grom', 'party', { rules: [hold], spawn: { x: 10, y: 10 } }),
      dummy('runner', 'foe', { rules: [hold], spawn: { x: 1, y: 8 } }),
    ];
    const res = runBattle(7, specs, 'late', {
      objective: { kind: 'holdZone', rounds: 5 },
      zone: { x1: 0, y1: 6, x2: 2, y2: 11 },
    });
    expect(res.winner).toBe('foe');
    expect(res.rounds).toBe(1);
  });

  it('наш в зоне спорит за рубеж: враг там же — не закрепился, таймер добегает', () => {
    const specs = [
      dummy('grom', 'party', { rules: [hold], spawn: { x: 1, y: 8 }, maxHp: 200 }),
      dummy('runner', 'foe', { rules: [hold], spawn: { x: 1, y: 10 }, maxHp: 200, atk: 1 }),
    ];
    const res = runBattle(7, specs, 'late', {
      objective: { kind: 'holdZone', rounds: 3 },
      zone: { x1: 0, y1: 6, x2: 2, y2: 11 },
    });
    expect(res.winner).toBe('party');
    expect(res.rounds).toBe(3);
  });
});

describe('objective: reachZone (прорыв)', () => {
  it('герой, закончивший шаг в зоне, уходит с поля живым (flee, не die)', () => {
    const specs = [
      dummy('grom', 'party', { rules: [evacuate], move: 3, spawn: { x: 13, y: 8 } }),
      dummy('slow', 'foe', { rules: [hold], move: 1, speed: 1, spawn: { x: 3, y: 3 } }),
    ];
    const res = runBattle(7, specs, 'late', { objective: { kind: 'reachZone', count: 1 }, zone: { ...FAR } });
    expect(res.winner).toBe('party');
    const grom = res.units.find((u) => u.id === 'grom')!;
    expect(grom.fled).toBe(true);
    expect(ev(res.events, 'flee').map((e) => e.unit)).toEqual(['grom']);
    expect(ev(res.events, 'die').length).toBe(0);
  });

  it('ушедших меньше count, остальные пали — поражение', () => {
    const specs = [
      dummy('runner', 'party', { rules: [evacuate], move: 3, spawn: { x: 13, y: 8 } }),
      dummy('frail', 'party', { rules: [hold], maxHp: 6, spawn: { x: 2, y: 3 } }),
      dummy('brute', 'foe', { atk: 20, spawn: { x: 3, y: 3 } }),
    ];
    const res = runBattle(7, specs, 'late', { objective: { kind: 'reachZone', count: 2 }, zone: { ...FAR } });
    expect(res.winner).toBe('foe');
  });
});

describe('objective: protect (обоз и свой ритуал)', () => {
  it('смерть подопечного кончает бой поражением немедленно', () => {
    const specs = [
      dummy('grom', 'party', { rules: [hold], spawn: { x: 10, y: 14 } }),
      dummy('cart', 'party', { inert: true, maxHp: 8, atk: 0, move: 0, speed: 0, rules: [], spawn: { x: 1, y: 8 } }),
      dummy('brute', 'foe', { atk: 20, spawn: { x: 2, y: 8 } }),
    ];
    const res = runBattle(7, specs, 'late', { objective: { kind: 'protect', wardId: 'cart' } });
    expect(res.winner).toBe('foe');
    expect(res.units.find((u) => u.id === 'grom')!.alive).toBe(true);
  });

  it('подопечный несёт тег ward; с rounds его доживание — победа по таймеру', () => {
    const specs = [
      dummy('grom', 'party', { rules: [hold], spawn: { x: 2, y: 8 } }),
      dummy('chanter', 'party', { inert: true, maxHp: 30, atk: 0, move: 0, speed: 0, rules: [], spawn: { x: 0, y: 8 } }),
      dummy('slow', 'foe', { move: 1, speed: 1, maxHp: 200, spawn: { x: 17, y: 17 } }),
    ];
    const res = runBattle(7, specs, 'late', { objective: { kind: 'protect', wardId: 'chanter', rounds: 3 } });
    expect(res.winner).toBe('party');
    expect(res.rounds).toBe(3);
    expect(res.units.find((u) => u.id === 'chanter')!.tags).toContain('ward');
  });
});

describe('objective: escort', () => {
  it('подопечный дошёл до зоны — победа в момент шага', () => {
    const specs = [
      dummy('elder', 'party', { rules: [evacuate], move: 3, spawn: { x: 13, y: 8 } }),
      dummy('slow', 'foe', { rules: [hold], move: 1, speed: 1, spawn: { x: 3, y: 3 } }),
    ];
    const res = runBattle(7, specs, 'late', { objective: { kind: 'escort', wardId: 'elder' }, zone: { ...FAR } });
    expect(res.winner).toBe('party');
    expect(res.units.find((u) => u.id === 'elder')!.alive).toBe(true);
  });

  it('смерть подопечного — поражение', () => {
    const specs = [
      dummy('grom', 'party', { rules: [hold], spawn: { x: 10, y: 14 } }),
      dummy('elder', 'party', { rules: [evacuate], maxHp: 6, spawn: { x: 2, y: 3 } }),
      dummy('brute', 'foe', { atk: 20, spawn: { x: 3, y: 3 } }),
    ];
    const res = runBattle(7, specs, 'late', { objective: { kind: 'escort', wardId: 'elder' }, zone: { ...FAR } });
    expect(res.winner).toBe('foe');
  });
});

describe('objective: carry (трофей)', () => {
  it('поднять (конец шага на клетке) и донести в зону — победа; носильщик несёт тег carrier', () => {
    const specs = [
      dummy('grom', 'party', { rules: [carryRule], move: 3, spawn: { x: 5, y: 9 } }),
      dummy('slow', 'foe', { rules: [hold], move: 1, speed: 1, spawn: { x: 17, y: 17 } }),
    ];
    const res = runBattle(7, specs, 'late', {
      objective: { kind: 'carry' },
      zone: { ...HOME },
      prize: { x: 9, y: 9 },
    });
    expect(res.winner).toBe('party');
    const pickups = ev(res.events, 'pickup');
    expect(pickups.map((e) => e.unit)).toEqual(['grom']);
    expect(pickups[0]!.at).toEqual({ x: 9, y: 9 });
    expect(res.units.find((u) => u.id === 'grom')!.tags).toContain('carrier');
  });

  it('смерть носильщика роняет трофей на его клетке', () => {
    const specs = [
      // носильщик успевает поднять (громила ещё далеко), но медленный —
      // громила догоняет и убивает уже с ношей
      // КБ 5: громила по такой мишени не промахивается — тест про падение
      // ноши, а не про броски (план damage-types)
      dummy('frail', 'party', {
        // приказ нести — с запасом веса: под накатом громилы обычный вес
        // перебивается самосохранением, а тест здесь про падение ноши
        rules: [r({ when: { kind: 'always' }, then: { kind: 'carry' }, weight: 3, source: 'нести трофей' })],
        maxHp: 6,
        move: 1,
        speed: 9,
        spawn: { x: 8, y: 9 },
        // КБ 5: громила по такой мишени не промахивается — тест про ношу,
        // а не про броски (план damage-types)
        defenses: { ac: 5 },
      }),
      dummy('grom', 'party', { rules: [hold], spawn: { x: 0, y: 0 } }),
      dummy('brute', 'foe', { atk: 30, move: 3, speed: 5, spawn: { x: 16, y: 9 } }),
    ];
    // ранний пул арен: без труднопроходимых клеток — медленному носильщику
    // ничто, кроме громилы, не мешает
    const res = runBattle(11, specs, 'early', {
      objective: { kind: 'carry' },
      zone: { ...HOME },
      prize: { x: 9, y: 9 },
    });
    const drops = ev(res.events, 'drop');
    // хрупкий носильщик гибнет под градом ударов — ноша падает там, где он пал
    expect(drops.length).toBe(1);
    expect(drops[0]!.unit).toBe('frail');
  });
});

describe('objective: intercept (погоня)', () => {
  it('гонец, добежавший до зоны, кончает бой поражением', () => {
    const specs = [
      dummy('grom', 'party', { rules: [hold], spawn: { x: 0, y: 0 } }),
      dummy('courier', 'foe', { rules: [evacuate], move: 3, spawn: { x: 12, y: 8 } }),
    ];
    const res = runBattle(7, specs, 'late', {
      objective: { kind: 'intercept', targetId: 'courier' },
      zone: { ...FAR },
    });
    expect(res.winner).toBe('foe');
  });

  it('гонец несёт тег quarry; его смерть — победа, свита не в счёт', () => {
    const specs = [
      dummy('grom', 'party', { atk: 20, spawn: { x: 2, y: 8 } }),
      dummy('courier', 'foe', { rules: [evacuate], maxHp: 8, spawn: { x: 3, y: 8 } }),
      dummy('far', 'foe', { rules: [hold], spawn: { x: 17, y: 17 } }),
    ];
    const res = runBattle(7, specs, 'late', {
      objective: { kind: 'intercept', targetId: 'courier' },
      zone: { ...FAR },
    });
    expect(res.winner).toBe('party');
    expect(res.units.find((u) => u.id === 'courier')!.tags).toContain('quarry');
    expect(res.units.find((u) => u.id === 'far')!.alive).toBe(true);
  });
});

describe('объекты-юниты (inert)', () => {
  it('объект не действует: ни решений, ни ходов — но бьётся как юнит', () => {
    const specs = [
      dummy('grom', 'party', { atk: 12, spawn: { x: 2, y: 8 } }),
      dummy('totem', 'foe', { inert: true, maxHp: 20, atk: 0, move: 0, speed: 0, rules: [], spawn: { x: 3, y: 8 } }),
    ];
    const res = runBattle(7, specs, 'late', { objective: { kind: 'killTarget', targetId: 'totem' } });
    expect(res.winner).toBe('party');
    expect(ev(res.events, 'decision').some((e) => e.unit === 'totem')).toBe(false);
  });
});

describe('детерминизм сценариев волны 2', () => {
  it('тот же seed + та же задача = побайтово тот же лог (трофей)', () => {
    const node: Pick<MapNode, 'kind' | 'layer' | 'slot'> = { kind: 'fight', layer: 4, slot: 3 };
    const sc = scenarioForNode(node)!;
    const party = (): UnitSpec[] => [
      { ...heroSpec('grom', 0), rules: [atkNearest] } as UnitSpec,
    ];
    const a = runBattle(42, [...party(), ...sc.foes!()], 'late', sc.setup);
    const b = runBattle(42, [...party(), ...sc.foes!()], 'late', sc.setup);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });
});

/** Герой из пула с базовыми статами (конвенция objectives.test). */
function heroSpec(archId: string, slot: number): UnitSpec {
  const a = heroArchetype(archId);
  return {
    id: a.id,
    name: a.name,
    side: 'party',
    lenses: ['plain'],
    rules: [],
    maxHp: a.stats.maxHp,
    speed: a.stats.speed,
    move: a.stats.move,
    weapons: a.weapons,
    active: a.active,
    passives: a.passives,
    defenses: a.defenses,
    spawn: { ...PARTY_SPAWNS[slot]! },
  };
}

// ---- Слова задач ----

type CU = Parameters<typeof evalCondition>[1];

function unit(id: string, side: 'party' | 'foe', x: number, y: number, over: Partial<CU> = {}): CU {
  return {
    id,
    name: id,
    side,
    maxHp: 30,
    hp: 30,
    atk: 5,
    range: 1,
    speed: 5,
    move: 2,
    pos: { x, y },
    startPos: { x, y },
    alive: true,
    guard: 0,
    exposed: false,
    tags: [],
    lenses: ['plain'],
    ...over,
  } as CU;
}

const ground = { heightAt: () => 0, blocked: () => false };

describe('условия задач', () => {
  const zone = { x1: 0, y1: 6, x2: 2, y2: 11 };

  it('«я на рубеже» и «враг на рубеже» читают зону; без зоны молчат', () => {
    const me = unit('me', 'party', 1, 8);
    const foe = unit('e', 'foe', 1, 10);
    const units = [me, foe];
    expect(evalCondition({ kind: 'inZone' }, me, units, 1, { ...ground, zone })).toBe(true);
    expect(evalCondition({ kind: 'enemyInZone' }, me, units, 1, { ...ground, zone })).toBe(true);
    foe.pos = { x: 10, y: 10 };
    expect(evalCondition({ kind: 'enemyInZone' }, me, units, 1, { ...ground, zone })).toBe(false);
    me.pos = { x: 5, y: 5 };
    expect(evalCondition({ kind: 'inZone' }, me, units, 1, { ...ground, zone })).toBe(false);
    // без зоны — молчание, не ошибка
    expect(evalCondition({ kind: 'inZone' }, me, units, 1, ground)).toBe(false);
    expect(evalCondition({ kind: 'enemyInZone' }, me, units, 1, ground)).toBe(false);
  });

  it('«время на исходе»: последние раунды перед дедлайном; без таймера молчит', () => {
    const me = unit('me', 'party', 1, 8);
    const g = { ...ground, deadline: 8 };
    expect(evalCondition({ kind: 'timeShort' }, me, [me], 5, g)).toBe(false);
    expect(evalCondition({ kind: 'timeShort' }, me, [me], 6, g)).toBe(true);
    expect(evalCondition({ kind: 'timeShort' }, me, [me], 8, g)).toBe(true);
    expect(evalCondition({ kind: 'timeShort' }, me, [me], 8, ground)).toBe(false);
  });

  it('«трофей у наших»: тег carrier у любого из своих, включая меня', () => {
    const me = unit('me', 'party', 1, 8);
    const mate = unit('mate', 'party', 2, 8);
    expect(evalCondition({ kind: 'prizeHeld' }, me, [me, mate], 1, ground)).toBe(false);
    mate.tags.push('carrier');
    expect(evalCondition({ kind: 'prizeHeld' }, me, [me, mate], 1, ground)).toBe(true);
    mate.tags = [];
    me.tags.push('carrier');
    expect(evalCondition({ kind: 'prizeHeld' }, me, [me, mate], 1, ground)).toBe(true);
  });
});

describe('селектор «прорывающийся» и роли подопечного/носильщика', () => {
  const zone = { x1: 16, y1: 0, x2: 17, y2: 17 };

  it('intruder: враг в зоне, иначе ближайший к зоне, без зоны — ближайший ко мне', () => {
    const me = unit('me', 'party', 2, 8);
    const inside = unit('in', 'foe', 16, 8);
    const near = unit('near', 'foe', 12, 8);
    const close = unit('close', 'foe', 3, 8);
    const units = [me, inside, near, close];
    expect(resolveSelector('intruder', me, units, { ...ground, zone })?.id).toBe('in');
    inside.alive = false;
    expect(resolveSelector('intruder', me, units, { ...ground, zone })?.id).toBe('near');
    expect(resolveSelector('intruder', me, units)?.id).toBe('close');
  });

  it('роль ward берёт своего с тегом ward, carrier — с тегом carrier; некого — молчание', () => {
    const me = unit('me', 'party', 2, 8);
    const cart = unit('cart', 'party', 1, 8, { tags: ['ward'] });
    const porter = unit('porter', 'party', 3, 8, { tags: ['carrier'] });
    const units = [me, cart, porter];
    expect(resolveAlly({ role: 'ward' }, me, units)?.id).toBe('cart');
    expect(resolveAlly({ role: 'carrier' }, me, units)?.id).toBe('porter');
    expect(resolveAlly({ role: 'ward' }, me, [me, porter])).toBeUndefined();
    expect(resolveAlly({ role: 'carrier' }, me, [me, cart])).toBeUndefined();
  });

  it('вражеский селектор ward (внутренний): бьёт подопечного наших', () => {
    const foe = unit('f', 'foe', 5, 8);
    const cart = unit('cart', 'party', 1, 8, { tags: ['ward'] });
    const hero = unit('h', 'party', 4, 8);
    expect(resolveSelector('ward', foe, [foe, cart, hero])?.id).toBe('cart');
    expect(resolveSelector('ward', foe, [foe, hero])?.id).toBe('h');
  });
});

describe('скоринг слов задач', () => {
  const F = (u: CU) => ({ ...u, compiled: { rules: [] as Rule[], instincts: undefined } });

  it('«держать рубеж» ставит бойца в зону и держит его там', () => {
    const zone = { x1: 0, y1: 6, x2: 2, y2: 11 };
    const specs = [
      dummy('grom', 'party', { rules: [holdLine], spawn: { x: 6, y: 8 } }),
      dummy('slow', 'foe', { rules: [hold], move: 1, speed: 1, maxHp: 200, spawn: { x: 17, y: 17 } }),
    ];
    const res = runBattle(7, specs, 'late', { objective: { kind: 'holdZone', rounds: 4 }, zone });
    expect(res.winner).toBe('party');
    const moves = ev(res.events, 'move').filter((e) => e.unit === 'grom');
    const last = moves.at(-1)!;
    expect(last.to.x).toBeLessThanOrEqual(zone.x2);
    expect(last.to.y).toBeGreaterThanOrEqual(zone.y1);
    expect(last.to.y).toBeLessThanOrEqual(zone.y2);
  });

  it('«уходить к выходу» тянет через поле до самой зоны', () => {
    const zone = { x1: 16, y1: 0, x2: 17, y2: 17 };
    const specs = [
      dummy('grom', 'party', { rules: [evacuate], move: 2, spawn: { x: 8, y: 8 } }),
      dummy('slow', 'foe', { rules: [hold], move: 1, speed: 1, spawn: { x: 0, y: 0 } }),
    ];
    const res = runBattle(7, specs, 'late', { objective: { kind: 'reachZone', count: 1 }, zone });
    expect(res.winner).toBe('party');
    expect(ev(res.events, 'flee').length).toBe(1);
  });

  it('«нести трофей» ведёт к лежащей ноше и поднимает её', () => {
    const specs = [
      dummy('grom', 'party', { rules: [carryRule], move: 2, spawn: { x: 4, y: 9 } }),
      dummy('slow', 'foe', { rules: [hold], move: 1, speed: 1, maxHp: 200, spawn: { x: 17, y: 17 } }),
    ];
    const res = runBattle(7, specs, 'late', {
      objective: { kind: 'carry' },
      zone: { x1: 0, y1: 0, x2: 1, y2: 17 },
      prize: { x: 9, y: 9 },
    });
    expect(ev(res.events, 'pickup').map((e) => e.unit)).toEqual(['grom']);
  });
});

// ---- Парные смоуки «наив vs контр» (критерий плана: задача заставляет
// переписать принципы; числа замеров — в комментариях сценариев) ----

const taunt = r({ when: { kind: 'always' }, then: { kind: 'taunt' }, weight: 2, source: 'вызывать на себя' });
const nearWard = r({ when: { kind: 'always' }, then: { kind: 'nearTo', ref: { type: 'ally', id: { role: 'ward' } } }, weight: 1.5, source: 'держаться рядом с подопечным' });
const protectWard = r({ when: { kind: 'always' }, then: { kind: 'protect', ally: { role: 'ward' } }, weight: 1.5, source: 'прикрывать подопечного' });
const evacHard = r({ when: { kind: 'always' }, then: { kind: 'evacuate' }, weight: 3, source: 'уходить во что бы то ни стало' });
const atkIntruder = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'intruder' }, weight: 2, source: 'бить прорывающегося' });
const regroup = r({ when: { kind: 'always' }, then: { kind: 'regroup' }, weight: 1.5, source: 'сомкнуть строй' });
const braceSurrounded = r({ when: { kind: 'surrounded' }, then: { kind: 'brace' }, weight: 3, source: 'окружили — оборона' });

function heroFull(archId: string, slot: number, rules: Rule[], spawn = PARTY_SPAWNS[slot]!): UnitSpec {
  const a = heroArchetype(archId);
  return { ...heroSpec(archId, slot), rules: [...rules, ...a.innate], spawn: { ...spawn } };
}

interface SmokeStats {
  wins: number;
  rounds: number;
  deaths: number;
}

function smokeSweep(
  node: Pick<MapNode, 'kind' | 'layer' | 'slot'>,
  partyRules: [Rule[], Rule[], Rule[]],
  seeds = 20,
): SmokeStats {
  const sc = scenarioForNode(node)!;
  let wins = 0;
  let rounds = 0;
  let deaths = 0;
  for (let s = 1; s <= seeds; s++) {
    const party = (['grom', 'lia', 'zhalo'] as const).map((id, slot) =>
      heroFull(id, slot, partyRules[slot]!, sc.heroSpawns?.[slot] ?? PARTY_SPAWNS[slot]),
    );
    const res = runBattle(s * 17 + 3, [...party, ...(sc.allies?.() ?? []), ...sc.foes!()], 'late', sc.setup);
    if (res.winner === 'party') wins++;
    rounds += res.rounds;
    deaths += res.units.filter((u) => u.side === 'party' && !u.alive && !u.fled && !u.inert).length;
  }
  return { wins, rounds: rounds / seeds, deaths: deaths / seeds };
}

const NAIVE: [Rule[], Rule[], Rule[]] = [[atkNearest], [atkNearest], [atkNearest]];

describe('смоуки волны 2: наив vs контр', () => {
  it('оборона рубежа: наив пропускает бегунов за спину, «держать рубеж» держит', () => {
    const naive = smokeSweep({ kind: 'fight', layer: 2, slot: 0 }, NAIVE);
    const holdL = r({ when: { kind: 'always' }, then: { kind: 'holdLine' }, weight: 2, source: 'держать рубеж' });
    const held = smokeSweep({ kind: 'fight', layer: 2, slot: 0 }, [[holdL, atkNearest], [holdL, atkNearest], [holdL, atkNearest]]);
    expect(naive.wins).toBeLessThanOrEqual(15);
    expect(held.wins).toBeGreaterThanOrEqual(18);
  });

  it('обоз: волки обгоняют наив и рвут телегу; «прикрывать подопечного» спасает', () => {
    const naive = smokeSweep({ kind: 'fight', layer: 2, slot: 1 }, NAIVE);
    const guard = smokeSweep({ kind: 'fight', layer: 2, slot: 1 }, [[protectWard, atkNearest], [atkNearest], [protectWard, atkNearest]]);
    expect(naive.wins).toBeLessThanOrEqual(5);
    expect(guard.wins).toBeGreaterThanOrEqual(17);
  });

  it('свой ритуал: наив 0 — охота идёт мимо дерущихся; охрана чтеца решает', () => {
    const naive = smokeSweep({ kind: 'fight', layer: 2, slot: 2 }, NAIVE);
    const guard = smokeSweep({ kind: 'fight', layer: 2, slot: 2 }, [[protectWard, atkNearest], [atkNearest], [protectWard, atkNearest]]);
    expect(naive.wins).toBeLessThanOrEqual(3);
    expect(guard.wins).toBeGreaterThanOrEqual(17);
  });

  it('до рассвета: наив тонет в волнах, строй с обороной выстаивает', () => {
    const naive = smokeSweep({ kind: 'fight', layer: 2, slot: 3 }, NAIVE);
    const wallP = smokeSweep({ kind: 'fight', layer: 2, slot: 3 }, [
      [regroup, braceSurrounded, atkNearest],
      [regroup, atkNearest],
      [regroup, braceSurrounded, atkNearest],
    ]);
    expect(naive.wins).toBeLessThanOrEqual(12);
    expect(wallP.wins).toBeGreaterThanOrEqual(17);
    expect(wallP.deaths).toBeLessThan(naive.deaths);
  });

  it('диверсия: фокус на тотем вдвое быстрее резни охраны', () => {
    const naive = smokeSweep({ kind: 'fight', layer: 2, slot: 4 }, NAIVE);
    // метка на тотеме + «бить помеченного» — фокус мимо охраны
    const sc = scenarioForNode({ kind: 'fight', layer: 2, slot: 4 })!;
    const atkMarked = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'marked' }, weight: 2, source: 'бить помеченного' });
    let wins = 0;
    let rounds = 0;
    for (let s = 1; s <= 20; s++) {
      const party = (['grom', 'lia', 'zhalo'] as const).map((id, slot) => heroFull(id, slot, [atkMarked]));
      const foes = sc.foes!().map((f) => (f.id === 'totem' ? { ...f, tags: [...(f.tags ?? []), 'marked'] } : f));
      const res = runBattle(s * 17 + 3, [...party, ...foes], 'late', sc.setup);
      if (res.winner === 'party') wins++;
      rounds += res.rounds;
    }
    expect(naive.wins).toBeGreaterThanOrEqual(15); // наив побеждает, но платит временем
    expect(wins).toBeGreaterThanOrEqual(17);
    expect(rounds / 20).toBeLessThan(naive.rounds - 4);
  });

  it('прорыв: наив вязнет в ограх, решительный увод уходит без потерь', () => {
    const naive = smokeSweep({ kind: 'fight', layer: 4, slot: 0 }, NAIVE);
    const runners = smokeSweep({ kind: 'fight', layer: 4, slot: 0 }, [[evacHard], [evacHard], [evacHard]]);
    // порог поднят: с бросками (план damage-types) огры промахиваются чаще,
    // чем били всегда, и наив прорубается силой в двух боях из трёх — но
    // решительный увод по-прежнему уходит почти без исключений
    expect(naive.wins).toBeLessThanOrEqual(14);
    expect(runners.wins).toBeGreaterThanOrEqual(18);
    expect(runners.deaths).toBeLessThan(0.5);
  });

  it('отход с боем: стоять насмерть некому — увод против бесконечной погони', () => {
    const naive = smokeSweep({ kind: 'fight', layer: 4, slot: 1 }, NAIVE);
    const evac = r({ when: { kind: 'always' }, then: { kind: 'evacuate' }, weight: 2, source: 'уходить к выходу' });
    const leave = smokeSweep({ kind: 'fight', layer: 4, slot: 1 }, [[evac, atkNearest], [evac, atkNearest], [evac, atkNearest]]);
    expect(naive.wins).toBeLessThanOrEqual(4);
    expect(leave.wins).toBeGreaterThanOrEqual(17);
  });

  it('эскорт: «вызывать на себя» перекупает внимание охоты у старейшины', () => {
    const naive = smokeSweep({ kind: 'fight', layer: 4, slot: 2 }, NAIVE);
    const escortP = smokeSweep({ kind: 'fight', layer: 4, slot: 2 }, [
      [taunt, nearWard, atkNearest],
      [atkNearest],
      [atkNearest],
    ]);
    expect(naive.wins).toBeLessThanOrEqual(15);
    expect(escortP.wins).toBeGreaterThanOrEqual(17);
  });

  it('трофей: доставка крепким носильщиком кончает бой раньше резни', () => {
    // выборка шире обычной: на 20 сидах запас по раундам не отличим от шума
    const naive = smokeSweep({ kind: 'fight', layer: 4, slot: 3 }, NAIVE, 60);
    const carryZ = smokeSweep({ kind: 'fight', layer: 4, slot: 3 }, [[atkNearest], [atkNearest], [carryRule, atkNearest]], 60);
    // доставка по-прежнему кончает бой раньше резни, но премиса про победы
    // сместилась (план damage-types, замер 200 сидов): 144 победы против 158
    // у наива при 11.08 раунда против 13.74. С бросками часть забегов
    // «успеть» не успевает — зато носильщик реже платит смертями
    expect(carryZ.rounds).toBeLessThan(naive.rounds - 1.5);
    expect(carryZ.deaths).toBeLessThanOrEqual(naive.deaths);
  });

  it('погоня: наив рубит волков и упускает гонца; «прорывающийся» перехватывает', () => {
    // выборка расширена до 60 сидов (план armor): оборона переехала в бонусы
    // к КБ, гонец стал живучее в бросках, и на 20 сидах разрыв слова и наива
    // (2 против 6 побед) уже неотличим от шума. На 60 сидах слово по-прежнему
    // утраивает шансы перехвата
    const naive = smokeSweep({ kind: 'fight', layer: 4, slot: 4 }, NAIVE, 60);
    const chaseP = smokeSweep({ kind: 'fight', layer: 4, slot: 4 }, [[atkIntruder], [atkIntruder], [atkIntruder]], 60);
    expect(naive.wins).toBeLessThanOrEqual(15);
    expect(chaseP.wins).toBeGreaterThanOrEqual(naive.wins + 8);
  });
});

// ---- Конструктор, схема, пулы ----

describe('слова задач: конструктор и схема', () => {
  it('фразы компилируются и читаются', () => {
    const a = compilePhrase(
      { condition: { id: 'cond.enemyInZone' }, preference: { id: 'space.holdLine' } },
      FULL_VOCAB,
    );
    expect(a.ok && a.rule.then.kind).toBe('holdLine');
    expect(a.ok && a.rule.source).toBe('если враг на рубеже: держать рубеж');
    const b = compilePhrase(
      { condition: { id: 'cond.timeShort' }, preference: { id: 'act.evacuate' } },
      FULL_VOCAB,
    );
    expect(b.ok && b.rule.source).toBe('если время на исходе: уходить к выходу');
    const c = compilePhrase(
      { condition: { id: 'cond.prizeHeld' }, preference: { id: 'act.protect', ally: { role: 'carrier' } } },
      FULL_VOCAB,
    );
    expect(c.ok && c.rule.source).toBe('пока трофей у наших: защищать нашего носильщика');
    const d = compilePhrase(
      { condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.intruder' } },
      FULL_VOCAB,
    );
    expect(d.ok && d.rule.source).toBe('атаковать: прорывающийся');
  });

  it('закрытые слова — ошибка компиляции, роль требует своё слово', () => {
    const closed = compilePhrase(
      { condition: { id: 'cond.inZone' }, preference: { id: 'act.carry' } },
      ['act.carry'],
    );
    expect(closed).toEqual({ ok: false, missing: ['cond.inZone'] });
    const role = compilePhrase(
      { condition: { id: 'always' }, preference: { id: 'act.protect', ally: { role: 'ward' } } },
      ['act.protect'],
    );
    expect(role).toEqual({ ok: false, missing: ['sel.allyWard'] });
  });

  it('схема компилятора несёт слова задач только при открытом словаре', () => {
    const schema = JSON.stringify(buildCompileSchema(FULL_VOCAB, ['grom']));
    for (const w of ['cond.inZone', 'cond.timeShort', 'sel.intruder', 'space.holdLine', 'act.evacuate', 'act.carry']) {
      expect(schema).toContain(w);
    }
    expect(JSON.stringify(buildCompileSchema(['act.attack', 'sel.nearest'], ['grom']))).not.toContain('holdLine');
    const out = validateOutput(
      { phrases: [{ condition: { id: 'cond.inZone' }, preference: { id: 'space.holdLine' }, weight: 1 }], uncertainty: [] },
      FULL_VOCAB,
      ['grom'],
      4,
    );
    expect(out.ok).toBe(true);
    const bad = validateOutput(
      { phrases: [{ condition: { id: 'cond.inZone' }, preference: { id: 'space.holdLine' }, weight: 1 }], uncertainty: [] },
      ['space.holdLine'],
      ['grom'],
      4,
    );
    expect(bad.ok).toBe(false);
  });

  it('пулы: базовый пласт — обычные, событийный и трофейный — редкие', () => {
    for (const w of ['cond.inZone', 'cond.enemyInZone', 'sel.allyWard', 'space.holdLine', 'act.evacuate'] as ConceptId[]) {
      expect(COMMON_WORDS).toContain(w);
    }
    for (const w of ['cond.timeShort', 'cond.prizeHeld', 'sel.allyCarrier', 'sel.intruder', 'act.carry'] as ConceptId[]) {
      expect(RARE_WORDS).toContain(w);
    }
    for (const w of ['cond.inZone', 'act.carry'] as ConceptId[]) expect(UNLOCKABLE).toContain(w);
  });
});
