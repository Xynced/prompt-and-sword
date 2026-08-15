import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import { type Fighter, attackBonusOf, decide, dmgTypeOf, makeCtx, movesOf, weaponsOf } from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { heroArchetype } from '../src/heroes.js';
import { applyDefenses, d20, degreeOf } from '../src/tuning.js';
import type { CombatUnit, Defenses, Pos, Side, WeaponSpec } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Защиты и типы урона (план damage-types, шаг 1): тип живёт на оружии, точный
 * тип — на приёме; сопротивления, слабости и иммунитеты — плоские числа в
 * порядке pf2e. Пилот выбора оружия под врага — Яр (копьё/меч/молот = три
 * физических типа).
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

const attacks = (events: readonly BattleEvent[], unit: string): Extract<BattleEvent, { t: 'attack' }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: 'attack' }> => e.t === 'attack' && e.unit === unit);

const spec = (over: Partial<UnitSpec> & Pick<UnitSpec, 'id' | 'side'>): UnitSpec => ({
  name: over.id,
  maxHp: 60,
  atk: 8,
  range: 1,
  speed: 5,
  move: 2,
  lenses: ['plain'],
  rules: [rule({ kind: 'attack', target: 'nearest' })],
  ...over,
});

describe('порядок применения защит (pf2e)', () => {
  it('иммунитет обнуляет урон — даже общий пол «минимум 1»', () => {
    expect(applyDefenses(7, 'fire', { immune: ['fire'] })).toEqual({ dmg: 0, soak: 'immune' });
    expect(applyDefenses(1, 'fire', { immune: ['fire'] }).dmg).toBe(0);
  });

  it('слабость прибавляет плоско, сопротивление отнимает плоско', () => {
    expect(applyDefenses(5, 'bludgeoning', { weak: { bludgeoning: 3 } })).toEqual({ dmg: 8, soak: 'weak' });
    expect(applyDefenses(5, 'slashing', { resist: { slashing: 2 } })).toEqual({ dmg: 3, soak: 'resist' });
  });

  it('слабость и сопротивление к одному типу складываются, не ниже нуля', () => {
    expect(applyDefenses(5, 'acid', { weak: { acid: 3 }, resist: { acid: 1 } }).dmg).toBe(7);
    expect(applyDefenses(2, 'acid', { resist: { acid: 5 } }).dmg).toBe(0);
  });

  it('иммунитет сильнее слабости: сначала он', () => {
    expect(applyDefenses(5, 'fire', { immune: ['fire'], weak: { fire: 4 } }).dmg).toBe(0);
  });

  it('урон без типа защиты не задевают — старые юниты как были', () => {
    expect(applyDefenses(5, undefined, { resist: { slashing: 3 }, immune: ['fire'] })).toEqual({ dmg: 5 });
    expect(applyDefenses(5, 'cold', { resist: { slashing: 3 } })).toEqual({ dmg: 5 });
  });
});

describe('тип урона: оружие и приём', () => {
  it('приём перебивает оружие — щит дробит, меч рубит', () => {
    const grom = heroArchetype('grom');
    const sword = grom.weapons[0]!;
    const jab = movesOf(sword).find((m) => m.id === 'shieldJab')!;
    const cut = movesOf(sword).find((m) => m.id === 'trueCut')!;
    expect(sword.dmgType).toBe('slashing');
    expect(dmgTypeOf(sword, jab)).toBe('bludgeoning');
    expect(dmgTypeOf(sword, cut)).toBe('slashing');
  });

  it('у мастера трёх оружий три разных физических типа', () => {
    const yar = heroArchetype('yar');
    expect(yar.weapons.map((w) => w.dmgType).sort()).toEqual(['bludgeoning', 'piercing', 'slashing']);
  });

  it('дефолт-тройка безымянного оружия остаётся без типа', () => {
    const bare: WeaponSpec = { name: 'палка', dmg: 5, range: 1 };
    expect(movesOf(bare).every((m) => dmgTypeOf(bare, m) === undefined)).toBe(true);
  });
});

