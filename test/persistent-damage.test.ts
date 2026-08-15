import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import {
  type Fighter,
  candMove,
  douseGain,
  makeCtx,
  movesOf,
  persistGain,
  scoreCandidate,
  weaponsOf,
} from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { heroArchetype } from '../src/heroes.js';
import { PERSIST_DC, PERSIST_DC_ASSISTED, d20, persistTicks } from '../src/tuning.js';
import type { CombatUnit, Pos, Side, WeaponSpec } from '../src/types.js';
import type { Rule } from '../src/ir.js';
import { evalCondition } from '../src/ir.js';
import { CONCEPTS, RARE_WORDS } from '../src/vocab.js';
import { compilePhrase, describeDraft } from '../src/constructor.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import { ruleRu } from '../src/cards.js';

/**
 * Длящийся урон (план damage-types, волна 6): горение, кровь и яд тикают в
 * конце хода жертвы и гасятся флэт-чеком pf2e; помощь («сбить пламя») роняет
 * DC. Отдельный файл, а не хвост damage-types.test: это свой канал урона со
 * своим временем и своим способом снятия.
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

/** Факел: единственный приём — поджигающий удар, чтобы тление читалось в логе. */
const torch = (dmg = 4, persistDmg = 2, atkBonus = 20): WeaponSpec => ({
  name: 'факел',
  dmg,
  range: 1,
  dmgType: 'fire',
  atkBonus, // бьёт всегда: тест про тление, а не про броски
  moves: [{ id: 'torchJab', name: 'ткнуть факелом', slot: 'weakAttack', mult: 1, persist: { dmg: persistDmg } }],
});

/**
 * КБ цели, при котором удар с бонусом 20 всегда доходит, но никогда не критует
 * (нужно ≥ КБ+10, то есть 21 против 30 не хватает): тление вешается ровно
 * райдером, без удвоения.
 */
const NO_CRIT_AC = 30;
/** Зеркало: КБ, по которому тот же удар всегда критует — тление удваивается. */
const ALWAYS_CRIT_AC = 5;

const evs = <T extends BattleEvent['t']>(events: readonly BattleEvent[], t: T): Extract<BattleEvent, { t: T }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: T }> => e.t === t);

