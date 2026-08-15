import { describe, expect, it } from 'vitest';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { applyLens } from '../src/lens.js';
import { type Fighter, generateCandidates, makeCtx, scoreCandidate } from '../src/scoring.js';
import { HERO_POOL, heroArchetype } from '../src/heroes.js';
import { bonesetter, duelist, ogre, rat, sergeant, shaman, troll, warlord, wolf } from '../src/foes.js';
import { describeReaction } from '../src/cards.js';
import type { CombatUnit, Pos, ReactionKind, Side } from '../src/types.js';
import { ARCANE_SHIELD_AC, DEFLECT_AC, DODGE_AC, SUCCOR_HEAL } from '../src/tuning.js';
import type { Rule } from '../src/ir.js';

/**
 * Реакции (план reactions), волна 1: одна валюта на всё, что боец делает в
 * чужой ход. Блок щита, перехват телохранителя и рипост глухой обороны берут
 * реакцию из общего кармана и восстанавливают её в начале своего хода — как в
 * pf2e. До этого плана у танка их было три независимых, а рипост не считался
 * вовсе.
 */

const rule = (then: Rule['then'], when: Rule['when'] = { kind: 'always' }, weight = 3): Rule => ({
  when,
  then,
  weight,
  scope: 'self',
  source: 'тест',
});

const atkNearest = rule({ kind: 'attack', target: 'nearest' });

const spec = (over: Partial<UnitSpec> & Pick<UnitSpec, 'id' | 'side' | 'spawn'>): UnitSpec => ({
  name: over.id,
  maxHp: 200,
  atk: 8,
  range: 1,
  speed: 5,
  move: 0,
  lenses: ['plain'],
  rules: [],
  ...over,
});

const at = (x: number, y: number): Pos => ({ x, y });
const of = (evs: readonly BattleEvent[], t: BattleEvent['t']): BattleEvent[] => evs.filter((e) => e.t === t);

/** Сколько событий вида t пришлось на самый плотный раунд лога. */
function perRoundMax(evs: readonly BattleEvent[], t: BattleEvent['t']): number {
  let round = 0;
  const counts = new Map<number, number>();
  for (const e of evs) {
    if (e.t === 'round') round = e.n;
    if (e.t === t) counts.set(round, (counts.get(round) ?? 0) + 1);
  }
  return counts.size === 0 ? 0 : Math.max(...counts.values());
}

/** Реакции конкретного юнита по раундам: сумма всех каналов, что её тратят. */
function reactionsPerRound(evs: readonly BattleEvent[], unit: string): Map<number, string[]> {
  let round = 0;
  const out = new Map<number, string[]>();
  for (const e of evs) {
    if (e.t === 'round') round = e.n;
    const mine =
      (e.t === 'shieldBlock' && e.unit === unit) ||
      (e.t === 'intercept' && e.unit === unit) ||
      (e.t === 'riposte' && e.by === unit);
    if (mine) out.set(round, [...(out.get(round) ?? []), e.t]);
  }
  return out;
}