describe('защиты в бою', () => {
  const bones: Defenses = { resist: { slashing: 3 }, weak: { bludgeoning: 3 } };

  it('иммунная цель не получает ничего, и событие это называет', () => {
    const res = runBattle(7, [
      spec({ id: 'ulv', side: 'party', weapons: [heroArchetype('ulv').weapons[0]!], spawn: { x: 8, y: 8 } }),
      spec({
        id: 'ghost',
        side: 'foe',
        maxHp: 60,
        defenses: { immune: ['slashing', 'bludgeoning', 'piercing'] },
        spawn: { x: 9, y: 8 },
      }),
    ]);
    // промах тоже даёт ноль — иммунитет считаем по дошедшим ударам
    const landed = attacks(res.events, 'ulv').filter((h) => h.outcome !== 'miss');
    expect(landed.length).toBeGreaterThan(0);
    expect(landed.every((h) => h.dmg === 0)).toBe(true);
    expect(landed.every((h) => h.soak === 'immune')).toBe(true);
    expect(landed[0]!.dmgType).toBeDefined();
    expect(res.units.find((u) => u.id === 'ghost')!.hp).toBe(60);
  });

  it('слабость к дробящему бьёт больнее, сопротивление рубящему — слабее', () => {
    const yar = heroArchetype('yar');
    // сравниваем дошедшие удары: у промаха урона нет вовсе, и защиты по типу
    // на нём не видны. Бросок привязан к моменту боя, поэтому «тот же удар» в
    // двух прогонах — это буквально тот же бросок, отличаются только защиты
    const run = (defenses: Defenses | undefined, weapon: number): Extract<BattleEvent, { t: 'attack' }>[] =>
      attacks(
        runBattle(11, [
          spec({ id: 'yar', side: 'party', weapons: [yar.weapons[weapon]!], spawn: { x: 8, y: 8 } }),
          spec({ id: 'foe', side: 'foe', maxHp: 200, defenses, spawn: { x: 9, y: 8 } }),
        ]).events,
        'yar',
      ).filter((a) => a.outcome !== 'miss');
    const plainHammer = run(undefined, 2);
    const weakHammer = run(bones, 2);
    const plainSword = run(undefined, 1);
    const resistSword = run(bones, 1);
    expect(weakHammer[0]!.dmg).toBe(plainHammer[0]!.dmg + 3);
    expect(weakHammer[0]!.soak).toBe('weak');
    expect(resistSword[0]!.dmg).toBe(plainSword[0]!.dmg - 3);
    expect(resistSword[0]!.soak).toBe('resist');
  });

  it('огненный ритуал не берёт иммунного к огню', () => {
    const vesta = heroArchetype('vesta');
    const res = runBattle(3, [
      spec({
        id: 'vesta',
        side: 'party',
        weapons: [vesta.weapons[0]!],
        spawn: { x: 8, y: 8 },
        rules: [rule({ kind: 'castRitual' }), rule({ kind: 'attack', target: 'nearest' }, 1)],
      }),
      spec({ id: 'ash', side: 'foe', maxHp: 80, defenses: { immune: ['fire'] }, spawn: { x: 11, y: 8 } }),
    ]);
    const burns = res.events.filter(
      (e): e is Extract<BattleEvent, { t: 'aoeHit' }> => e.t === 'aoeHit' && e.unit === 'ash',
    );
    expect(burns.length).toBeGreaterThan(0);
    expect(burns.every((b) => b.dmg === 0 && b.soak === 'immune' && b.dmgType === 'fire')).toBe(true);
  });
});

describe('скоринг видит защиты цели', () => {
  it('мастер трёх оружий меняет инструмент под броню врага', () => {
    const yar = heroArchetype('yar');
    const self = fighter(
      'yar',
      'party',
      { x: 8, y: 8 },
      { weapons: yar.weapons, atk: 8, range: 2 },
      [rule({ kind: 'attack', target: 'nearest' })],
    );
    const foeWith = (defenses?: Defenses): Fighter =>
      fighter('foe', 'foe', { x: 9, y: 8 }, { maxHp: 60, hp: 60, ...(defenses ? { defenses } : {}) });
    const pick = (target: Fighter): string | undefined => {
      const d = decide(self, [self, target], 1, undefined, 3, makeCtx());
      return d.chosen.weapon === undefined ? undefined : weaponsOf(self)[d.chosen.weapon]!.name;
    };
    // без защит выбирается самое сильное оружие — молот
    expect(pick(foeWith())).toBe('молот');
    // шкура держит дробящее и не держит колющее — Яр берётся за копьё
    expect(pick(foeWith({ resist: { bludgeoning: 3 }, weak: { piercing: 3 } }))).toBe('копьё');
    // латы держат колющее и рубящее — обратно к молоту
    expect(pick(foeWith({ resist: { piercing: 3, slashing: 3 } }))).toBe('молот');
  });
});

describe('бросок принадлежит моменту боя, а не порядку вызовов', () => {
  it('d20: тот же ключ — тот же бросок, соседние ключи независимы', () => {
    expect(d20(7, 'grom', 2, 3, 'atk:foe:cut')).toBe(d20(7, 'grom', 2, 3, 'atk:foe:cut'));
    const keys = new Set([
      d20(7, 'grom', 2, 3, 'atk:foe:cut'),
      d20(7, 'grom', 2, 2, 'atk:foe:cut'),
      d20(7, 'grom', 3, 3, 'atk:foe:cut'),
      d20(7, 'lia', 2, 3, 'atk:foe:cut'),
      d20(8, 'grom', 2, 3, 'atk:foe:cut'),
    ]);
    expect(keys.size).toBeGreaterThanOrEqual(3);
  });

  it('d20 покрывает все двадцать граней примерно поровну', () => {
    const counts = new Array<number>(21).fill(0);
    for (let round = 1; round <= 400; round++) {
      for (let ap = 1; ap <= 5; ap++) counts[d20(1, 'u', round, ap, 'atk')] += 1;
    }
    expect(counts[0]).toBe(0);
    for (let face = 1; face <= 20; face++) {
      expect(counts[face]).toBeGreaterThan(50); // ожидание 100 на грань
      expect(counts[face]).toBeLessThan(160);
    }
  });

  it('исход удара в логе восстанавливается из ключа: кто, когда, на каком AP и по кому', () => {
    const sword = heroArchetype('yar').weapons[1]!;
    const res = runBattle(5, [
      spec({ id: 'a', side: 'party', weapons: [sword], spawn: { x: 3, y: 3 } }),
      spec({ id: 'b', side: 'foe', maxHp: 90, defenses: { ac: 17 }, spawn: { x: 4, y: 3 } }),
    ]);
    const first = attacks(res.events, 'a')[0]!;
    // первый удар первого раунда: все три очка хода ещё на месте
    const natural = d20(5, 'a', 1, 3, `atk:b:${movesOf(sword).find((m) => m.slot === first.action)!.id}`);
    const degree = degreeOf(natural, natural + attackBonusOf(sword), 17);
    expect(first.outcome ?? (degree === 'success' ? undefined : 'что-то не так')).toBe(
      degree === 'critSuccess' ? 'crit' : degree === 'success' ? undefined : 'miss',
    );
  });
});
