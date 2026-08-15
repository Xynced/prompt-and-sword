import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import { type Fighter, aoeDamage, decide, generateCandidates, rageReady } from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { heroArchetype } from '../src/heroes.js';
import { compilePhrase } from '../src/constructor.js';
import { describeActive } from '../src/cards.js';
import { CONCEPTS, RARE_WORDS } from '../src/vocab.js';
import { validateOutput } from '../src/compiler/schema.js';
import type { ActiveSpec, CombatUnit, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Ярость (план классов, шаг 2): первый длящийся статус — 1 AP, раз в бой,
 * до конца боя свой урон ×dmgMult и входящий ×vulnMult. Гейт как у кастов:
 * актив в спеке + сработавшее правило «впасть в ярость».
 */

const RAGE: ActiveSpec = { rage: { dmgMult: 1.3, vulnMult: 1.2 } };

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
    maxHp: 60,
    hp: 60,
    atk: 9,
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

const rule = (then: Rule['then'], when: Rule['when'] = { kind: 'always' }, weight = 2): Rule => ({
  when,
  then,
  weight,
  scope: 'self',
  source: 'тест',
});

describe('гейт ярости', () => {
  const foe = (): Fighter => fighter('e', 'foe', { x: 5, y: 4 });

  it('актив без сработавшего правила молчит; правило без актива — тоже', () => {
    const noWord = fighter('u', 'party', { x: 4, y: 4 }, { active: RAGE },
      [rule({ kind: 'attack', target: 'nearest' })]);
    expect(generateCandidates(noWord, [noWord, foe()]).some((c) => c.action === 'rage')).toBe(false);

    const noActive = fighter('u', 'party', { x: 4, y: 4 }, {},
      [rule({ kind: 'rage' })]);
    expect(generateCandidates(noActive, [noActive, foe()]).some((c) => c.action === 'rage')).toBe(false);
  });

  it('актив + сработавшее правило — кандидат есть, и decide его жмёт', () => {
    const u = fighter('u', 'party', { x: 4, y: 4 }, { active: RAGE },
      [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'rage' })]);
    expect(generateCandidates(u, [u, foe()]).some((c) => c.action === 'rage')).toBe(true);
    expect(decide(u, [u, foe()]).chosen.action).toBe('rage');
  });

  it('в ярости второго входа нет: rageReady гейтит', () => {
    const u = fighter('u', 'party', { x: 4, y: 4 }, { active: RAGE, raged: true },
      [rule({ kind: 'rage' })]);
    expect(rageReady(u)).toBe(false);
    expect(generateCandidates(u, [u, foe()]).some((c) => c.action === 'rage')).toBe(false);
  });

  it('условие правила решает КОГДА: «если врагов больше — ярись»', () => {
    const rules = [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'rage' }, { kind: 'outnumbered' })];
    const alone = fighter('u', 'party', { x: 4, y: 4 }, { active: RAGE }, rules);
    expect(generateCandidates(alone, [alone, foe()], undefined, 3, 1,
      alone.compiled.rules.filter((r) => r.when.kind === 'always'),
    ).some((c) => c.action === 'rage')).toBe(false);
    // decide сам фильтрует сработавшие: врагов больше — ярость на столе
    const crowd = [fighter('e2', 'foe', { x: 6, y: 4 }), fighter('e3', 'foe', { x: 6, y: 5 })];
    expect(decide(alone, [alone, foe(), ...crowd]).chosen.action).toBe('rage');
  });
});

