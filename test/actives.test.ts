import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import { type Fighter, apCostFor, generateCandidates, shadowMult, wallReady } from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { heroArchetype } from '../src/heroes.js';
import { describePassives } from '../src/cards.js';
import { foeIntel } from '../src/foes.js';
import { COVER_AC, OFF_GUARD_AC } from '../src/tuning.js';
import type { CombatUnit, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Активы и пассивы волны 1 (план классов, шаг 3): Гром «Стена» + щит −40%,
 * Дарт «метит ударом», Скала «незыблемость», Мара «тень», Тесса «в спину».
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

const spec = (over: Partial<UnitSpec> & Pick<UnitSpec, 'id' | 'side' | 'spawn'>): UnitSpec => ({
  name: over.id,
  maxHp: 40,
  atk: 7,
  range: 1,
  speed: 5,
  move: 2,
  lenses: ['plain'],
  rules: [rule({ kind: 'attack', target: 'nearest' })],
  ...over,
});

describe('Гром: стена и щит', () => {
  const GROM = heroArchetype('grom');

  it('гейт: без защитного правила стены нет, с «защищать» — есть', () => {
    const foe = fighter('e', 'foe', { x: 6, y: 4 });
    const noWord = fighter('g', 'party', { x: 4, y: 4 }, { active: GROM.active },
      [rule({ kind: 'attack', target: 'nearest' })]);
    expect(generateCandidates(noWord, [noWord, foe]).some((c) => c.action === 'wall')).toBe(false);
    const guard = fighter('g', 'party', { x: 4, y: 4 }, { active: GROM.active },
      [rule({ kind: 'protect', ally: 'a' })]);
    expect(generateCandidates(guard, [guard, fighter('a', 'party', { x: 5, y: 4 }), foe])
      .some((c) => c.action === 'wall')).toBe(true);
  });

  it('стена кроет себя и смежных (не дальних), раз в бой; щит держит −40%', () => {
    const grom = spec({
      id: 'grom', side: 'party', spawn: { x: 4, y: 4 }, maxHp: 80, atk: undefined,
      weapons: GROM.weapons, active: GROM.active, passives: GROM.passives, speed: 9,
      rules: [rule({ kind: 'protect', ally: 'lia' })],
    });
    const squishy = (id: string, spawn: Pos): UnitSpec =>
      spec({ id, side: 'party', spawn, atk: 8, range: 4, speed: 8, move: 1 });
    const brute = (id: string, spawn: Pos): UnitSpec =>
      spec({ id, side: 'foe', spawn, maxHp: 300, atk: 12, move: 3, rules: [rule({ kind: 'attack', target: 'weakest' })] });
    // стена окупается от двоих смежных — при одном щит (−40%) честно лучше
    const r = runBattle(3, [
      grom,
      squishy('lia', { x: 5, y: 4 }),
      squishy('dart', { x: 4, y: 5 }),
      squishy('far', { x: 1, y: 12 }), // вне накрытия стены
      brute('e1', { x: 7, y: 4 }),
      brute('e2', { x: 7, y: 5 }),
    ]);
    // события самой стены: подряд после её решения — сам + оба соседа,
    // дальний в накрытие не попал
    const wallAt = r.events.findIndex((e) => e.t === 'decision' && e.unit === 'grom' && e.action === 'wall');
    expect(wallAt).toBeGreaterThanOrEqual(0);
    const wallCovers = [];
    for (let i = wallAt + 1; i < r.events.length && r.events[i]!.t === 'cover'; i++) {
      wallCovers.push(r.events[i] as BattleEvent & { t: 'cover' });
    }
    expect(wallCovers.map((c) => c.ally ?? 'self')).toEqual(['self', 'lia', 'dart']);
    expect(wallCovers.every((c) => c.bonus === COVER_AC)).toBe(true);
    // щит Грома держит +3 к КБ (пассив «стена щита»)
    const covers = r.events.filter((e): e is BattleEvent & { t: 'cover' } => e.t === 'cover' && e.unit === 'grom');
    expect(covers.some((c) => c.ally === 'lia' && c.bonus === 3)).toBe(true);
    // стена одна на бой
    const walls = r.events.filter((e) => e.t === 'decision' && e.unit === 'grom' && e.action === 'wall');
    expect(walls.length).toBe(1);
  });

  it('wallReady: лимит на бой', () => {
    const g = fighter('g', 'party', { x: 0, y: 0 }, { active: { wall: { usesPerBattle: 1 } } });
    expect(wallReady(g)).toBe(true);
    g.wallUses = 1;
    expect(wallReady(g)).toBe(false);
  });
});

describe('Дарт: метит ударом', () => {
  it('первая жертва получает тег marked, повторные удары не спамят, метка переезжает', () => {
    const dart = spec({
      id: 'dart', side: 'party', spawn: { x: 2, y: 4 }, atk: undefined,
      weapons: heroArchetype('dart').weapons, passives: heroArchetype('dart').passives, speed: 9,
      rules: [rule({ kind: 'attack', target: 'nearest' })],
    });
    const tank = (id: string, spawn: Pos): UnitSpec =>
      spec({ id, side: 'foe', spawn, maxHp: 400, atk: 1, move: 0, rules: [] });
    const r = runBattle(1, [dart, tank('near', { x: 4, y: 4 }), tank('far', { x: 8, y: 4 })]);
    const marks = r.events.filter((e): e is BattleEvent & { t: 'mark' } => e.t === 'mark');
    expect(marks.length).toBe(1); // бьёт ближайшего весь бой — метка одна
    expect(marks[0]).toMatchObject({ unit: 'dart', target: 'near' });
    expect(r.units.find((u) => u.id === 'near')!.tags).toContain('marked');
  });

  it('союзник с «бей помеченного» идёт за меткой Дарта', () => {
    const dart = spec({
      id: 'dart', side: 'party', spawn: { x: 2, y: 4 }, atk: undefined,
      weapons: heroArchetype('dart').weapons, passives: heroArchetype('dart').passives, speed: 9,
      rules: [rule({ kind: 'attack', target: 'nearest' })],
    });
    // стрелок-follower: без метки бил бы ближайшего к себе (other)
    const follower = spec({
      id: 'fol', side: 'party', spawn: { x: 2, y: 10 }, atk: 7, range: 6, speed: 8,
      rules: [rule({ kind: 'attack', target: 'marked' })],
    });
    const tank = (id: string, spawn: Pos): UnitSpec =>
      spec({ id, side: 'foe', spawn, maxHp: 400, atk: 1, move: 0, rules: [] });
    const r = runBattle(1, [dart, tank('near', { x: 4, y: 4 }), tank('other', { x: 4, y: 10 })]);
    void follower;
    const r2 = runBattle(1, [dart, follower, tank('near', { x: 4, y: 4 }), tank('other', { x: 4, y: 10 })]);
    // после метки Дарта follower стреляет по near, а не по соседнему other
    const folTargets = r2.events
      .filter((e): e is BattleEvent & { t: 'attack' } => e.t === 'attack' && e.unit === 'fol')
      .map((e) => e.target);
    expect(folTargets.length).toBeGreaterThan(0);
    expect(folTargets.slice(1)).toContain('near');
    void r;
  });
});

describe('Скала: незыблемость', () => {
  it('глухая защита за 2 AP и в кандидатах при остатке 2', () => {
    const skala = fighter('s', 'party', { x: 4, y: 4 },
      { maxHp: 96, passives: heroArchetype('skala').passives, move: 1 });
    expect(apCostFor('fullCover', skala)).toBe(2);
    const plain = fighter('p', 'party', { x: 4, y: 4 }, { move: 1 });
    expect(apCostFor('fullCover', plain)).toBe(3);
    const foe = fighter('e', 'foe', { x: 6, y: 4 });
    expect(generateCandidates(skala, [skala, foe], undefined, 2).some((c) => c.action === 'fullCover')).toBe(true);
    expect(generateCandidates(plain, [plain, foe], undefined, 2).some((c) => c.action === 'fullCover')).toBe(false);
  });
});

describe('Мара: тень', () => {
  it('shadowMult: ×1.25 вне прицела, 1 под прицелом стрелка', () => {
    const mara = fighter('m', 'party', { x: 2, y: 2 }, { passives: heroArchetype('mara').passives });
    const shooter = fighter('s', 'foe', { x: 6, y: 2 }, { range: 5 });
    const melee = fighter('b', 'foe', { x: 3, y: 2 });
    expect(shadowMult(mara, mara.pos, [mara, shooter], () => false)).toBe(1);
    expect(shadowMult(mara, mara.pos, [mara, melee], () => false)).toBe(1.25);
    // камень между — стрелок не держит на прицеле
    const rock = (p: Pos): boolean => p.x === 4 && p.y === 2;
    expect(shadowMult(mara, mara.pos, [mara, shooter], rock)).toBe(1.25);
  });

  it('в бою удары из тени тяжелее (тот же сид, ×1.25 против ×1)', () => {
    const withShadow = (mult: number): number => {
      // move 0: без шагов последовательности решений обоих боёв совпадают —
      // rng синхронен, и первые удары сравнимы один к одному
      const mara = spec({
        id: 'mara', side: 'party', spawn: { x: 2, y: 4 }, atk: undefined,
        weapons: heroArchetype('mara').weapons, passives: { shadow: { mult } }, speed: 9, move: 0,
        rules: [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'strikeHard' })],
      });
      const tank = spec({ id: 'e', side: 'foe', spawn: { x: 6, y: 4 }, maxHp: 400, atk: 1, move: 0, rules: [] });
      const r = runBattle(2, [mara, tank]);
      // сумма первых ударов: каменное укрытие арены и округление могут съесть
      // разницу одного выстрела, на дистанции пяти она набегает всегда
      return r.events
        .filter((e): e is BattleEvent & { t: 'attack' } => e.t === 'attack' && e.unit === 'mara')
        .slice(0, 5)
        .reduce((s, e) => s + e.dmg, 0);
    };
    const shadowed = withShadow(1.25);
    const plain = withShadow(1);
    expect(plain).toBeGreaterThan(0);
    expect(shadowed).toBeGreaterThan(plain);
  });
});