describe('одна реакция в раунд', () => {
  it('глухая оборона рипостит первому за раунд, второму уже нечем', () => {
    // цель стоит в глухой обороне под двумя ближниками: до плана оба платили
    // рипостом, теперь платит только тот, кто успел первым
    const brace: Side = 'party';
    const res = runBattle(11, [
      spec({
        id: 'wall',
        side: brace,
        spawn: at(5, 5),
        maxHp: 300,
        atk: 1,
        rules: [rule({ kind: 'brace' })],
      }),
      spec({ id: 'e0', side: 'foe', spawn: at(6, 5), atk: 8, rules: [atkNearest] }),
      spec({ id: 'e1', side: 'foe', spawn: at(6, 6), atk: 8, rules: [atkNearest] }),
    ]);
    const ripostes = of(res.events, 'riposte');
    expect(ripostes.length).toBeGreaterThan(0);
    expect(perRoundMax(res.events, 'riposte')).toBe(1);
  });

  it('реакция восстанавливается: рипост идёт раунд за раундом', () => {
    const res = runBattle(11, [
      spec({ id: 'wall', side: 'party', spawn: at(5, 5), maxHp: 300, atk: 1, rules: [rule({ kind: 'brace' })] }),
      spec({ id: 'e0', side: 'foe', spawn: at(6, 5), atk: 8, rules: [atkNearest] }),
      spec({ id: 'e1', side: 'foe', spawn: at(6, 6), atk: 8, rules: [atkNearest] }),
    ]);
    const rounds = new Set<number>();
    let round = 0;
    for (const e of res.events) {
      if (e.t === 'round') round = e.n;
      if (e.t === 'riposte') rounds.add(round);
    }
    expect(rounds.size).toBeGreaterThan(2);
  });

  // Гром при Лие: щит держит удар соседа справа, «прикрывай Лию» — удар
  // снизу. Порознь каждый канал работает каждый раунд, вместе им приходится
  // делить один карман
  const protectLia = rule({ kind: 'protect', ally: 'lia' });
  const guardScene = (opts: { shield?: boolean; protect?: boolean }): UnitSpec[] => [
    spec({
      id: 'grom',
      side: 'party',
      spawn: at(5, 6),
      maxHp: 400,
      atk: 1,
      ...(opts.shield ? { shield: { ac: 2, hardness: 3, hp: 999 } } : {}),
      rules: opts.protect ? [protectLia] : [],
    }),
    spec({ id: 'lia', side: 'party', spawn: at(5, 7), maxHp: 400, atk: 1 }),
    spec({ id: 'e0', side: 'foe', spawn: at(6, 6), atk: 8, rules: [atkNearest] }),
    spec({ id: 'e1', side: 'foe', spawn: at(5, 8), atk: 8, rules: [atkNearest] }),
  ];

  it('щитоносец-телохранитель тратит одну реакцию: перехват ИЛИ блок', () => {
    const res = runBattle(7, guardScene({ shield: true, protect: true }));
    const mine = reactionsPerRound(res.events, 'grom');
    expect(mine.size).toBeGreaterThan(0);
    // главный инвариант плана: ни в одном раунде у юнита не больше одной
    expect(Math.max(...[...mine.values()].map((xs) => xs.length))).toBe(1);
    // и оба канала за бой видны — карман общий, а не «щит всегда первый»
    const kinds = new Set([...mine.values()].flat());
    expect(kinds).toEqual(new Set(['shieldBlock', 'intercept']));
  });

  it('карман общий: вместе реакций ровно столько, сколько раундов', () => {
    const count = (specs: UnitSpec[]): number => {
      const res = runBattle(7, specs);
      return [...reactionsPerRound(res.events, 'grom').values()].flat().length;
    };
    const blockOnly = count(guardScene({ shield: true }));
    const guardOnly = count(guardScene({ protect: true }));
    const both = runBattle(7, guardScene({ shield: true, protect: true }));
    const together = [...reactionsPerRound(both.events, 'grom').values()].flat().length;
    expect(blockOnly).toBeGreaterThan(0);
    expect(guardOnly).toBeGreaterThan(0);
    // до плана было бы blockOnly + guardOnly; теперь потолок — раунд на реакцию
    expect(together).toBeLessThan(blockOnly + guardOnly);
    expect(together).toBeLessThanOrEqual(both.rounds);
  });
});