describe('ярость в бою', () => {
  /** Ульв против неубиваемого манекена: затяжка гарантирована. */
  const ulv = (): UnitSpec => ({
    id: 'ulv', name: 'Ульв', side: 'party', maxHp: 200,
    weapons: heroArchetype('ulv').weapons, active: heroArchetype('ulv').active,
    speed: 9, move: 2, lenses: ['plain'],
    rules: [rule({ kind: 'attack', target: 'nearest' }), ...heroArchetype('ulv').innate],
    spawn: { x: 4, y: 4 },
  });
  const dummy = (atk = 10): UnitSpec => ({
    id: 'e', name: 'e', side: 'foe', maxHp: 400, atk, range: 1, speed: 1, move: 1,
    lenses: ['plain'], rules: [rule({ kind: 'attack', target: 'nearest' })], spawn: { x: 5, y: 4 },
  });

  const rageEvents = (events: readonly BattleEvent[]): { round: number; count: number } => {
    let round = 0;
    let first = 0;
    let count = 0;
    for (const e of events) {
      if (e.t === 'round') round = e.n;
      if (e.t === 'rage') {
        count++;
        if (first === 0) first = round;
      }
    }
    return { round: first, count };
  };

  it('врождённая Ярость Ульва: входит при затяжке (раунд ≥5), ровно раз за бой', () => {
    const r = runBattle(7, [ulv(), dummy()]);
    const { round, count } = rageEvents(r.events);
    expect(count).toBe(1);
    expect(round).toBeGreaterThanOrEqual(5);
  });

  it('после ярости секира бьёт сильнее (тот же сид, dmgMult 1.3 против 1.0)', () => {
    // манера «наверняка» стабилизирует последовательность действий — оба боя
    // рубят одинаково, и первый послеяростный удар сравним один к одному
    const withMult = (dmgMult: number): number => {
      const spec = ulv();
      spec.rules = [...spec.rules, rule({ kind: 'strikeHard' })];
      spec.active = { rage: { dmgMult, vulnMult: 1.2 } };
      const r = runBattle(7, [spec, dummy()]);
      let raged = false;
      for (const e of r.events) {
        if (e.t === 'rage') raged = true;
        if (raged && e.t === 'attack' && e.unit === 'ulv' && e.outcome !== 'miss') return e.dmg;
      }
      return 0;
    };
    const boosted = withMult(1.3);
    const plain = withMult(1.0);
    expect(plain).toBeGreaterThan(0);
    expect(boosted).toBeGreaterThan(plain);
  });

  it('в ярости получает больнее: aoeDamage множит на vulnMult', () => {
    const caster = fighter('c', 'foe', { x: 0, y: 0 }, { atk: 10 });
    const calm = fighter('u', 'party', { x: 1, y: 1 }, { active: RAGE });
    const raged = fighter('u', 'party', { x: 1, y: 1 }, { active: RAGE, raged: true });
    expect(aoeDamage(caster, 1, raged)).toBe(Math.round(aoeDamage(caster, 1, calm) * 1.2));
  });
});

describe('слово «впасть в ярость» по слоям', () => {
  it('словарь: глубокое слово с ярлыком', () => {
    expect(RARE_WORDS).toContain('act.rage');
    expect(CONCEPTS['act.rage'].label).toBe('впасть в ярость');
  });

  it('конструктор: гейт по словарю, компиляция в IR', () => {
    const draft = { condition: { id: 'cond.outnumbered' as const }, preference: { id: 'act.rage' as const } };
    expect(compilePhrase(draft, ['act.rage', 'cond.outnumbered'])).toMatchObject({
      ok: true,
      rule: { when: { kind: 'outnumbered' }, then: { kind: 'rage' } },
    });
    expect(compilePhrase(draft, ['cond.outnumbered'])).toMatchObject({ ok: false, missing: ['act.rage'] });
  });

  it('схема компилятора принимает слово только из открытого словаря', () => {
    const raw = { phrases: [{ condition: { id: 'always' }, preference: { id: 'act.rage' }, weight: 1 }], uncertainty: [] };
    expect(validateOutput(raw, ['act.rage'], [], 4).ok).toBe(true);
    expect(validateOutput(raw, [], [], 4).ok).toBe(false);
  });

  it('карточка актива показывает размен цифрами', () => {
    expect(describeActive(RAGE)).toBe('ярость (урон ×1.3, входящий ×1.2, до конца боя)');
  });
});