describe('тление занимается ударом и тикает в конце хода', () => {
  it('дошедший поджигающий удар вешает тление, тик приходит в конце хода жертвы', () => {
    const res = runBattle(5, [
      spec({ id: 'torchbearer', side: 'party', weapons: [torch()], spawn: { x: 8, y: 8 } }),
      spec({ id: 'foe', side: 'foe', maxHp: 400, defenses: { ac: NO_CRIT_AC }, spawn: { x: 9, y: 8 } }),
    ]);
    const started = evs(res.events, 'persistStart');
    expect(started.length).toBeGreaterThan(0);
    expect(started[0]!.dmgType).toBe('fire');
    const ticks = evs(res.events, 'persist').filter((e) => e.unit === 'foe');
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0]!.dmg).toBe(2);
    // тик стоит в конце хода жертвы: между её решением и решением следующего
    const idx = res.events.indexOf(ticks[0]!);
    const before = res.events.slice(0, idx).filter((e) => e.t === 'decision');
    expect(before[before.length - 1]!.t).toBe('decision');
    expect((before[before.length - 1] as Extract<BattleEvent, { t: 'decision' }>).unit).toBe('foe');
  });

  it('крит удваивает тление (правило pf2e)', () => {
    const res = runBattle(5, [
      spec({ id: 'torchbearer', side: 'party', weapons: [torch()], spawn: { x: 8, y: 8 } }),
      spec({ id: 'foe', side: 'foe', maxHp: 400, defenses: { ac: ALWAYS_CRIT_AC }, spawn: { x: 9, y: 8 } }),
    ]);
    expect(evs(res.events, 'persistStart')[0]!.dmg).toBe(4);
    expect(evs(res.events, 'persist').filter((e) => e.unit === 'foe')[0]!.dmg).toBe(4);
  });

  it('тот же тип не складывается: повторный поджог горящего событий не даёт', () => {
    const res = runBattle(5, [
      spec({ id: 'torchbearer', side: 'party', weapons: [torch()], spawn: { x: 8, y: 8 } }),
      spec({ id: 'foe', side: 'foe', maxHp: 400, spawn: { x: 9, y: 8 } }),
    ]);
    // между двумя занятиями огня обязан стоять хотя бы один persistEnd
    const marks = res.events.filter((e) => e.t === 'persistStart' || e.t === 'persistEnd');
    for (let i = 1; i < marks.length; i++) {
      if (marks[i]!.t === 'persistStart') expect(marks[i - 1]!.t).toBe('persistEnd');
    }
  });

  it('иммунный к типу не загорается вовсе, сопротивление режет каждый тик', () => {
    const burn = (defenses: UnitSpec['defenses']): BattleEvent[] =>
      runBattle(5, [
        spec({ id: 'torchbearer', side: 'party', weapons: [torch()], spawn: { x: 8, y: 8 } }),
        spec({ id: 'foe', side: 'foe', maxHp: 400, defenses, spawn: { x: 9, y: 8 } }),
      ]).events;
    expect(evs(burn({ ac: NO_CRIT_AC, immune: ['fire'] }), 'persistStart')).toHaveLength(0);
    // натуральная 20 поднимает степень до крита даже по неподъёмному КБ,
    // поэтому вешается 2 или 4 — сопротивление обязано срезать любой тик на 1
    const events = burn({ ac: NO_CRIT_AC, resist: { fire: 1 } });
    const lit = new Set(evs(events, 'persistStart').map((e) => e.dmg));
    const resisted = evs(events, 'persist').filter((e) => e.unit === 'foe');
    expect(resisted.length).toBeGreaterThan(0);
    expect(resisted.every((e) => e.soak === 'resist' && lit.has(e.dmg + 1))).toBe(true);
  });

  it('тление добивает: смерть от тика — обычная смерть боя', () => {
    const res = runBattle(5, [
      spec({ id: 'torchbearer', side: 'party', weapons: [torch(1, 3)], spawn: { x: 8, y: 8 } }),
      spec({ id: 'foe', side: 'foe', maxHp: 6, spawn: { x: 9, y: 8 }, rules: [rule({ kind: 'holdPosition' })] }),
    ]);
    const ticks = evs(res.events, 'persist').filter((e) => e.unit === 'foe');
    const died = res.events.findIndex((e) => e.t === 'die');
    // последний тик стоит вплотную перед смертью — цель догорела
    expect(ticks.length).toBeGreaterThan(0);
    if (ticks[ticks.length - 1]!.hp === 0) expect(res.events[died - 1]).toBe(ticks[ticks.length - 1]);
  });
});