describe('Тесса: в спину', () => {
  it('её фланг застигает глубже общего (−3 к КБ против −2, тот же сид)', () => {
    const withSneak = (offGuard: number): number => {
      const tessa = spec({
        id: 'tessa', side: 'party', spawn: { x: 3, y: 4 }, atk: undefined,
        weapons: heroArchetype('tessa').weapons, passives: { sneak: { offGuard } }, speed: 9, move: 3,
        rules: [rule({ kind: 'flank' }), rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'strikeHard' })],
      });
      const mate = spec({ id: 'mate', side: 'party', spawn: { x: 5, y: 4 }, speed: 8 });
      const tank = spec({ id: 'e', side: 'foe', spawn: { x: 4, y: 4 }, maxHp: 400, atk: 1, move: 0, rules: [] });
      const r = runBattle(2, [tessa, mate, tank]);
      let sum = 0;
      for (const e of r.events) {
        if (e.t === 'attack' && e.unit === 'tessa' && e.flank) sum += e.dmg;
      }
      return sum;
    };
    const sneak = withSneak(3);
    const plain = withSneak(OFF_GUARD_AC);
    expect(plain).toBeGreaterThan(0);
    expect(sneak).toBeGreaterThan(plain);
  });
});

describe('пассивы видны игроку', () => {
  it('describePassives: строки всех пяти', () => {
    expect(describePassives({ shieldwall: { ac: 3 } })).toBe('щит союзнику +3 к КБ');
    expect(describePassives({ markOnHit: true })).toBe('метит цель ударом');
    expect(describePassives({ steadfast: true })).toBe('глухая оборона за 2 очка');
    expect(describePassives({ shadow: { mult: 1.25 } })).toBe('из тени урон ×1.25');
    expect(describePassives({ sneak: { offGuard: 3 } })).toBe('фланг: −3 к КБ цели');
  });

  it('разведка показывает актив и пассив носителя', () => {
    const s = spec({ id: 'x', side: 'foe', spawn: { x: 0, y: 0 }, active: { rage: { dmgMult: 1.3, vulnMult: 1.2 } }, passives: { steadfast: true } });
    const intel = foeIntel([s])[0]!;
    expect(intel.lines).toContain('актив: ярость (урон ×1.3, входящий ×1.2, до конца боя)');
    expect(intel.lines).toContain('пассив: глухая оборона за 2 очка');
  });
});
