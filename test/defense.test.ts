import { describe, expect, it } from 'vitest';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { isFlanking } from '../src/grid.js';
import { duelist, soldier, thug, wolf } from '../src/foes.js';
import { COVER, RIPOSTE_DMG } from '../src/tuning.js';
import { type Fighter, generateCandidates } from '../src/scoring.js';
import { applyLens } from '../src/lens.js';
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
    defenses: a.defenses,
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

describe('перехват телохранителя', () => {
  const protectWard = r({ when: { kind: 'always' }, then: { kind: 'protect', ally: 'ward' }, weight: 2, source: 'защищай подопечного' });
  const scene = (guardRules: Rule[], guardLenses: UnitSpec['lenses'] = ['plain']): UnitSpec[] => [
    // толстые тела и move 0: сцена меряет перехват, не исход
    { id: 'ward', name: 'ward', side: 'party', maxHp: 600, atk: 5, range: 1, speed: 4, move: 0, lenses: ['plain'], rules: [atkNearest], spawn: { x: 5, y: 8 } },
    { id: 'guard', name: 'guard', side: 'party', maxHp: 600, atk: 5, range: 1, speed: 3, move: 0, lenses: guardLenses, rules: guardRules, spawn: { x: 5, y: 7 } },
    { id: 'foe1', name: 'foe1', side: 'foe', maxHp: 600, atk: 6, range: 1, speed: 7, move: 0, lenses: ['plain'], rules: [atkNearest], spawn: { x: 6, y: 9 } },
  ];
  const firstRound = (events: readonly BattleEvent[]): BattleEvent[] => {
    const out: BattleEvent[] = [];
    let round = 0;
    for (const e of events) {
      if (e.t === 'round') round = e.n;
      if (round === 1) out.push(e);
    }
    return out;
  };

  it('страж со сработавшим «защищать» принимает первый удар; второй в том же раунде проходит', () => {
    const res = runBattle(5, scene([protectWard]));
    const r1 = firstRound(res.events);
    const foeHits = r1.filter((e): e is Extract<BattleEvent, { t: 'attack' }> => e.t === 'attack' && e.unit === 'foe1');
    expect(r1.some((e) => e.t === 'intercept' && e.unit === 'guard' && e.target === 'ward')).toBe(true);
    expect(foeHits[0]!.target).toBe('guard'); // первый удар перехвачен
    expect(foeHits.slice(1).some((e) => e.target === 'ward')).toBe(true); // перехват один в раунд
  });

  it('правило на другого подопечного не перехватывает', () => {
    const other = r({ when: { kind: 'always' }, then: { kind: 'protect', ally: 'foe-other' }, weight: 2, source: 'защищай другого' });
    const res = runBattle(5, scene([other, atkNearest]));
    expect(res.events.some((e) => e.t === 'intercept')).toBe(false);
  });

  it('несработавшее условие — нет перехвата', () => {
    const gated = r({ when: { kind: 'hpBelow', who: 'self', frac: 0.01 }, then: { kind: 'protect', ally: 'ward' }, weight: 2, source: 'защищай при смерти' });
    const res = runBattle(5, scene([gated, atkNearest]));
    expect(res.events.some((e) => e.t === 'intercept')).toBe(false);
  });

  it('трус-телохранитель работает, пока цел: потрёпанный бросает пост (план линз)', () => {
    // расщепление труса: protect живёт под hpAbove 50% — перехват гаснет вместе с ним
    const specs = scene([protectWard, atkNearest], ['coward']);
    specs[1] = { ...specs[1]!, maxHp: 40 };
    const res = runBattle(5, specs);
    const events = res.events;
    expect(events.some((e) => e.t === 'intercept' && e.unit === 'guard')).toBe(true);
    // индекс удара, уронившего стража ниже 50% (20 hp)
    let below = -1;
    events.forEach((e, i) => {
      if (below < 0 && e.t === 'attack' && e.target === 'guard' && e.targetHp < 20) below = i;
    });
    expect(below).toBeGreaterThan(-1);
    expect(events.slice(below + 1).some((e) => e.t === 'intercept' && e.unit === 'guard')).toBe(false);
  });

  it('смоук: связка «прикрывай Лию» + «Лия в строю» бьёт засаду; охранять бегающую нельзя', () => {
    const ambush = () => [thug(), wolf(1), wolf(2)];
    const naive = () => [
      hero('grom', 0, [atkNearest]),
      hero('lia', 1, [atkNearest]),
      hero('zhalo', 2, [atkNearest]),
    ];
    // двусторонняя дисциплина: страж прикрывает, подопечный держится рядом —
    // перехват и щит работают только вплотную, и «Лия в строю» держит их живыми
    const pair = () => [
      hero('grom', 0, [atkNearest, r({ when: { kind: 'always' }, then: { kind: 'protect', ally: 'lia' }, weight: 1.5, source: 'прикрывай Лию' })]),
      hero('lia', 1, [atkNearest, r({ when: { kind: 'always' }, then: { kind: 'behind', ref: { type: 'ally', id: 'grom' } }, weight: 1.5, source: 'держись за Громом' })]),
      hero('zhalo', 2, [atkNearest]),
    ];
    let hpNaive = 0;
    let hpPair = 0;
    let bitesNaive = 0;
    let bitesPair = 0;
    let deathsNaive = 0;
    let deathsPair = 0;
    for (let s = 1; s <= 20; s++) {
      const seed = s * 17 + 3;
      const n = runBattle(seed, [...naive(), ...ambush()], 'late');
      const g = runBattle(seed, [...pair(), ...ambush()], 'late');
      const frac = (res: typeof n): number => {
        const pu = res.units.filter((u) => u.side === 'party');
        return pu.reduce((a, u) => a + (u.alive ? u.hp : 0), 0) / pu.reduce((a, u) => a + u.maxHp, 0);
      };
      hpNaive += frac(n);
      hpPair += frac(g);
      bitesNaive += attacks(n.events).filter((e) => e.target === 'lia').length;
      bitesPair += attacks(g.events).filter((e) => e.target === 'lia').length;
      if (!n.units.find((u) => u.id === 'lia')!.alive) deathsNaive++;
      if (!g.units.find((u) => u.id === 'lia')!.alive) deathsPair++;
    }
    // связка бережёт подопечную: до неё реже доходят и она реже гибнет.
    // Перехват при этом стал редким событием — и это замысел плана teamwork:
    // заслон дешевит прикрытую цель, поэтому охотники за тылом переключаются
    // на доступных ЕЩЁ ДО удара, и ловить телохранителю почти нечего
    expect(bitesPair).toBeLessThan(bitesNaive * 0.75);
    expect(deathsPair).toBeLessThan(deathsNaive / 2);
    expect(hpPair).toBeGreaterThan(hpNaive); // связка бережёт против охоты на тыл
  });
});