describe('флэт-чек гашения и помощь', () => {
  it('проверка идёт по DC 15, помощь — по DC 10 (числа pf2e)', () => {
    expect(PERSIST_DC).toBe(15);
    expect(PERSIST_DC_ASSISTED).toBe(10);
    // ожидание тиков — геометрия флэт-чека: 3.3 против 1.8
    expect(persistTicks(PERSIST_DC)).toBeCloseTo(10 / 3, 5);
    expect(persistTicks(PERSIST_DC_ASSISTED)).toBeCloseTo(20 / 11, 5);
  });

  it('бросок гашения принадлежит моменту боя, а не порядку вызовов', () => {
    expect(d20(9, 'foe', 3, 0, 'persist:fire')).toBe(d20(9, 'foe', 3, 0, 'persist:fire'));
    expect(d20(9, 'foe', 3, 0, 'persist:fire')).not.toBe(d20(9, 'foe', 4, 0, 'persist:fire'));
  });

  it('помощь и вправду решает: гаснет бросок, которого не хватило бы на DC 15', () => {
    const seed = 12;
    const res = runBattle(seed, [
      spec({
        id: 'burned',
        side: 'party',
        maxHp: 120,
        spawn: { x: 8, y: 8 },
        rules: [rule({ kind: 'douse' }, 3), rule({ kind: 'attack', target: 'nearest' }, 1)],
      }),
      spec({ id: 'pyro', side: 'foe', maxHp: 200, weapons: [torch(3, 2)], spawn: { x: 9, y: 8 } }),
    ]);
    // раунд каждого гашения — из ленты событий; бросок пересчитываем ключом
    let round = 0;
    const helped: number[] = [];
    for (const e of res.events) {
      if (e.t === 'round') round = e.n;
      if (e.t === 'persistEnd' && e.assisted) helped.push(d20(seed, e.unit, round, 0, `persist:${e.dmgType}`));
    }
    expect(helped.length).toBeGreaterThan(0);
    // хотя бы раз помощь и решила: бросок ниже обычного DC, но выше сниженного
    expect(helped.some((n) => n < PERSIST_DC && n >= PERSIST_DC_ASSISTED)).toBe(true);
  });

  it('помощь действует на одну проверку: assisted в событии гашения', () => {
    const res = runBattle(12, [
      spec({
        id: 'burned',
        side: 'party',
        maxHp: 120,
        spawn: { x: 8, y: 8 },
        rules: [rule({ kind: 'douse' }, 3), rule({ kind: 'attack', target: 'nearest' }, 1)],
      }),
      spec({ id: 'pyro', side: 'foe', maxHp: 200, weapons: [torch(3, 2)], spawn: { x: 9, y: 8 } }),
    ]);
    expect(evs(res.events, 'douse').length).toBeGreaterThan(0);
    expect(evs(res.events, 'persistEnd').some((e) => e.assisted)).toBe(true);
  });
});

describe('регенерация гаснет от огня и кислоты (pf2e)', () => {
  it('огонь съедает ближайший тик заращивания, без огня тролль зарастает', () => {
    const trollFight = (weapon: WeaponSpec): BattleEvent[] =>
      runBattle(4, [
        spec({ id: 'hero', side: 'party', maxHp: 200, weapons: [weapon], spawn: { x: 8, y: 8 } }),
        spec({
          id: 'troll',
          side: 'foe',
          maxHp: 120,
          hp: 60,
          atk: 6,
          passives: { regen: { amount: 8 } },
          spawn: { x: 9, y: 8 },
        }),
      ]).events;
    const steel: WeaponSpec = {
      name: 'меч',
      dmg: 6,
      range: 1,
      dmgType: 'slashing',
      atkBonus: 20,
      moves: [{ id: 'cut', name: 'рубить', slot: 'weakAttack', mult: 1 }],
    };
    const withFire = evs(trollFight(torch(6, 1)), 'regen');
    const withSteel = evs(trollFight(steel), 'regen');
    expect(withFire.some((e) => e.quenched)).toBe(true);
    expect(withSteel.every((e) => !e.quenched)).toBe(true);
  });
});

