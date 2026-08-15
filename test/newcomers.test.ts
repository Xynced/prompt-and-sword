import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import {
  type Fighter,
  attackMultFor,
  decide,
  generateCandidates,
  movesOf,
  retributionMult,
} from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { heroArchetype } from '../src/heroes.js';
import type { CombatUnit, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Новые бойцы волны 2 (план классов, шаг 7): Рык («росчерк» 1×2), Лиса
 * (финт), Веста («полымя» — ритуал с пульсами), Юна (кулаки 0.55),
 * Заря (кара).
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
    atk: 7,
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

describe('Рык: росчерк', () => {
  it('двуручник рубит линией 1×2 при слове «накрыть скопление»', () => {
    // aoe у Fighter — производное от оружия; в бою его заполняет makeFighter
    const ryk = fighter('ryk', 'party', { x: 4, y: 4 },
      {
        weapons: heroArchetype('ryk').weapons,
        aoe: heroArchetype('ryk').weapons[0]!.aoe,
        atk: 9, range: 1,
      },
      [rule({ kind: 'barrage' })]);
    // двое в линию на восток — взмах достаёт обоих
    const e1 = fighter('e1', 'foe', { x: 5, y: 4 });
    const e2 = fighter('e2', 'foe', { x: 6, y: 4 });
    const lines = generateCandidates(ryk, [ryk, e1, e2]).filter((c) => c.action === 'aoeLine');
    expect(lines.length).toBeGreaterThan(0);
    const d = decide(ryk, [ryk, e1, e2]);
    expect(d.chosen.action).toBe('aoeLine'); // двое в полосе обыгрывают одиночный удар
  });
});

describe('Лиса: финт', () => {
  it('кандидаты: смежный не-открытый враг; исполнение ставит exposed', () => {
    const lisa = fighter('lisa', 'party', { x: 4, y: 4 },
      { active: heroArchetype('lisa').active },
      [rule({ kind: 'feint' })]);
    const near = fighter('e1', 'foe', { x: 5, y: 4 });
    const open = fighter('e2', 'foe', { x: 4, y: 5 }, { exposed: true });
    const far = fighter('e3', 'foe', { x: 8, y: 4 });
    const targets = generateCandidates(lisa, [lisa, near, open, far])
      .filter((c) => c.action === 'feint')
      .map((c) => c.targetId);
    expect(targets).toEqual(['e1']);
  });

  it('в бою: финтит при поддержке и цель открыта до её хода', () => {
    // вес атаки 1 — дефолт конструктора; с ним финт-сетап конкурентен,
    // усиленный приказ атаки (вес 2) законно задавит трюк
    const lisa: UnitSpec = {
      id: 'lisa', name: 'Лиса', side: 'party', maxHp: 42,
      weapons: heroArchetype('lisa').weapons, active: heroArchetype('lisa').active,
      speed: 9, move: 3, lenses: ['plain'],
      rules: [rule({ kind: 'attack', target: 'nearest' }, 1), ...heroArchetype('lisa').innate],
      spawn: { x: 4, y: 4 },
    };
    const mate: UnitSpec = {
      id: 'mate', name: 'mate', side: 'party', maxHp: 60, atk: 8, range: 1, speed: 8,
      move: 2, lenses: ['plain'], rules: [rule({ kind: 'attack', target: 'nearest' })],
      spawn: { x: 3, y: 4 },
    };
    const tank: UnitSpec = {
      id: 'e', name: 'e', side: 'foe', maxHp: 400, atk: 2, range: 1, speed: 1, move: 1,
      lenses: ['plain'], rules: [rule({ kind: 'attack', target: 'nearest' })], spawn: { x: 5, y: 4 },
    };
    const r = runBattle(3, [lisa, mate, tank]);
    const feints = r.events.filter((e): e is BattleEvent & { t: 'feint' } => e.t === 'feint');
    expect(feints.length).toBeGreaterThan(0);
    expect(feints[0]).toMatchObject({ unit: 'lisa', target: 'e' });
  });
});

describe('Веста: полымя (ритуал с пульсами)', () => {
  it('зона бьёт три хода подряд и лишь потом гаснет', () => {
    const vesta: UnitSpec = {
      id: 'vesta', name: 'Веста', side: 'party', maxHp: 38,
      weapons: heroArchetype('vesta').weapons,
      speed: 9, move: 2, lenses: ['plain'],
      rules: [rule({ kind: 'barrage' })], spawn: { x: 4, y: 8 },
    };
    // неподвижные манекены кучей — зона накрывает и жжёт каждый пульс
    const tank = (id: string, spawn: Pos): UnitSpec => ({
      id, name: id, side: 'foe', maxHp: 400, atk: 1, range: 1, speed: 1, move: 0,
      lenses: ['plain'], rules: [], spawn,
    });
    const r = runBattle(4, [vesta, tank('f1', { x: 8, y: 8 }), tank('f2', { x: 9, y: 8 })]);
    // первый цикл: замах → три пульса, и только потом (после перезарядки)
    // возможен новый замах. Против неубиваемых манекенов циклы повторяются —
    // смотрим отрезок до второго телеграфа
    const telegraphs = r.events
      .map((e, i) => (e.t === 'telegraph' ? i : -1))
      .filter((i) => i >= 0);
    expect(telegraphs.length).toBeGreaterThan(0);
    const cycle = r.events.slice(telegraphs[0]!, telegraphs[1] ?? r.events.length);
    const casts = cycle.filter(
      (e): e is BattleEvent & { t: 'aoeCast' } => e.t === 'aoeCast' && e.form === 'ritual',
    );
    expect(casts.length).toBe(3); // pulses 3
    expect(casts.map((c) => c.holds ?? false)).toEqual([true, true, false]);
    // каждый пульс жжёт манекены
    const hits = cycle.filter((e) => e.t === 'aoeHit');
    expect(hits.length).toBeGreaterThanOrEqual(6);
  });
});

describe('Юна: кулаки бури', () => {
  it('«шквал» — парный приём: за очко хода два удара, вместе крепче общего быстрого', () => {
    // волюм монахини переехал из повышенного weakMult в сам приём (MAP,
    // план action-economy): множитель задан на удар, приём бьёт дважды
    const fists = heroArchetype('yuna').weapons[0]!;
    const squall = movesOf(fists).find((m) => m.slot === 'weakAttack')!;
    expect(squall.pair).toBe(true);
    expect(squall.mult * 2).toBeGreaterThan(attackMultFor('weakAttack', { name: 'меч', dmg: 7, range: 1 }));
    // кулаки — ловкое оружие: ступень MAP мягче
    expect(fists.agile).toBe(true);
  });

  it('канал weakMult жив: оружие с повышенным множителем бьёт слабым ударом крепче общего', () => {
    const sum = (weakMult: number | undefined): number => {
      const yuna: UnitSpec = {
        id: 'yuna', name: 'Юна', side: 'party', maxHp: 52,
        weapons: [{ name: 'кулаки', dmg: 7, range: 1, ...(weakMult ? { weakMult } : {}) }],
        speed: 9, move: 0, lenses: ['plain'],
        rules: [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'strikeOften' })],
        spawn: { x: 4, y: 4 },
      };
      const tank: UnitSpec = {
        id: 'e', name: 'e', side: 'foe', maxHp: 400, atk: 1, range: 1, speed: 1, move: 0,
        lenses: ['plain'], rules: [], spawn: { x: 5, y: 4 },
      };
      const r = runBattle(2, [yuna, tank]);
      return r.events
        .filter((e): e is BattleEvent & { t: 'attack' } => e.t === 'attack' && e.action === 'weakAttack')
        .slice(0, 6)
        .reduce((s, e) => s + e.dmg, 0);
    };
    const heavy = sum(0.8);
    const plain = sum(undefined);
    expect(plain).toBeGreaterThan(0);
    expect(heavy).toBeGreaterThan(plain);
  });
});

describe('Заря: кара', () => {
  it('×1.25 по врагу, ударившему союзника; невиновным — обычный урон', () => {
    const zarya = fighter('z', 'party', { x: 4, y: 4 }, { passives: heroArchetype('zarya').passives });
    const mate = fighter('m', 'party', { x: 3, y: 4 });
    const guilty = fighter('e1', 'foe', { x: 5, y: 4 });
    const innocent = fighter('e2', 'foe', { x: 4, y: 5 });
    const units = [zarya, mate, guilty, innocent];
    expect(retributionMult(zarya, guilty, units)).toBe(1); // ещё никого не бил
    mate.lastAttackerId = 'e1';
    expect(retributionMult(zarya, guilty, units)).toBe(1.25);
    expect(retributionMult(zarya, innocent, units)).toBe(1);
    // без пассива множителя нет
    expect(retributionMult(mate, guilty, units)).toBe(1);
  });
});
