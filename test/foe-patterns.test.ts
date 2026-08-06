import { describe, expect, it } from 'vitest';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { foeIntel, rat, wolf } from '../src/foes.js';
import { PARTY_SPAWNS, heroArchetype } from '../src/heroes.js';
import type { Rule } from '../src/ir.js';
import { posEq } from '../src/grid.js';

/**
 * Паттерны боёв плана врагов: каждый состав — задача на переформулировку.
 * Смоуки парные: формулировка-до против контр-формулировки на общих сидах.
 */

const r = (rule: Omit<Rule, 'scope'>): Rule => ({ ...rule, scope: 'self' });
const atkNearest = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 2, source: 'бей ближайшего' });
const barrage = r({ when: { kind: 'always' }, then: { kind: 'barrage' }, weight: 2, source: 'накрой скопление' });
const focusWeak = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 2, source: 'добивай раненых' });

/** Герой из пула (оружие/активы/пассивы/способность) с заданными приказами. */
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
    spawn: { ...PARTY_SPAWNS[slot]! },
  };
}

const partyWith = (extra: Rule[]): UnitSpec[] => [
  hero('grom', 0, [atkNearest]),
  hero('lia', 1, [atkNearest, ...extra]),
  hero('zhalo', 2, [atkNearest, ...extra]),
];

interface SweepStats {
  wins: number;
  hpFrac: number;
  foeBites: number;
}

function sweep(party: () => UnitSpec[], foes: () => UnitSpec[], arena: 'early' | 'late', seeds = 20): SweepStats {
  let wins = 0;
  let hpFrac = 0;
  let foeBites = 0;
  for (let s = 1; s <= seeds; s++) {
    const res = runBattle(s * 17 + 3, [...party(), ...foes()], arena);
    if (res.winner === 'party') wins++;
    const pu = res.units.filter((u) => u.side === 'party');
    hpFrac += pu.reduce((a, u) => a + (u.alive ? u.hp : 0), 0) / pu.reduce((a, u) => a + u.maxHp, 0);
    foeBites += res.events.filter((e): e is Extract<BattleEvent, { t: 'attack' }> => e.t === 'attack')
      .filter((e) => e.unit.startsWith('rat') || e.unit.startsWith('wolf')).length;
  }
  return { wins, hpFrac: hpFrac / seeds, foeBites: foeBites / seeds };
}

const rats = () => Array.from({ length: 9 }, (_, i) => rat(i + 1));
const wolves = () => Array.from({ length: 4 }, (_, i) => wolf(i + 1));

describe('масса: крысиная стая', () => {
  it('спеки: дешёвое тело, фанатик (страху нет), уникальные точки спавна кучей', () => {
    const pack = rats();
    expect(pack).toHaveLength(9);
    for (const p of pack) {
      expect(p.maxHp).toBe(10);
      expect(p.weapons![0]!.name).toBe('зубы');
      expect(p.lenses).toEqual(['fanatic']);
    }
    for (const [i, a] of pack.entries()) {
      for (const b of pack.slice(i + 1)) expect(posEq(a.spawn!, b.spawn!)).toBe(false);
    }
  });

  it('масса доходит и кусает: без линзы фанатика стая черепашилась под обстрелом', () => {
    const st = sweep(() => partyWith([]), rats, 'early');
    expect(st.foeBites).toBeGreaterThan(12);
  });

  it('смоук: наив истощается, «накрыть скопление» переворачивает', () => {
    const naive = sweep(() => partyWith([]), rats, 'early');
    const aoe = sweep(() => partyWith([barrage]), rats, 'early');
    // наив выживает (не стена), но платит около половины hp партии
    expect(naive.wins).toBeGreaterThanOrEqual(12);
    expect(naive.hpFrac).toBeLessThan(0.55);
    // контр: побед не меньше, hp на выходе ощутимо выше
    expect(aoe.wins).toBeGreaterThanOrEqual(naive.wins);
    expect(aoe.hpFrac).toBeGreaterThan(naive.hpFrac + 0.1);
  });
});

describe('стая: волчья охота', () => {
  it('спеки: фланговый укус вдвое больнее (sneak), «сбить с ног» в правилах', () => {
    for (const w of wolves()) {
      expect(w.passives?.sneak?.flankMult).toBe(2.0);
      expect(w.rules.some((rl) => rl.then.kind === 'shove')).toBe(true);
      expect(w.rules.some((rl) => rl.then.kind === 'attack' && rl.then.target === 'weakest')).toBe(true);
    }
  });

  it('волки охотятся на хрупких: укусы доходят до мага за спинами', () => {
    let liaBites = 0;
    for (let s = 1; s <= 20; s++) {
      const res = runBattle(s * 17 + 3, [...partyWith([]), ...wolves()], 'late');
      liaBites += res.events.filter((e) => e.t === 'attack' && e.target === 'lia').length;
    }
    expect(liaBites).toBeGreaterThan(20);
  });

  it('смоук: стая стоит дорого, фокус-огонь окупается', () => {
    const naive = sweep(() => partyWith([]), wolves, 'late');
    const focus = sweep(
      () => [hero('grom', 0, [focusWeak]), hero('lia', 1, [focusWeak]), hero('zhalo', 2, [focusWeak])],
      wolves,
      'late',
    );
    expect(naive.hpFrac).toBeLessThan(0.55); // стая кусает всерьёз
    expect(focus.wins).toBeGreaterThanOrEqual(naive.wins); // фокус не хуже, стая тает быстрее
  });

  it('разведка новых врагов читается: правила, оружие, пассив', () => {
    const intel = foeIntel([rat(1), wolf(1)]);
    expect(intel[0]!.lines).toContain('крыса: вцепиться в ближайшего');
    expect(intel[0]!.lines.some((l) => l.startsWith('оружие: зубы'))).toBe(true);
    expect(intel[1]!.lines.some((l) => l.includes('фланг ×2'))).toBe(true);
  });
});
