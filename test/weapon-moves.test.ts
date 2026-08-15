import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import {
  type Fighter,
  candMove,
  decide,
  gangBonus,
  generateCandidates,
  isSureStrike,
  makeCtx,
  movesOf,
  scoreCandidate,
  stanceGuard,
} from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { HERO_POOL, heroArchetype } from '../src/heroes.js';
import { describeWeapons } from '../src/cards.js';
import { BRACE_AC, SELFLESS_ATK_MULT, WEAK_ATK_MULT } from '../src/tuning.js';
import type { CombatUnit, Pos, Side, WeaponMove, WeaponSpec } from '../src/types.js';
import type { Tile } from '../src/terrain.js';
import type { Rule } from '../src/ir.js';

/**
 * Приёмы оружия (план weapon-moves, волна 1): виды атак — свойство оружия.
 * Кит приёмов заполняет слоты-темпы именами, числами и райдерами (пирс, sure,
 * expose, толчок); оружие без кита живёт на дефолт-тройке с прежними числами.
 * Пилоты — Гром (щитоносец без рискового темпа) и Яр (три оружия без доминации).
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

const GROM = heroArchetype('grom');
const YAR = heroArchetype('yar');
const attacks = (events: readonly BattleEvent[], unit: string): Extract<BattleEvent, { t: 'attack' }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: 'attack' }> => e.t === 'attack' && e.unit === unit);

describe('дефолт-тройка', () => {
  it('оружие без кита получает тычок/удар/размен с прежними числами', () => {
    const w: WeaponSpec = { name: 'тесак', dmg: 5, range: 1 };
    const moves = movesOf(w);
    expect(moves.map((m) => [m.slot, m.mult])).toEqual([
      ['weakAttack', WEAK_ATK_MULT],
      ['attack', 1],
      ['selflessAttack', SELFLESS_ATK_MULT],
    ]);
    expect(moves[2]!.expose).toBe(true); // размен открывает, как отчаянный удар
  });

  it('weakMult оружия уважается (кулаки Юны частят крепче)', () => {
    expect(movesOf({ name: 'кулаки', dmg: 7, range: 1, weakMult: 0.55 })[0]!.mult).toBe(0.55);
  });
});

describe('кандидаты по киту', () => {
  it('Гром: два полных приёма, рискового темпа нет вовсе', () => {
    const grom = fighter('grom', 'party', { x: 4, y: 4 }, { maxHp: 80, weapons: GROM.weapons, atk: 8, range: 1 },
      [rule({ kind: 'attack', target: 'nearest' })]);
    const foe = fighter('e', 'foe', { x: 5, y: 4 });
    const cands = generateCandidates(grom, [grom, foe]).filter((c) => c.targetId === 'e');
    expect(cands.map((c) => candMove(grom, c).id).sort()).toEqual(['guardCut', 'shieldJab', 'trueCut']);
    expect(cands.some((c) => c.action === 'selflessAttack')).toBe(false);
    expect(cands.every((c) => c.move !== undefined)).toBe(true);
  });

  it('Яр при 1 очке бьёт серией уколов — меч живёт быстрым темпом', () => {
    // move 0: иначе reach-боец законно предпочтёт выйти из ZoC и колоть копьём
    const yar = fighter('yar', 'party', { x: 4, y: 4 }, { maxHp: 56, weapons: YAR.weapons, atk: 8, range: 2, move: 0 },
      [rule({ kind: 'attack', target: 'nearest' })]);
    const foe = fighter('e', 'foe', { x: 5, y: 4 });
    const d = decide(yar, [yar, foe], 1, () => false, 1);
    expect(d.chosen.action).toBe('weakAttack');
    expect(YAR.weapons[d.chosen.weapon!]!.name).toBe('меч');
  });
});

describe('райдеры: пирс, sure, рипост', () => {
  const breakMove = YAR.weapons[2]!.moves![0]!; // пролом молота

  it('пирс пролома режет бонус обороны цели и делает удар расчётливым', () => {
    expect(stanceGuard(BRACE_AC, breakMove, undefined)).toBe(Math.round(BRACE_AC * breakMove.pierce!));
    expect(isSureStrike(breakMove, undefined)).toBe(true);
    expect(isSureStrike(GROM.weapons[0]!.moves![1]!, undefined)).toBe(true); // из-за щита: sure
    expect(isSureStrike(GROM.weapons[0]!.moves![2]!, undefined)).toBe(false); // верный рубящий
  });

  it('Гром против глухой обороны выбирает удар из-за щита — рипост не грозит', () => {
    const turtle = fighter('t', 'foe', { x: 5, y: 4 }, { maxHp: 600, hp: 600, guard: BRACE_AC, guardFrom: 'fullCover' });
    const grom = fighter('grom', 'party', { x: 4, y: 4 }, { maxHp: 80, weapons: GROM.weapons, atk: 8, range: 1 },
      [rule({ kind: 'attack', target: 'nearest' })]);
    const d = decide(grom, [grom, turtle], 1, () => false, 2);
    expect(candMove(grom, d.chosen).id).toBe('guardCut');
  });
});

describe('райдеры в бою: толчок и рисковый темп', () => {
  it('щитом в грудь толкает цель на клетку от Грома', () => {
    const specs: UnitSpec[] = [
      {
        id: 'grom', name: 'Гром', side: 'party', maxHp: 80, weapons: GROM.weapons,
        speed: 8, move: 2, lenses: ['plain'],
        // «бить часто» выбирает быстрый темп — у Грома это толчок щитом
        rules: [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'strikeOften' })],
        spawn: { x: 5, y: 8 },
      },
      {
        id: 'dummy', name: 'dummy', side: 'foe', maxHp: 600, atk: 5, range: 1,
        speed: 3, move: 0, lenses: ['literalist'], rules: [], spawn: { x: 6, y: 8 },
      },
    ];
    const res = runBattle(5, specs);
    // толчок — райдер попадания: у промаха отлёта нет (план damage-types)
    const first = attacks(res.events, 'grom').find((a) => a.outcome !== 'miss')!;
    expect(first.move).toBe('щитом в грудь');
    const i = res.events.indexOf(first);
    const after = res.events.slice(i + 1, i + 3);
    const shove = after.find((e) => e.t === 'shove');
    expect(shove).toBeDefined();
    expect((shove as Extract<BattleEvent, { t: 'shove' }>).target).toBe('dummy');
  });

  it('«бить отчаянно» у Яра — это сплеча молотом: имя приёма в логе', () => {
    const specs: UnitSpec[] = [
      {
        id: 'yar', name: 'Яр', side: 'party', maxHp: 56, weapons: YAR.weapons,
        speed: 8, move: 2, lenses: ['plain'],
        rules: [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'strikeDesperate' })],
        spawn: { x: 5, y: 8 },
      },
      {
        id: 'dummy', name: 'dummy', side: 'foe', maxHp: 600, atk: 5, range: 1,
        speed: 3, move: 0, lenses: ['literalist'], rules: [], spawn: { x: 6, y: 8 },
      },
    ];
    const res = runBattle(5, specs);
    const first = attacks(res.events, 'yar')[0]!;
    expect(first.move).toBe('сплеча');
    expect(first.action).toBe('selflessAttack');
  });
});

describe('волна 2: цена приёма (ap) и киты в выборе', () => {
  const TESSA = heroArchetype('tessa');
  const MARA = heroArchetype('mara');

  it('«серия» Тессы доступна только при полном ходе', () => {
    const tessa = fighter('t', 'party', { x: 4, y: 4 }, { maxHp: 44, weapons: TESSA.weapons, atk: 7, range: 3, move: 0 },
      [rule({ kind: 'attack', target: 'nearest' })]);
    const foe = fighter('e', 'foe', { x: 5, y: 4 });
    const ids = (ap: number): string[] =>
      generateCandidates(tessa, [tessa, foe], undefined, ap)
        .filter((c) => c.targetId === 'e')
        .map((c) => candMove(tessa, c).id);
    expect(ids(3)).toContain('daggerFlow');
    expect(ids(2)).not.toContain('daggerFlow');
  });

  it('в бою «серия» съедает весь ход: одно решение за раунд', () => {
    const specs: UnitSpec[] = [
      {
        id: 'tessa', name: 'Тесса', side: 'party', maxHp: 44, weapons: TESSA.weapons,
        speed: 9, move: 2, lenses: ['plain'],
        rules: [rule({ kind: 'attack', target: 'nearest' })], spawn: { x: 5, y: 8 },
      },
      {
        id: 'tank', name: 'tank', side: 'foe', maxHp: 600, atk: 1, range: 1,
        speed: 1, move: 0, lenses: ['literalist'], rules: [], spawn: { x: 6, y: 8 },
      },
    ];
    const res = runBattle(5, specs);
    const round1 = res.events.filter(
      (e) => e.t === 'decision' && e.unit === 'tessa' && e.round === 1,
    );
    expect(round1.length).toBe(1); // 3 AP списаны одним приёмом
    expect(attacks(res.events, 'tessa')[0]!.move).toBe('серия');
  });

  it('Мара в упор при 1 очке достаёт засапожный нож — арбалет не частит', () => {
    const mara = fighter('m', 'party', { x: 4, y: 4 }, { maxHp: 36, weapons: MARA.weapons, atk: 7, range: 6, move: 0 },
      [rule({ kind: 'attack', target: 'nearest' })]);
    const foe = fighter('e', 'foe', { x: 5, y: 4 });
    const d = decide(mara, [mara, foe], 1, () => false, 1);
    expect(candMove(mara, d.chosen).id).toBe('bootKnife');
    expect(MARA.weapons[d.chosen.weapon!]!.name).toBe('засапожный нож');
  });
});

describe('волна 2: райдер gang — в окружении больнее', () => {
  it('gangBonus: +0.15 за каждого союзника вплотную к цели', () => {
    const tessa = fighter('t', 'party', { x: 4, y: 4 });
    const foe = fighter('e', 'foe', { x: 5, y: 4 });
    const a1 = fighter('a1', 'party', { x: 5, y: 3 });
    const a2 = fighter('a2', 'party', { x: 5, y: 5 });
    const grad = heroArchetype('tessa').weapons[0]!.moves![0]!;
    expect(grad.gang).toBe(0.15);
    expect(gangBonus(grad, tessa, foe, [tessa, foe])).toBe(0);
    expect(gangBonus(grad, tessa, foe, [tessa, foe, a1, a2])).toBeCloseTo(0.3);
  });

  it('скоринг видит толпу: агрессия града растёт с союзниками у цели', () => {
    const rules = [rule({ kind: 'attack', target: 'nearest' })];
    const mk = (allies: Fighter[]): number => {
      const tessa = fighter('t', 'party', { x: 4, y: 4 },
        { maxHp: 44, weapons: heroArchetype('tessa').weapons, atk: 7, range: 3 }, rules);
      const foe = fighter('e', 'foe', { x: 5, y: 4 }, { maxHp: 100, hp: 100 });
      const units = [tessa, foe, ...allies];
      const grad = generateCandidates(tessa, units)
        .find((c) => c.targetId === 'e' && candMove(tessa, c).id === 'flurryJab')!;
      return scoreCandidate(grad, tessa, units, tessa.compiled.rules)
        .find((f) => f.label === 'инстинкт:агрессия')!.value;
    };
    const alone = mk([]);
    const packed = mk([fighter('a1', 'party', { x: 5, y: 3 }), fighter('a2', 'party', { x: 5, y: 5 })]);
    expect(packed).toBeGreaterThan(alone * 1.4);
  });

  it('в бою толпа множит урон толпового приёма', () => {
    // синтетический кит с gang 1: с двумя своими у цели множитель ×3 —
    // разрыв, который джиттер rollDamage (±15%) не перекрывает
    const PACK: WeaponSpec[] = [
      { name: 'клык', dmg: 10, range: 1, moves: [{ id: 'ghit', name: 'толпой', slot: 'attack', mult: 1, gang: 1 }] },
    ];
    const still = (id: string, x: number, y: number, side: Side = 'party'): UnitSpec => ({
      id, name: id, side, maxHp: 600, atk: 1, range: 1, speed: 1, move: 0,
      lenses: ['literalist'], rules: [], spawn: { x, y },
    });
    const scene = (allies: [number, number][]): UnitSpec[] => [
      {
        id: 'fang', name: 'fang', side: 'party', maxHp: 60, weapons: PACK,
        speed: 9, move: 0, lenses: ['plain'],
        rules: [rule({ kind: 'attack', target: 'nearest' })], spawn: { x: 5, y: 8 },
      },
      still('a1', allies[0]![0], allies[0]![1]),
      still('a2', allies[1]![0], allies[1]![1]),
      still('tank', 6, 8, 'foe'),
    ];
    // бросок привязан к моменту боя (план damage-types), а не к порядку
    // вызовов, поэтому у обоих прогонов один и тот же удар с одним и тем же
    // броском — разница ровно в том, стоят свои у цели или в стороне
    const landed = (allies: [number, number][]): Extract<BattleEvent, { t: 'attack' }> =>
      attacks(runBattle(5, scene(allies)).events, 'fang').find((a) => a.outcome !== 'miss')!;
    const crowd = landed([[6, 7], [6, 9]]);
    const alone = landed([[1, 1], [1, 3]]);
    expect(crowd.move).toBe('толпой');
    expect(crowd.dmg).toBeGreaterThanOrEqual(alone.dmg * 2.5); // двое своих у цели — ×3
  });
});

describe('волна 2: пуш-приём живёт у опасных клеток', () => {
  it('подсечка Лисы выигрывает у «в печень», когда за спиной цели шипы', () => {
    const tiles: Tile[][] = Array.from({ length: 18 }, () =>
      Array.from({ length: 18 }, () => ({}) as Tile),
    );
    const lisa = (rules: Rule[]): Fighter =>
      fighter('l', 'party', { x: 5, y: 8 }, { maxHp: 42, weapons: heroArchetype('lisa').weapons, atk: 6, range: 1, move: 0 }, rules);
    const pick = (withSpikes: boolean): string => {
      if (withSpikes) tiles[8]![7] = { hazard: 'spikes' } as Tile;
      else tiles[8]![7] = {} as Tile;
      const me = lisa([rule({ kind: 'attack', target: 'nearest' })]);
      const foe = fighter('e', 'foe', { x: 6, y: 8 });
      // тело за спиной глушит «отскок с уколом» — иначе выход из ZoC законно
      // перебивает и толчок, и чистый удар
      const body = fighter('b', 'party', { x: 4, y: 8 });
      const d = decide(me, [me, foe, body], 1, () => false, 2, makeCtx(() => false, tiles));
      return candMove(me, d.chosen).id;
    };
    expect(pick(true)).toBe('legSweep'); // толчок в шипы дороже чистого удара
    expect(pick(false)).toBe('liverStab'); // на чистом поле — обычный полный
  });
});

describe('волна 2: райдеры stepBack и twin в бою', () => {
  const still = (id: string, x: number, y: number, side: Side = 'foe'): UnitSpec => ({
    id, name: id, side, maxHp: 600, atk: 1, range: 1, speed: 1, move: 0,
    lenses: ['literalist'], rules: [], spawn: { x, y },
  });

  it('выстрел с отходом: после удара шаг строго от цели', () => {
    const HITRUN: WeaponSpec[] = [
      { name: 'тестолук', dmg: 6, range: 4, moves: [{ id: 'pshot', name: 'выстрел с отходом', slot: 'attack', mult: 0.8, stepBack: true }] },
    ];
    const specs: UnitSpec[] = [
      {
        id: 'shooter', name: 'shooter', side: 'party', maxHp: 40, weapons: HITRUN,
        speed: 9, move: 2, lenses: ['plain'],
        rules: [rule({ kind: 'attack', target: 'nearest' })], spawn: { x: 5, y: 8 },
      },
      still('tank', 6, 8),
    ];
    const res = runBattle(5, specs);
    const first = attacks(res.events, 'shooter')[0]!;
    const i = res.events.indexOf(first);
    const next = res.events[i + 1]!;
    expect(next.t).toBe('move');
    expect((next as Extract<BattleEvent, { t: 'move' }>).to).toEqual({ x: 4, y: 8 });
  });

  it('отскока нет, когда клетка позади занята телом', () => {
    const HITRUN: WeaponSpec[] = [
      { name: 'тестолук', dmg: 6, range: 4, moves: [{ id: 'pshot', name: 'выстрел с отходом', slot: 'attack', mult: 0.8, stepBack: true }] },
    ];
    const specs: UnitSpec[] = [
      {
        id: 'shooter', name: 'shooter', side: 'party', maxHp: 40, weapons: HITRUN,
        speed: 9, move: 0, lenses: ['plain'],
        rules: [rule({ kind: 'attack', target: 'nearest' })], spawn: { x: 5, y: 8 },
      },
      still('body', 4, 8, 'party'),
      still('tank', 6, 8),
    ];
    const res = runBattle(5, specs);
    const first = attacks(res.events, 'shooter')[0]!;
    const i = res.events.indexOf(first);
    expect(res.events[i + 1]!.t).not.toBe('move');
  });

  it('сдвоенный: одно решение — два удара по разным целям', () => {
    const TWINBOW: WeaponSpec[] = [
      { name: 'двойной лук', dmg: 6, range: 4, moves: [{ id: 'tshot', name: 'сдвоенный', slot: 'attack', mult: 0.5, twin: true }] },
    ];
    const specs: UnitSpec[] = [
      {
        id: 'shooter', name: 'shooter', side: 'party', maxHp: 40, weapons: TWINBOW,
        speed: 9, move: 0, lenses: ['plain'],
        rules: [rule({ kind: 'attack', target: 'nearest' })], spawn: { x: 4, y: 8 },
      },
      still('t1', 6, 8),
      still('t2', 6, 9),
    ];
    const res = runBattle(5, specs);
    const shooterAttacks = attacks(res.events, 'shooter');
    expect(shooterAttacks.length).toBeGreaterThanOrEqual(2);
    expect(shooterAttacks[0]!.target).not.toBe(shooterAttacks[1]!.target);
    expect(shooterAttacks[1]!.move).toBe('сдвоенный');
  });

  it('Дарт добивает пару: сдвоенный выигрывает у прицельного по двум подранкам', () => {
    const DART = heroArchetype('dart');
    const dart = fighter('d', 'party', { x: 4, y: 8 }, { maxHp: 48, weapons: DART.weapons, atk: 6, range: 5, move: 0 },
      [rule({ kind: 'attack', target: 'nearest' })]);
    // на 1 hp: даже половинная стрела снимает обоих — двойное добивание
    const w1 = fighter('w1', 'foe', { x: 6, y: 8 }, { maxHp: 30, hp: 1 });
    const w2 = fighter('w2', 'foe', { x: 6, y: 9 }, { maxHp: 30, hp: 1 });
    const d = decide(dart, [dart, w1, w2], 1, () => false, 2);
    expect(candMove(dart, d.chosen).id).toBe('splitShot');
  });
});

describe('карточки и норма действий', () => {
  it('карточка Грома: приёмы с уроном и райдерами', () => {
    // у приёма тип пишется, только если спорит с оружейным (план damage-types)
    expect(describeWeapons(GROM.weapons)).toBe(
      'меч и щит, рубящий (щитом в грудь 3 (дробящий, толкает); ' +
        'удар из-за щита 8 (без рипоста); верный рубящий 8)',
    );
  });

  it('киты: у каждого из 16 героев ≥5 действий, все на китах, аффинность изъята', () => {
    // действия = приёмы + активы + формы АОЕ + именные фишки (щит Грома −40%,
    // дешёвая глухая оборона Скалы)
    for (const h of HERO_POOL) {
      const moves = h.weapons.flatMap((w) => w.moves ?? []);
      expect(moves.length, h.id).toBeGreaterThan(0);
      expect(h.weapons.every((w) => w.affinity === undefined), h.id).toBe(true);
      const aoeForms = h.weapons.reduce((n, w) => n + Object.keys(w.aoe ?? {}).length, 0);
      const actives = Object.keys(h.active ?? {}).length;
      const named = (h.passives?.shieldwall ? 1 : 0) + (h.passives?.steadfast ? 1 : 0);
      expect(moves.length + aoeForms + actives + named, h.id).toBeGreaterThanOrEqual(5);
    }
  });

  it('пересечение внутри класса ≤2 (профиль приёма: темп + райдеры)', () => {
    const profile = (m: WeaponMove): string =>
      [
        m.slot,
        m.pierce !== undefined && 'pierce',
        m.sure && 'sure',
        m.expose && 'expose',
        m.push && 'push',
        m.gang !== undefined && 'gang',
        m.stepBack && 'stepBack',
        m.twin && 'twin',
        m.ap !== undefined && 'ap',
      ].filter(Boolean).join('|');
    const kit = (id: string): Set<string> =>
      new Set(heroArchetype(id).weapons.flatMap((w) => w.moves ?? []).map(profile));
    const pairs: [string, string][] = [
      ['grom', 'yar'],
      ['ulv', 'ryk'],
      ['dart', 'mara'],
      ['tessa', 'lisa'],
      ['lia', 'vesta'],
      ['iva', 'radim'],
      ['yuna', 'zhalo'],
      ['skala', 'zarya'],
    ];
    for (const [a, b] of pairs) {
      const A = kit(a);
      const shared = [...kit(b)].filter((p) => A.has(p));
      expect(shared.length, `${a}↔${b}: ${shared.join(', ')}`).toBeLessThanOrEqual(2);
    }
  });
});