describe('рипост глухой обороны', () => {
  const brace = r({ when: { kind: 'always' }, then: { kind: 'brace' }, weight: 5, source: 'глухая оборона' });
  const scene = (attacker: Partial<UnitSpec>): UnitSpec[] => [
    // защитник быстрее: сначала встаёт в глухую оборону, потом его бьют
    { id: 'def', name: 'def', side: 'party', maxHp: 600, atk: 5, range: 1, speed: 8, move: 0, lenses: ['plain'], rules: [brace], spawn: { x: 5, y: 8 } },
    { id: 'atk', name: 'atk', side: 'foe', maxHp: 600, atk: 6, range: 1, speed: 7, move: 0, lenses: ['fanatic'], rules: [atkNearest], spawn: { x: 6, y: 8 }, ...attacker },
  ];
  const ripostes = (events: readonly BattleEvent[]): Extract<BattleEvent, { t: 'riposte' }>[] =>
    events.filter((e): e is Extract<BattleEvent, { t: 'riposte' }> => e.t === 'riposte');

  it('ближний удар по глухой обороне ранит бьющего на фиксированные очки', () => {
    const res = runBattle(5, scene({}));
    const first = ripostes(res.events)[0]!;
    expect(first.unit).toBe('atk');
    expect(first.by).toBe('def');
    expect(first.dmg).toBe(RIPOSTE_DMG);
    expect(first.hp).toBe(600 - RIPOSTE_DMG);
  });

  it('стрела рипост не ловит', () => {
    const res = runBattle(5, scene({ atk: 6, range: 4, spawn: { x: 9, y: 8 } }));
    expect(ripostes(res.events)).toEqual([]);
  });

  it('рипост добивает: настойчивый умирает об оборону', () => {
    const res = runBattle(5, scene({ maxHp: 3 }));
    const rp = ripostes(res.events)[0];
    expect(rp).toBeDefined();
    expect(rp!.hp).toBe(0);
    expect(res.events.some((e) => e.t === 'die' && e.unit === 'atk')).toBe(true);
  });

  it('одна оборона за ход, и сразу лучшая доступная', () => {
    // бастион с 3 очками брал прикрытие за 1, следом глухую за 2 — весь ход
    // уходил на одну и ту же оборону, потому что держится только высший уровень
    const skala = heroArchetype('skala');
    const unit = (over: Partial<Fighter>): Fighter => ({
      id: 'def', name: 'def', side: 'party', maxHp: 96, hp: 96, atk: 5, range: 1,
      speed: 3, move: 1, pos: { x: 5, y: 8 }, startPos: { x: 5, y: 8 }, alive: true,
      coverLevel: 0, exposed: false, tags: [], lenses: ['plain'],
      compiled: applyLens(['plain'], [brace]), ...over,
    });
    const foe = unit({ id: 'foe', name: 'foe', side: 'foe', pos: { x: 6, y: 8 }, startPos: { x: 6, y: 8 } });
    const covers = (ap: number, coverLevel = 0): string[] => {
      const self = unit({ coverLevel, passives: skala.passives });
      return generateCandidates(self, [self, foe], undefined, ap)
        .map((c) => c.action)
        .filter((a) => a === 'cover' || a === 'fullCover');
    };

    expect(covers(3)).toEqual(['fullCover']); // хватает на глухую (2 очка) — дешёвой не предлагаем
    expect(covers(1)).toEqual(['cover']); // на глухую не хватает — остаётся прикрытие
    expect(covers(3, COVER)).toEqual([]); // оборона уже стоит: второй за ход нет
  });

  it('смоук: Гром в глухой обороне делает дуэлянта дороже для него самого', () => {
    const duel = () => [duelist(), soldier(1, 'soldier2'), soldier(2, 'soldier1')];
    const braceRule = r({ when: { kind: 'hpBelow', who: 'self', frac: 0.6 }, then: { kind: 'brace' }, weight: 2, source: 'ранен — глухая оборона' });
    let duelistRiposteHp = 0;
    let gromDeadNaive = 0;
    let gromDeadBrace = 0;
    for (let s = 1; s <= 20; s++) {
      const seed = s * 17 + 3;
      const naive = runBattle(seed, [hero('grom', 0, [atkNearest]), hero('lia', 1, [atkNearest]), hero('zhalo', 2, [atkNearest]), ...duel()], 'elite');
      const braced = runBattle(seed, [hero('grom', 0, [atkNearest, braceRule]), hero('lia', 1, [atkNearest]), hero('zhalo', 2, [atkNearest]), ...duel()], 'elite');
      duelistRiposteHp += ripostes(braced.events).filter((e) => e.unit === 'duelist').reduce((a, e) => a + e.dmg, 0);
      if (!naive.units.find((u) => u.id === 'grom')!.alive) gromDeadNaive++;
      if (!braced.units.find((u) => u.id === 'grom')!.alive) gromDeadBrace++;
    }
    expect(duelistRiposteHp).toBeGreaterThan(0); // настойчивость дуэлянта теперь стоит крови
    expect(gromDeadBrace).toBeLessThanOrEqual(gromDeadNaive); // и керри в обороне гибнет не чаще
  });
});