describe('скоринг видит тление', () => {
  it('по горящей цели прибавки нет — поджигатель идёт к следующему', () => {
    const target = fighter('foe', 'foe', { x: 9, y: 8 }, { maxHp: 60, hp: 60 });
    const spec6 = { dmg: 2 } as const;
    expect(persistGain(spec6, 'fire', target)).toBeCloseTo(2 * persistTicks(), 5);
    target.persist = [{ type: 'fire', dmg: 2 }];
    expect(persistGain(spec6, 'fire', target)).toBe(0);
    // иммунному тление не грозит
    const ash = fighter('ash', 'foe', { x: 9, y: 8 }, { defenses: { immune: ['fire'] } });
    expect(persistGain(spec6, 'fire', ash)).toBe(0);
  });

  it('поджигающий приём Весты дороже по нетронутому, чем по уже горящему', () => {
    const vesta = heroArchetype('vesta');
    const self = fighter(
      'vesta',
      'party',
      { x: 8, y: 8 },
      { weapons: vesta.weapons, atk: 6, range: 4 },
      [rule({ kind: 'attack', target: 'nearest' })],
    );
    const burning = fighter('burning', 'foe', { x: 9, y: 8 }, { maxHp: 60, hp: 60, persist: [{ type: 'fire', dmg: 1 }] });
    const fresh = fighter('fresh', 'foe', { x: 9, y: 9 }, { maxHp: 60, hp: 60 });
    const units = [self, burning, fresh];
    const ignite = movesOf(weaponsOf(self)[0]!).findIndex((m) => m.id === 'vestaIgnite');
    expect(ignite).toBeGreaterThanOrEqual(0);
    const sum = (targetId: string): number =>
      scoreCandidate(
        { to: self.pos, action: 'attack', targetId, move: ignite },
        self,
        units,
        [],
        makeCtx(),
      ).reduce((a, f) => a + f.value, 0);
    expect(sum('fresh')).toBeGreaterThan(sum('burning'));
    // и приём, который выбирает бой, — тот самый «поджечь»
    expect(candMove(self, { to: self.pos, action: 'attack', targetId: 'fresh', move: ignite }).name).toBe(
      'поджечь',
    );
  });

  it('горящий сбивает пламя сам: цена помощи — спасённый урон', () => {
    const hurt = fighter('hurt', 'party', { x: 8, y: 8 }, { maxHp: 30, hp: 12, persist: [{ type: 'fire', dmg: 3 }] });
    expect(douseGain(hurt)).toBeGreaterThan(0);
    // помощь уже подоспела — второй раз ничего не покупает
    const helped = fighter('helped', 'party', { x: 8, y: 8 }, { persist: [{ type: 'fire', dmg: 3, assisted: true }] });
    expect(douseGain(helped)).toBe(0);
  });
});

describe('слова волны 6', () => {
  it('«на мне тлеет» горит ровно тогда, когда на юните тлеет', () => {
    const clean = fighter('a', 'party', { x: 8, y: 8 });
    const burning = fighter('b', 'party', { x: 8, y: 9 }, { persist: [{ type: 'poison', dmg: 1 }] });
    expect(evalCondition({ kind: 'smoldering' }, clean, [clean, burning], 1)).toBe(false);
    expect(evalCondition({ kind: 'smoldering' }, burning, [clean, burning], 1)).toBe(true);
  });

  it('оба концепта проходят конструктор, схему компилятора и карточку', () => {
    expect(CONCEPTS['act.douse'].category).toBe('action');
    expect(CONCEPTS['cond.smoldering'].category).toBe('condition');
    expect(RARE_WORDS).toContain('act.douse');
    expect(RARE_WORDS).toContain('cond.smoldering');
    const draft = {
      condition: { id: 'cond.smoldering' as const },
      preference: { id: 'act.douse' as const },
    };
    const out = compilePhrase(draft, ['cond.smoldering', 'act.douse']);
    expect(out.ok && out.rule.when).toEqual({ kind: 'smoldering' });
    expect(out.ok && out.rule.then).toEqual({ kind: 'douse' });
    expect(describeDraft(draft)).toBe('пока на мне тлеет: сбивать пламя');
    expect(out.ok && ruleRu(out.rule)).toContain('сбива');
    // закрытое слово компилятору недоступно
    expect(compilePhrase(draft, ['act.douse']).ok).toBe(false);

    const schema = buildCompileSchema(['cond.smoldering', 'act.douse'], []);
    expect(JSON.stringify(schema)).toContain('act.douse');
    expect(
      validateOutput(
        {
          phrases: [{ condition: { id: 'cond.smoldering' }, preference: { id: 'act.douse' }, weight: 2 }],
          uncertainty: [],
        },
        ['cond.smoldering', 'act.douse'],
        [],
        4,
      ).ok,
    ).toBe(true);
  });
});
