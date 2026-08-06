import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import {
  AOE_RITUAL_RADIUS,
  type Fighter,
  decide,
  generateCandidates,
  isAttack,
  isMovement,
  makeCtx,
  predictedPos,
  ritualReady,
  scoreCandidate,
  zoneDangerAt,
} from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { dist } from '../src/grid.js';
import { expectedDamage } from '../src/tuning.js';
import { heroArchetype } from '../src/heroes.js';
import type { AoeSpec, CombatUnit, LensId, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Ритуал (план АОЕ, шаг 2): телеграфированная зона 5×5, замах — весь ход
 * (3 AP), бьёт всех в зоне в начале следующего хода кастера. Смерть кастера
 * отменяет зону; перезарядка в раундах и лимит применений на бой — из спеки.
 */

const RITUAL: AoeSpec = { ritual: { range: 4, mult: 1.2, cooldown: 3 } };

function fighter(id: string, side: Side, pos: Pos, over: Partial<CombatUnit> = {}, rules: Rule[] = []): Fighter {
  return {
    id,
    name: id,
    side,
    maxHp: 20,
    hp: 20,
    atk: 5,
    range: 1,
    speed: 5,
    move: 3,
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

const evOf = <T extends BattleEvent['t']>(events: readonly BattleEvent[], t: T): Extract<BattleEvent, { t: T }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: T }> => e.t === t);

/** Раунд, в котором случилось событие с данным индексом. */
function roundAt(events: readonly BattleEvent[], idx: number): number {
  let round = 0;
  for (let i = 0; i <= idx; i++) {
    const e = events[i]!;
    if (e.t === 'round') round = e.n;
  }
  return round;
}

describe('готовность ритуала', () => {
  it('перезарядка и лимит применений гейтят кандидатов', () => {
    const caster = fighter('c', 'party', { x: 5, y: 5 }, { aoe: RITUAL }, [rule({ kind: 'barrage' })]);
    const e1 = fighter('e1', 'foe', { x: 8, y: 5 });
    const units = [caster, e1];

    expect(generateCandidates(caster, units, undefined, 3, 1).some((c) => c.action === 'aoeRitual')).toBe(true);

    // висящая зона — нового замаха нет
    caster.pendingRitual = { at: { x: 8, y: 5 } };
    expect(generateCandidates(caster, units, undefined, 3, 1).some((c) => c.action === 'aoeRitual')).toBe(false);
    caster.pendingRitual = undefined;

    // перезарядка: замах в раунде 1 → готов не раньше раунда 4
    caster.lastRitualRound = 1;
    expect(ritualReady(caster, 2)).toBe(false);
    expect(ritualReady(caster, 3)).toBe(false);
    expect(ritualReady(caster, 4)).toBe(true);
    expect(generateCandidates(caster, units, undefined, 3, 3).some((c) => c.action === 'aoeRitual')).toBe(false);
    expect(generateCandidates(caster, units, undefined, 3, 4).some((c) => c.action === 'aoeRitual')).toBe(true);

    // лимит применений на бой
    const once = fighter('o', 'party', { x: 5, y: 5 }, {
      aoe: { ritual: { range: 4, mult: 1.2, usesPerBattle: 1 } },
    }, [rule({ kind: 'barrage' })]);
    expect(ritualReady(once, 1)).toBe(true);
    once.ritualUses = 1;
    expect(ritualReady(once, 20)).toBe(false);
  });

  it('на замах нужен весь ход: при 2 AP кандидатов нет', () => {
    const caster = fighter('c', 'party', { x: 5, y: 5 }, { aoe: RITUAL }, [rule({ kind: 'barrage' })]);
    const e1 = fighter('e1', 'foe', { x: 8, y: 5 });
    expect(generateCandidates(caster, [caster, e1], undefined, 2, 1).some((c) => c.action === 'aoeRitual')).toBe(false);
  });
});

describe('ритуал в бою (гать, сид 4)', () => {
  const dummy = (id: string, side: Side, spawn: Pos, hp: number): UnitSpec => ({
    id, name: id, side, maxHp: hp, atk: 1, range: 1, speed: 1, move: 0,
    lenses: ['plain'], rules: [], spawn,
  });
  const caster = (over: Partial<UnitSpec> = {}): UnitSpec => ({
    id: 'c', name: 'c', side: 'foe', maxHp: 40, atk: 5, range: 1, speed: 9, move: 1,
    lenses: ['plain'], aoe: RITUAL,
    rules: [rule({ kind: 'barrage' })], spawn: { x: 8, y: 8 }, ...over,
  });

  it('замах в ход N, залп в начале хода N+1: бьёт присутствие с множителем 1.2', () => {
    const r = runBattle(4, [
      caster(),
      dummy('d1', 'party', { x: 8, y: 5 }, 30),
      dummy('d2', 'party', { x: 9, y: 5 }, 30),
    ]);
    expect(r.terrain.name).toBe('гать');
    const tele = evOf(r.events, 'telegraph');
    const casts = evOf(r.events, 'aoeCast').filter((c) => c.form === 'ritual');
    expect(tele.length).toBeGreaterThan(0);
    expect(casts.length).toBeGreaterThan(0);
    // залп ровно через ход после замаха, тем же центром
    const teleRound = roundAt(r.events, r.events.indexOf(tele[0]!));
    const castRound = roundAt(r.events, r.events.indexOf(casts[0]!));
    expect(castRound).toBe(teleRound + 1);
    expect(casts[0]!.at).toEqual(tele[0]!.at);
    // манекены стоят (move 0) — накрыты оба; но глухая защита манекенов
    // работает против зоны, поэтому проверяем номинал через телеграф
    expect(tele[0]!.dmg).toBe(Math.round(expectedDamage(5) * 1.2));
    const hits = evOf(r.events, 'aoeHit');
    expect(hits.filter((h) => h.by === 'c').map((h) => h.unit).sort()).toContain('d1');
  });

  it('перезарядка 3 держит ритм: между замахами не меньше трёх раундов', () => {
    const r = runBattle(4, [
      caster(),
      dummy('d1', 'party', { x: 8, y: 5 }, 60),
      dummy('d2', 'party', { x: 9, y: 5 }, 60),
    ]);
    const tele = evOf(r.events, 'telegraph');
    expect(tele.length).toBeGreaterThan(1);
    const rounds = tele.map((t) => roundAt(r.events, r.events.indexOf(t)));
    for (let i = 1; i < rounds.length; i++) {
      expect(rounds[i]! - rounds[i - 1]!).toBeGreaterThanOrEqual(3);
    }
  });

  it('подвижные манекены выходят из зоны: первый ритуал бьёт пусто', () => {
    const runner = (id: string, spawn: Pos): UnitSpec => ({
      id, name: id, side: 'party', maxHp: 30, atk: 1, range: 1, speed: 1, move: 2,
      lenses: ['plain'], rules: [], spawn,
    });
    const r = runBattle(4, [caster(), runner('d1', { x: 8, y: 5 }), runner('d2', { x: 9, y: 5 })]);
    const firstFire = r.events.findIndex((e) => e.t === 'aoeCast' && e.form === 'ritual');
    expect(firstFire).toBeGreaterThan(-1);
    // между замахом и залпом у каждого был ход — из зоны вышли, жертв нет
    expect(r.events[firstFire + 1]!.t).not.toBe('aoeHit');
  });

  it('смерть кастера между замахом и залпом отменяет зону', () => {
    // убийца медленнее кастера (ходит после замаха), но бьёт насмерть.
    // Кастер — фанатик: не прячется в глухую защиту от соседа с топором,
    // а машет ритуал (обычный кастер на 10 hp разумно паникует)
    const killer: UnitSpec = {
      id: 'k', name: 'k', side: 'party', maxHp: 40, atk: 40, range: 1, speed: 5, move: 3,
      lenses: ['plain'], rules: [rule({ kind: 'attack', target: 'nearest' })], spawn: { x: 7, y: 8 },
    };
    const r = runBattle(4, [
      caster({ maxHp: 10, lenses: ['fanatic'] }),
      killer,
      dummy('d1', 'party', { x: 8, y: 5 }, 30),
      dummy('d2', 'party', { x: 9, y: 5 }, 30),
    ]);
    const tele = evOf(r.events, 'telegraph');
    expect(tele.length).toBe(1);
    expect(evOf(r.events, 'die').some((d) => d.unit === 'c')).toBe(true);
    // зона умерла вместе с кастером: залпа ритуала нет
    expect(evOf(r.events, 'aoeCast').filter((c) => c.form === 'ritual').length).toBe(0);
    expect(r.winner).toBe('party');
  });
});

describe('уклонение от зоны замаха (канал опасности)', () => {
  // враг-кастер с висящей зоной 5×5 у (8,8): урон 16 по цели в 20 hp.
  // Сам кастер далеко и обездвижен — угрозой в скоринге не участвует
  const pendingCaster = (): Fighter => {
    const c = fighter('z', 'foe', { x: 16, y: 16 }, {
      atk: 9, move: 0, aoe: { ritual: { range: 12, mult: 3 } },
    });
    c.pendingRitual = { at: { x: 8, y: 8 } };
    return c;
  };
  const withLens = (f: Fighter, lenses: LensId[], rules: Rule[]): Fighter => {
    f.compiled = applyLens(lenses, rules);
    return f;
  };
  const atkRule = [rule({ kind: 'attack', target: 'nearest' })];

  it('канал видит зону: урон суммируется по накрытым клеткам, вне зоны — ноль', () => {
    const caster = pendingCaster();
    const target = fighter('t', 'party', { x: 8, y: 8 });
    expect(zoneDangerAt({ x: 8, y: 8 }, [caster, target], target)).toBe(16);
    expect(zoneDangerAt({ x: 10, y: 10 }, [caster, target], target)).toBe(16); // край зоны
    expect(zoneDangerAt({ x: 11, y: 8 }, [caster, target], target)).toBe(0);
  });

  it('юнит без правил выходит из зоны между замахом и залпом', () => {
    const caster = pendingCaster();
    const subject = fighter('s', 'party', { x: 8, y: 8 });
    const d = decide(subject, [subject, caster]);
    expect(isMovement(d.chosen.action)).toBe(true);
    expect(dist(d.chosen.to, { x: 8, y: 8 })).toBeGreaterThan(2);
  });

  it('трус бросает цель и выходит; фанатик остаётся бить', () => {
    const caster = pendingCaster();
    const prey = fighter('g', 'foe', { x: 8, y: 7 }, { move: 0 });

    const coward = withLens(fighter('cw', 'party', { x: 8, y: 8 }), ['coward'], atkRule);
    const dc = decide(coward, [coward, prey, caster]);
    expect(isMovement(dc.chosen.action)).toBe(true);
    expect(dist(dc.chosen.to, { x: 8, y: 8 })).toBeGreaterThan(2);

    const fanatic = withLens(fighter('fn', 'party', { x: 8, y: 8 }), ['fanatic'], atkRule);
    const df = decide(fanatic, [fanatic, prey, caster]);
    expect(isAttack(df.chosen.action)).toBe(true);
    expect(df.chosen.targetId).toBe('g');
  });

  it('слово «обходить опасное» уводит из зоны даже ради удара; без слова — бьёт', () => {
    const caster = pendingCaster();
    const prey = fighter('g', 'foe', { x: 8, y: 7 }, { move: 0 });

    const плотный = fighter('p', 'party', { x: 8, y: 8 }, {}, atkRule);
    expect(isAttack(decide(плотный, [плотный, prey, caster]).chosen.action)).toBe(true);

    const осторожный = fighter('o', 'party', { x: 8, y: 8 }, {}, [...atkRule, rule({ kind: 'avoidHazard' })]);
    const d = decide(осторожный, [осторожный, prey, caster]);
    expect(isMovement(d.chosen.action)).toBe(true);
    expect(dist(d.chosen.to, { x: 8, y: 8 })).toBeGreaterThan(2);
  });

  it('толчок в зону замаха обыгрывает атаку — комбо с союзным ритуалом', () => {
    // союзник замахнулся у (8,4); толкнуть врага с (8,7) на (8,6) — в зону
    const allyCaster = fighter('z', 'party', { x: 2, y: 2 }, {
      atk: 9, move: 0, aoe: { ritual: { range: 12, mult: 3 } },
    });
    allyCaster.pendingRitual = { at: { x: 8, y: 4 } };
    const pusher = fighter('s', 'party', { x: 8, y: 8 }, {}, [...atkRule, rule({ kind: 'shove' })]);
    const enemy = fighter('e', 'foe', { x: 8, y: 7 }, { move: 0 });
    const d = decide(pusher, [pusher, enemy, allyCaster]);
    expect(d.chosen.action).toBe('shove');
    expect(d.chosen.targetId).toBe('e');
  });
});

describe('слова АОЕ: интервал и упреждение (шаг 5)', () => {
  it('«держать интервал»: штраф вплотную к союзнику при живом носителе, молчит без него', () => {
    const spreadRule = [rule({ kind: 'spread' })];
    const self = fighter('s', 'party', { x: 5, y: 5 }, {}, spreadRule);
    const ally = fighter('a', 'party', { x: 5, y: 6 }, { move: 0 });
    const carrier = fighter('c', 'foe', { x: 14, y: 5 }, {
      move: 0, aoe: { blast: { range: 4, mult: 0.75 } },
    });
    const plainFoe = fighter('p', 'foe', { x: 14, y: 5 }, { move: 0 });

    const near = { to: { x: 5, y: 5 }, action: 'move' as const };
    const withCarrier = scoreCandidate(near, self, [self, ally, carrier], self.compiled.rules);
    expect(withCarrier.some((f) => f.label === 'правило:тест' && f.value < 0)).toBe(true);

    const without = scoreCandidate(near, self, [self, ally, plainFoe], self.compiled.rules);
    expect(without.some((f) => f.label === 'правило:тест')).toBe(false);

    // в решении: уходит от союзника на дистанцию 2, вплотную не остаётся
    const d = decide(self, [self, ally, carrier]);
    expect(dist(d.chosen.to, ally.pos)).toBeGreaterThanOrEqual(2);
  });

  it('«бить на упреждение»: ритуал целит в проекцию движения, а не в текущее скопление', () => {
    const ctx = makeCtx();
    // двое врагов бегут к жертве слева; кастер в дальнем углу — не ближайшая
    // цель бегунов, его зона не приманка
    const prey = fighter('v', 'party', { x: 2, y: 8 }, { move: 0 });
    const r1 = fighter('e1', 'foe', { x: 12, y: 8 }, { move: 2 });
    const r2 = fighter('e2', 'foe', { x: 13, y: 8 }, { move: 2 });
    const mkCaster = (rules: Rule[]): Fighter =>
      fighter('c', 'party', { x: 0, y: 17 }, { atk: 6, aoe: { ritual: { range: 14, mult: 1.2 } } }, rules);
    const coversBoth = (at: Pos, units: Fighter[]): boolean =>
      [r1, r2].every((e) => dist(predictedPos(e, units, ctx), at) <= AOE_RITUAL_RADIUS);

    const plainCaster = mkCaster([rule({ kind: 'barrage' })]);
    const unitsPlain = [plainCaster, prey, r1, r2];
    const dp = decide(plainCaster, unitsPlain, 1, undefined, 3, ctx);
    expect(dp.chosen.action).toBe('aoeRitual');

    const preemptCaster = mkCaster([rule({ kind: 'barrage' }), rule({ kind: 'preempt' })]);
    const unitsPre = [preemptCaster, prey, r1, r2];
    const df = decide(preemptCaster, unitsPre, 1, undefined, 3, ctx);
    expect(df.chosen.action).toBe('aoeRitual');
    // прогноз: враги сдвинутся к жертве влево
    expect(predictedPos(r1, unitsPre, ctx).x).toBeLessThan(r1.pos.x);
    // с упреждением зона накрывает обе проекции, без слова — нет
    expect(coversBoth(df.chosen.at!, unitsPre)).toBe(true);
    expect(coversBoth(dp.chosen.at!, unitsPlain)).toBe(false);
  });

  it('Лия: и ритуал, и залп — ровно раз в бой', () => {
    const lia = heroArchetype('lia');
    const spec: UnitSpec = {
      id: 'lia', name: 'Лия', side: 'party',
      maxHp: 200, atk: lia.stats.atk, range: lia.stats.range, speed: 9, move: lia.stats.move,
      lenses: ['plain'], aoe: lia.aoe,
      rules: [rule({ kind: 'barrage' })], spawn: { x: 8, y: 8 },
    };
    const tank = (id: string, spawn: Pos): UnitSpec => ({
      id, name: id, side: 'foe', maxHp: 90, atk: 1, range: 1, speed: 1, move: 0,
      lenses: ['plain'], rules: [], spawn,
    });
    const r = runBattle(4, [spec, tank('f1', { x: 8, y: 5 }), tank('f2', { x: 9, y: 5 })]);
    const tele = r.events.filter((e) => e.t === 'telegraph');
    expect(tele.length).toBe(1); // ритуал: usesPerBattle 1 — второго замаха нет
    const blasts = r.events.filter((e) => e.t === 'aoeCast' && e.form === 'blast');
    expect(blasts.length).toBe(1); // заряд: usesPerBattle 1 — второго залпа нет
  });
});

describe('линзы и АОЕ (шаг 6)', () => {
  const rules = [rule({ kind: 'barrage' })];
  const scene = (lenses: LensId[]): { self: Fighter; units: Fighter[] } => {
    const self = fighter('s', 'party', { x: 5, y: 5 }, { atk: 6, aoe: { blast: { range: 4, mult: 0.75 } } }, rules);
    self.compiled = applyLens(lenses, rules);
    const e1 = fighter('e1', 'foe', { x: 8, y: 8 });
    const e2 = fighter('e2', 'foe', { x: 9, y: 8 });
    const ally = fighter('a', 'party', { x: 8, y: 8 + 1 });
    return { self, units: [self, e1, e2, ally] };
  };

  it('фанатику своих в зоне не жалко (ffCare 0), обычному — жалко', () => {
    const cand = { to: { x: 5, y: 5 }, action: 'aoeBlast' as const, at: { x: 8, y: 8 } };
    const plain = scene(['plain']);
    expect(scoreCandidate(cand, plain.self, plain.units, plain.self.compiled.rules)
      .some((f) => f.label === 'свои в зоне')).toBe(true);
    const fanatic = scene(['fanatic']);
    expect(fanatic.self.compiled.instincts.ffCare).toBe(0);
    expect(scoreCandidate(cand, fanatic.self, fanatic.units, fanatic.self.compiled.rules)
      .some((f) => f.label === 'свои в зоне')).toBe(false);
  });

  it('дуэлянту касты недостойны: кандидатов нет даже со словом и оружием', () => {
    const duelist = scene(['duelist']);
    const cands = generateCandidates(duelist.self, duelist.units);
    expect(cands.some((c) => c.action === 'aoeBlast' || c.action === 'aoeLine' || c.action === 'aoeRitual')).toBe(false);
  });

  it('горячке замах невыносим: тяга к ритуалу 0.3', () => {
    const hothead = applyLens(['hothead'], rules);
    expect(hothead.instincts.actionBias.aoeRitual).toBe(0.3);
    expect(hothead.instincts.actionBias.aoeBlast).toBeUndefined(); // залп «сейчас» — не тронут
  });
});