describe('ответный удар: у зоны контроля появились зубы', () => {
  const retreat = rule({ kind: 'retreat' }, { kind: 'always' }, 4);

  /** Уходящий беглец под носом у носителя ответного удара. */
  const scene = (over: Partial<UnitSpec> = {}): UnitSpec[] => [
    spec({
      id: 'holder',
      side: 'foe',
      spawn: at(5, 5),
      atk: 9,
      maxHp: 300,
      move: 0,
      reaction: 'reactiveStrike',
      rules: [],
    }),
    spec({ id: 'runner', side: 'party', spawn: at(6, 5), maxHp: 60, atk: 4, move: 3, rules: [retreat], ...over }),
  ];

  it('уход бегом из смежности ловит удар', () => {
    const res = runBattle(3, scene());
    const strikes = of(res.events, 'reactStrike') as Extract<BattleEvent, { t: 'reactStrike' }>[];
    expect(strikes.length).toBeGreaterThan(0);
    expect(strikes[0]!.unit).toBe('holder');
    expect(strikes[0]!.target).toBe('runner');
  });

  it('носитель без реакции никого не держит', () => {
    const res = runBattle(3, scene().map((u) => (u.id === 'holder' ? { ...u, reaction: undefined } : u)));
    expect(of(res.events, 'reactStrike')).toHaveLength(0);
  });

  it('шаг не провоцирует: осторожный шаг — это pf2e Step', () => {
    // тот же беглец, но ход стоит ровно на один осторожный шаг
    const res = runBattle(3, scene({ move: 1 }));
    let steps = 0;
    for (const e of res.events) if (e.t === 'decision' && e.action === 'carefulStep') steps++;
    expect(steps).toBeGreaterThan(0);
    // каждый уход шагом бесплатен: ответных ударов меньше, чем уходов
    expect(of(res.events, 'reactStrike').length).toBeLessThan(steps);
  });

  it('одна реакция: за раунд носитель бьёт в ответ не больше раза', () => {
    const res = runBattle(5, [
      spec({ id: 'holder', side: 'foe', spawn: at(5, 5), atk: 9, maxHp: 400, move: 0, reaction: 'reactiveStrike' }),
      spec({ id: 'r1', side: 'party', spawn: at(6, 5), maxHp: 200, atk: 4, move: 3, rules: [retreat] }),
      spec({ id: 'r2', side: 'party', spawn: at(4, 5), maxHp: 200, atk: 4, move: 3, rules: [retreat] }),
    ]);
    expect(of(res.events, 'reactStrike').length).toBeGreaterThan(0);
    expect(perRoundMax(res.events, 'reactStrike')).toBe(1);
  });

  it('удар приходит до сдвига — павшему уже некуда идти', () => {
    // в логе ответный удар стоит перед move того же решения: боец получает
    // его на клетке, с которой убегал, и, если удар смертелен, там и остаётся
    const res = runBattle(3, scene());
    const idx = res.events.findIndex((e) => e.t === 'reactStrike');
    expect(idx).toBeGreaterThan(0);
    expect(res.events[idx - 1]!.t).toBe('decision');
    const decision = res.events[idx - 1]! as Extract<BattleEvent, { t: 'decision' }>;
    expect(decision.action).toBe('move');
    const move = res.events[idx + 1]! as Extract<BattleEvent, { t: 'move' }>;
    expect(move.t).toBe('move');
    expect(move.from).toEqual(at(6, 5));
  });

});

describe('скоринг знает цену ухода', () => {
  const fighterOf = (id: string, side: Side, pos: Pos, over: Partial<CombatUnit> = {}, rules: Rule[] = []): Fighter => ({
    id,
    name: id,
    side,
    maxHp: 40,
    hp: 40,
    atk: 8,
    range: 1,
    speed: 5,
    move: 3,
    pos,
    startPos: { ...pos },
    alive: true,
    guard: 0,
    exposed: false,
    tags: [],
    lenses: ['plain'],
    ...over,
    compiled: applyLens(['plain'], rules),
  });

  it('уход бегом получает штраф, а осторожный шаг — нет', () => {
    const holder = fighterOf('holder', 'foe', at(5, 5), { reaction: 'reactiveStrike' });
    const me = fighterOf('me', 'party', at(6, 5), {}, [rule({ kind: 'retreat' })]);
    const units = [holder, me];
    const ctx = makeCtx();
    const away = { to: at(8, 5), action: 'move' as const };
    const step = { to: at(7, 5), action: 'carefulStep' as const };
    const label = 'инстинкт:ответный удар';
    const runF = scoreCandidate(away, me, units, me.compiled.rules, ctx).find((f) => f.label === label);
    expect(runF!.value).toBeLessThan(0);
    expect(scoreCandidate(step, me, units, me.compiled.rules, ctx).some((f) => f.label === label)).toBe(false);
  });

  it('рядом с носителем в кандидатах появляется осторожный шаг', () => {
    const holder = fighterOf('holder', 'foe', at(5, 5), { reaction: 'reactiveStrike' });
    const me = fighterOf('me', 'party', at(6, 5), {}, [rule({ kind: 'retreat' })]);
    const kinds = generateCandidates(me, [holder, me], undefined, 3).map((c) => c.action);
    expect(kinds).toContain('carefulStep');
    // без носителя чистых клеток осторожному шагу не предлагают
    const plain = fighterOf('plain', 'foe', at(5, 5));
    const bare = generateCandidates(me, [plain, me], undefined, 3).map((c) => c.action);
    expect(bare).not.toContain('carefulStep');
  });
});

