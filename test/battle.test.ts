import { describe, expect, it } from 'vitest';
import { type UnitSpec, runBattle } from '../src/battle.js';
import { makeFoes, makeIrSets } from '../src/scenarios.js';
import { grunt, slinger } from '../src/foes.js';
import { heroArchetype } from '../src/heroes.js';
import { dist } from '../src/grid.js';
import type { Rule } from '../src/ir.js';

function specs(): UnitSpec[] {
  const set = makeIrSets()[0]!;
  return [...set.party, ...makeFoes()];
}

describe('runBattle: детерминизм', () => {
  it('тот же seed + те же принципы = тот же лог событий', () => {
    const a = runBattle(17, specs());
    const b = runBattle(17, specs());
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.winner).toBe(b.winner);
    expect(a.rounds).toBe(b.rounds);
  });

  it('разные сиды дают разные бои', () => {
    const traces = new Set(
      [1, 2, 3, 4, 5].map((seed) => JSON.stringify(runBattle(seed, specs()).events)),
    );
    expect(traces.size).toBeGreaterThan(1);
  });
});

describe('runBattle: корректность', () => {
  it('бой заканчивается победой одной из сторон или ничьёй ≤30 раундов', () => {
    for (const seed of [1, 5, 9]) {
      const r = runBattle(seed, specs());
      expect(['party', 'foe', 'draw']).toContain(r.winner);
      expect(r.rounds).toBeLessThanOrEqual(30);
      expect(r.events.at(-1)?.t).toBe('end');
    }
  });

  it('у каждого решения не больше 3 факторов', () => {
    const r = runBattle(2, specs());
    for (const e of r.events) {
      if (e.t === 'decision') expect(e.factors.length).toBeLessThanOrEqual(3);
    }
  });

  it('мёртвые не ходят: после die юнит не действует', () => {
    const r = runBattle(3, specs());
    const dead = new Set<string>();
    for (const e of r.events) {
      if (e.t === 'decision') expect(dead.has(e.unit)).toBe(false);
      if (e.t === 'die') dead.add(e.unit);
    }
  });

  it('hp никогда не уходит ниже нуля', () => {
    const r = runBattle(4, specs());
    for (const e of r.events) {
      if (e.t === 'attack') expect(e.targetHp).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('буквалист без сработавшего правила', () => {
  it('защищается на месте вместо отсебятины', () => {
    const literalist: UnitSpec = {
      id: 'lit',
      name: 'Буквалист',
      side: 'party',
      maxHp: 30,
      atk: 5,
      range: 1,
      speed: 5,
      move: 3,
      lenses: ['literalist'],
      // правило никогда не сработает: hp всегда выше 1%
      rules: [
        {
          when: { kind: 'hpBelow', who: 'self', frac: 0.01 },
          then: { kind: 'attack', target: 'nearest' },
          weight: 2,
          scope: 'self',
          source: 'никогда',
        },
      ],
      spawn: { x: 1, y: 3 },
    };
    const foe: UnitSpec = {
      id: 'e',
      name: 'Враг',
      side: 'foe',
      maxHp: 10,
      atk: 1,
      range: 1,
      speed: 4,
      move: 2,
      lenses: ['plain'],
      rules: [
        {
          when: { kind: 'always' },
          then: { kind: 'attack', target: 'nearest' },
          weight: 2,
          scope: 'self',
          source: 'бей',
        },
      ],
      spawn: { x: 6, y: 3 },
    };
    const r = runBattle(1, [literalist, foe]);
    const litDecisions = r.events.filter((e) => e.t === 'decision' && e.unit === 'lit');
    expect(litDecisions.length).toBeGreaterThan(0);
    for (const d of litDecisions) {
      if (d.t !== 'decision') continue;
      // нет правила на ситуацию — весь ход за щитом, отсебятины никакой
      expect(d.action).toBe('fullCover');
      // буквалист стоит на месте
      expect(d.to).toEqual({ x: 1, y: 3 });
    }
  });
});

describe('«держать позицию» — поводок, а не якорь', () => {
  const r = (rule: Omit<Rule, 'scope'>): Rule => ({ ...rule, scope: 'self' });
  const hold = (weight: number): Rule => r({ when: { kind: 'always' }, then: { kind: 'holdPosition' }, weight, source: 'держать позицию' });
  const atk = (weight: number): Rule => r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight, source: 'бей ближайшего' });
  const spawn = { x: 2, y: 8 };
  // толстое тело: сцена меряет, куда боец уходит, а не кто кого убил
  const scene = (rules: Rule[]): UnitSpec[] => [
    { id: 'u', name: 'u', side: 'party', maxHp: 300, atk: 8, range: 1, speed: 5, move: 2, lenses: ['plain'], rules, spawn },
    grunt(1),
    slinger(1),
  ];
  const drift = (rules: Rule[]): number => {
    let max = 0;
    for (let seed = 1; seed <= 20; seed++) {
      for (const e of runBattle(seed, scene(rules), 'late').events) {
        if (e.t === 'move' && e.unit === 'u') max = Math.max(max, dist(spawn, e.to));
      }
    }
    return max;
  };

  it('без приказа держит место, под приказом отходит, тяжёлое слово позиции сильнее', () => {
    expect(drift([hold(1.5)])).toBeLessThanOrEqual(1); // слово работает: с места не уходит
    expect(drift([atk(1.5)])).toBeGreaterThan(6); // без слова боец идёт через поле
    const leash = drift([hold(1.5), atk(1.5)]);
    expect(leash).toBeGreaterThan(1); // приказ перебивает: боец сходит с места
    expect(leash).toBeLessThan(6); // но дальше своей позиции не уходит
    expect(drift([hold(4), atk(1.5)])).toBeLessThan(leash); // весомее слово позиции — короче поводок
  });

  it('врождённая «Глыба» Скалы не глушит приказ игрока', () => {
    const skala = heroArchetype('skala');
    const spec = (rules: Rule[]): UnitSpec => ({
      id: 'skala', name: skala.name, side: 'party', lenses: ['plain'],
      rules: [...rules, ...skala.innate], maxHp: skala.stats.maxHp, speed: skala.stats.speed,
      move: skala.stats.move, weapons: skala.weapons, passives: skala.passives, spawn,
    });
    let ap = 0;
    let obeyed = 0;
    for (let seed = 1; seed <= 20; seed++) {
      for (const e of runBattle(seed, [spec([atk(1.5)]), grunt(1), slinger(1)], 'late').events) {
        if (e.t === 'decision' && e.unit === 'skala') {
          ap++;
          if (e.action === 'move' || e.action.includes('ttack')) obeyed++;
        }
      }
    }
    expect(obeyed / ap).toBeGreaterThan(0.5); // приказ перебивает способность чаще, чем нет
  });
});

describe('фланг', () => {
  it('фланговые атаки случаются и наносят больше урона в среднем', () => {
    let flank = 0;
    let total = 0;
    for (let seed = 1; seed <= 20; seed++) {
      for (const e of runBattle(seed, specs()).events) {
        if (e.t === 'attack') {
          total++;
          if (e.flank) flank++;
        }
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(flank).toBeGreaterThan(0);
  });
});