describe('кому реакция роздана', () => {
  it('воины партии держат строй ответным ударом', () => {
    expect(heroArchetype('grom').reaction).toBe('reactiveStrike');
    expect(heroArchetype('yar').reaction).toBe('reactiveStrike');
  });

  it('крупные и обученные враги держат строй ответным ударом', () => {
    for (const f of [ogre(), troll(), sergeant(), warlord()]) {
      expect(f.reaction).toBe('reactiveStrike');
    }
  });

  it('роль решает вид реакции: стая не отпускает, поединщик ныряет', () => {
    expect(wolf(1).reaction).toBe('noEscape');
    expect(duelist().reaction).toBe('nimbleDodge');
    expect(shaman('x').reaction).toBe('arcaneShield');
    // масса и лекарь остаются без реакции — их роль другая
    expect(rat(1).reaction).toBeUndefined();
    expect(bonesetter('x').reaction).toBeUndefined();
  });
});

describe('защитные реакции: бонус к КБ против одного броска', () => {
  /** Ударник лупит по цели, у которой есть защитная реакция. */
  const duel = (reaction: ReactionKind | undefined, range = 1): UnitSpec[] => [
    spec({ id: 'atk', side: 'foe', spawn: at(5, 5), atk: 8, range, maxHp: 300, move: 0, rules: [atkNearest] }),
    spec({
      id: 'def',
      side: 'party',
      spawn: range === 1 ? at(6, 5) : at(9, 5),
      atk: 1,
      maxHp: 300,
      move: 0,
      ...(reaction ? { reaction } : {}),
    }),
  ];

  it('уворот встречает первый удар за раунд — и только его', () => {
    const res = runBattle(9, duel('nimbleDodge'));
    const guards = of(res.events, 'reactGuard') as Extract<BattleEvent, { t: 'reactGuard' }>[];
    expect(guards.length).toBeGreaterThan(0);
    expect(guards.every((g) => g.unit === 'def' && g.ac === DODGE_AC)).toBe(true);
    expect(perRoundMax(res.events, 'reactGuard')).toBe(1);
  });

  it('«отбить стрелу» работает против выстрела и молчит в ближнем бою', () => {
    const shot = runBattle(9, duel('deflectArrow', 4));
    const shots = of(shot.events, 'reactGuard') as Extract<BattleEvent, { t: 'reactGuard' }>[];
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((g) => g.ac === DEFLECT_AC)).toBe(true);
    expect(of(runBattle(9, duel('deflectArrow')).events, 'reactGuard')).toHaveLength(0);
  });

  it('щит волшебницы одноразовый: сработал — и до конца боя его нет', () => {
    const res = runBattle(9, duel('arcaneShield'));
    const guards = of(res.events, 'reactGuard') as Extract<BattleEvent, { t: 'reactGuard' }>[];
    expect(guards).toHaveLength(1);
    expect(guards[0]!.ac).toBe(ARCANE_SHIELD_AC);
    expect(res.units.find((u) => u.id === 'def')!.arcaneShieldSpent).toBe(true);
  });

  it('уворот бережёт hp: та же сцена без реакции кончается раньше', () => {
    const rounds = (reaction: ReactionKind | undefined): number => {
      let sum = 0;
      for (let seed = 1; seed <= 10; seed++) {
        const res = runBattle(seed * 31, duel(reaction).map((u) => (u.id === 'def' ? { ...u, maxHp: 60 } : u)));
        sum += res.rounds;
      }
      return sum;
    };
    expect(rounds('nimbleDodge')).toBeGreaterThan(rounds(undefined));
  });
});

describe('реакции за своего и в погоню', () => {
  it('воздаяние: обидчику смежного своего прилетает в ответ', () => {
    const res = runBattle(4, [
      spec({ id: 'foe', side: 'foe', spawn: at(5, 5), atk: 8, maxHp: 300, move: 0, rules: [atkNearest] }),
      spec({ id: 'ward', side: 'party', spawn: at(6, 5), atk: 1, maxHp: 300, move: 0 }),
      // паладин стоит плечом к плечу с подопечным и достаёт обидчика оружием
      spec({ id: 'pal', side: 'party', spawn: at(7, 5), atk: 8, range: 2, maxHp: 300, move: 0, reaction: 'retributiveStrike' }),
    ]);
    const answers = (of(res.events, 'reactStrike') as Extract<BattleEvent, { t: 'reactStrike' }>[])
      .filter((e) => e.unit === 'pal' && e.target === 'foe');
    expect(answers.length).toBeGreaterThan(0);
    expect(perRoundMax(res.events, 'reactStrike')).toBe(1);
  });

  it('заступление: жрец штопает раненого своего прямо в чужой ход', () => {
    const res = runBattle(4, [
      spec({ id: 'foe', side: 'foe', spawn: at(5, 5), atk: 8, maxHp: 300, move: 0, rules: [atkNearest] }),
      spec({ id: 'ward', side: 'party', spawn: at(6, 5), atk: 1, maxHp: 300, move: 0 }),
      spec({ id: 'cleric', side: 'party', spawn: at(6, 7), atk: 1, range: 3, maxHp: 300, move: 0, reaction: 'succor' }),
    ]);
    const heals = of(res.events, 'reactHeal') as Extract<BattleEvent, { t: 'reactHeal' }>[];
    expect(heals.length).toBeGreaterThan(0);
    expect(heals.every((h) => h.unit === 'cleric' && h.target === 'ward' && h.amount <= SUCCOR_HEAL)).toBe(true);
  });

  it('«не уйдёшь»: варвар шагает следом, а не бьёт', () => {
    const res = runBattle(3, [
      spec({ id: 'barb', side: 'foe', spawn: at(5, 5), atk: 8, maxHp: 300, move: 0, reaction: 'noEscape' }),
      spec({
        id: 'runner',
        side: 'party',
        spawn: at(6, 5),
        maxHp: 60,
        atk: 4,
        move: 3,
        speed: 9,
        rules: [rule({ kind: 'retreat' }, { kind: 'always' }, 4)],
      }),
    ]);
    const steps = of(res.events, 'reactStep') as Extract<BattleEvent, { t: 'reactStep' }>[];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((e) => e.unit === 'barb' && e.target === 'runner')).toBe(true);
    // погоня — вместо удара: варвар в ответ не бьёт
    expect(of(res.events, 'reactStrike')).toHaveLength(0);
  });

  it('«сорвать добычу»: стрелок бьёт вслед помеченному издали, прочих отпускает', () => {
    const hunted = (tags: string[]): number => {
      const res = runBattle(3, [
        spec({ id: 'ranger', side: 'foe', spawn: at(5, 5), atk: 7, range: 5, maxHp: 300, move: 0, reaction: 'disruptPrey' }),
        spec({
          id: 'runner',
          side: 'party',
          spawn: at(7, 5),
          maxHp: 200,
          atk: 4,
          move: 3,
          speed: 9,
          tags,
          rules: [rule({ kind: 'retreat' }, { kind: 'always' }, 4)],
        }),
      ]);
      return of(res.events, 'reactStrike').length;
    };
    expect(hunted(['marked'])).toBeGreaterThan(0);
    expect(hunted([])).toBe(0);
  });
});

describe('реакция есть у каждого класса', () => {
  it('все 16 героев носят реакцию — по одной на каждый из восьми классов', () => {
    for (const h of HERO_POOL) expect(h.reaction).toBeDefined();
    // ярлыки классов разнесены по роду («монах»/«монахиня»), поэтому считаем
    // сами реакции: их ровно восемь, по паре героев на каждую
    const kinds = new Map<ReactionKind, number>();
    for (const h of HERO_POOL) kinds.set(h.reaction!, (kinds.get(h.reaction!) ?? 0) + 1);
    expect(kinds.size).toBe(8);
    expect([...kinds.values()].every((n) => n === 2)).toBe(true);
  });

  it('каждая реакция названа в карточке героя', () => {
    for (const h of HERO_POOL) expect(describeReaction(h.reaction!)).toContain('одна в раунд');
  });
});
