import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import { type Fighter, blessReady, decide, generateCandidates, healReady } from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { heroArchetype } from '../src/heroes.js';
import { compilePhrase } from '../src/constructor.js';
import { describeActive } from '../src/cards.js';
import { CONCEPTS, RARE_WORDS } from '../src/vocab.js';
import { validateOutput } from '../src/compiler/schema.js';
import type { ActiveSpec, CombatUnit, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Лечение и благословение (план классов, шаг 6): первый «hp вверх» в симе
 * (Ива) и второй длящийся бафф (Радим). Гейт активов — прецедент ярости:
 * спека + сработавшее правило.
 */

const HEAL: ActiveSpec = { heal: { amount: 10, range: 4, usesPerBattle: 2 } };
const BLESS: ActiveSpec = { bless: { dmgMult: 1.25, range: 3, usesPerBattle: 1 } };

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

describe('лечение: гейт и выбор цели', () => {
  const foe = (): Fighter => fighter('e', 'foe', { x: 12, y: 12 });

  it('нужны актив, сработавшее правило и раненый в дальности', () => {
    const healer = (rules: Rule[], over: Partial<CombatUnit> = {}): Fighter =>
      fighter('h', 'party', { x: 4, y: 4 }, { active: HEAL, ...over }, rules);
    const hurt = fighter('a', 'party', { x: 5, y: 4 }, { hp: 15 });
    const fine = fighter('a', 'party', { x: 5, y: 4 });
    const farHurt = fighter('a', 'party', { x: 12, y: 4 }, { hp: 15 });

    const has = (self: Fighter, ally: Fighter): boolean =>
      generateCandidates(self, [self, ally, foe()]).some((c) => c.action === 'heal');
    expect(has(healer([rule({ kind: 'heal' })]), hurt)).toBe(true);
    expect(has(healer([rule({ kind: 'attack', target: 'nearest' })]), hurt)).toBe(false); // нет правила
    expect(has(healer([rule({ kind: 'heal' })], { active: undefined }), hurt)).toBe(false); // нет актива
    expect(has(healer([rule({ kind: 'heal' })]), fine)).toBe(false); // никто не ранен
    expect(has(healer([rule({ kind: 'heal' })]), farHurt)).toBe(false); // вне дальности
  });

  it('лечит того, кому хуже всех (премия по нужде)', () => {
    const healer = fighter('h', 'party', { x: 4, y: 4 }, { active: HEAL }, [rule({ kind: 'heal' })]);
    const scratched = fighter('a1', 'party', { x: 5, y: 4 }, { hp: 34 });
    const dying = fighter('a2', 'party', { x: 3, y: 4 }, { hp: 8 });
    const d = decide(healer, [healer, scratched, dying, foe()]);
    expect(d.chosen.action).toBe('heal');
    expect(d.chosen.targetId).toBe('a2');
  });
});

describe('лечение в бою', () => {
  it('Ива врождённо лечит раненого: +amount с капом, заряды считаны', () => {
    const iva: UnitSpec = {
      id: 'iva', name: 'Ива', side: 'party', maxHp: 44,
      weapons: heroArchetype('iva').weapons, active: heroArchetype('iva').active,
      speed: 9, move: 2, lenses: ['plain'],
      rules: [...heroArchetype('iva').innate], spawn: { x: 3, y: 4 },
    };
    const hurt: UnitSpec = {
      id: 'a', name: 'a', side: 'party', maxHp: 60, hp: 20, atk: 7, range: 1,
      speed: 8, move: 2, lenses: ['plain'],
      rules: [rule({ kind: 'attack', target: 'nearest' })], spawn: { x: 4, y: 4 },
    };
    const tank: UnitSpec = {
      id: 'e', name: 'e', side: 'foe', maxHp: 400, atk: 4, range: 1, speed: 1, move: 1,
      lenses: ['plain'], rules: [rule({ kind: 'attack', target: 'nearest' })], spawn: { x: 8, y: 4 },
    };
    const r = runBattle(5, [iva, hurt, tank]);
    const heals = r.events.filter((e): e is BattleEvent & { t: 'heal' } => e.t === 'heal');
    expect(heals.length).toBeGreaterThan(0);
    expect(heals.length).toBeLessThanOrEqual(2); // usesPerBattle 2
    expect(heals[0]).toMatchObject({ unit: 'iva', target: 'a', amount: 10, hp: 30 });
  });

  it('кап: восстановление не поднимает выше максимума', () => {
    const iva: UnitSpec = {
      id: 'iva', name: 'Ива', side: 'party', maxHp: 44,
      weapons: heroArchetype('iva').weapons, active: heroArchetype('iva').active,
      speed: 9, move: 2, lenses: ['plain'],
      rules: [...heroArchetype('iva').innate], spawn: { x: 3, y: 4 },
    };
    const nicked: UnitSpec = {
      id: 'a', name: 'a', side: 'party', maxHp: 60, hp: 57, atk: 7, range: 1,
      speed: 8, move: 0, lenses: ['plain'], rules: [], spawn: { x: 4, y: 4 },
    };
    const tank: UnitSpec = {
      id: 'e', name: 'e', side: 'foe', maxHp: 400, atk: 1, range: 1, speed: 1, move: 0,
      lenses: ['plain'], rules: [], spawn: { x: 8, y: 4 },
    };
    const r = runBattle(5, [iva, nicked, tank]);
    for (const e of r.events) {
      if (e.t === 'heal') {
        expect(e.hp).toBeLessThanOrEqual(60);
        expect(e.amount).toBeLessThanOrEqual(3);
      }
    }
  });

  it('healReady: лимит на бой', () => {
    const h = fighter('h', 'party', { x: 0, y: 0 }, { active: HEAL });
    expect(healReady(h)).toBe(true);
    h.healUses = 2;
    expect(healReady(h)).toBe(false);
  });
});

describe('благословение', () => {
  it('кандидаты: только другие союзники в дальности, ещё не благословлённые', () => {
    const priest = fighter('p', 'party', { x: 4, y: 4 }, { active: BLESS }, [rule({ kind: 'bless' })]);
    const near = fighter('a1', 'party', { x: 5, y: 4 });
    const far = fighter('a2', 'party', { x: 12, y: 4 });
    const done = fighter('a3', 'party', { x: 4, y: 5 }, { blessedMult: 1.25 });
    const foe = fighter('e', 'foe', { x: 12, y: 12 });
    const targets = generateCandidates(priest, [priest, near, far, done, foe])
      .filter((c) => c.action === 'bless')
      .map((c) => c.targetId);
    expect(targets).toEqual(['a1']); // не себя, не дальнего, не повторно
  });

  it('премия выбирает самого ударного союзника', () => {
    const priest = fighter('p', 'party', { x: 4, y: 4 }, { active: BLESS }, [rule({ kind: 'bless' })]);
    const soft = fighter('a1', 'party', { x: 5, y: 4 }, { atk: 5 });
    const hard = fighter('a2', 'party', { x: 3, y: 4 }, { atk: 9 });
    const foe = fighter('e', 'foe', { x: 12, y: 12 });
    const d = decide(priest, [priest, soft, hard, foe]);
    expect(d.chosen.action).toBe('bless');
    expect(d.chosen.targetId).toBe('a2');
  });

  it('в бою: удары благословлённого тяжелее (тот же сид, ×1.25 против ×1)', () => {
    const withBless = (dmgMult: number): number => {
      const radim: UnitSpec = {
        id: 'radim', name: 'Радим', side: 'party', maxHp: 72,
        weapons: heroArchetype('radim').weapons,
        active: { bless: { dmgMult, range: 3, usesPerBattle: 1 } },
        speed: 9, move: 0, lenses: ['plain'],
        rules: [...heroArchetype('radim').innate], spawn: { x: 3, y: 4 },
      };
      const striker: UnitSpec = {
        id: 's', name: 's', side: 'party', maxHp: 60, atk: 9, range: 4, speed: 8, move: 0,
        lenses: ['plain'],
        rules: [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'strikeHard' })],
        spawn: { x: 4, y: 4 },
      };
      // танк вплотную к стрелку: никакой камень арены не перекроет выстрел
      const tank: UnitSpec = {
        id: 'e', name: 'e', side: 'foe', maxHp: 400, atk: 1, range: 1, speed: 1, move: 0,
        lenses: ['plain'], rules: [], spawn: { x: 5, y: 4 },
      };
      const r = runBattle(2, [radim, striker, tank]);
      let blessed = false;
      let sum = 0;
      let n = 0;
      for (const e of r.events) {
        if (e.t === 'bless') blessed = true;
        if (blessed && e.t === 'attack' && e.unit === 's' && n < 5) {
          sum += e.dmg;
          n++;
        }
      }
      return sum;
    };
    const boosted = withBless(1.25);
    const plain = withBless(1.0);
    expect(plain).toBeGreaterThan(0);
    expect(boosted).toBeGreaterThan(plain);
  });

  it('blessReady: лимит на бой', () => {
    const p = fighter('p', 'party', { x: 0, y: 0 }, { active: BLESS });
    expect(blessReady(p)).toBe(true);
    p.blessUses = 1;
    expect(blessReady(p)).toBe(false);
  });
});

describe('слово «лечить» по слоям', () => {
  it('словарь: базовое слово с ярлыком', () => {
    // по аудиту слов «лечить» — редкое: гейт актива Ивы, +6пп winrate и +9пп живучести
    expect(RARE_WORDS).toContain('act.heal');
    expect(CONCEPTS['act.heal'].label).toBe('лечить');
  });

  it('конструктор: гейт по словарю, компиляция в IR', () => {
    const draft = { condition: { id: 'cond.outnumbered' as const }, preference: { id: 'act.heal' as const } };
    expect(compilePhrase(draft, ['act.heal', 'cond.outnumbered'])).toMatchObject({
      ok: true,
      rule: { when: { kind: 'outnumbered' }, then: { kind: 'heal' } },
    });
    expect(compilePhrase(draft, ['cond.outnumbered'])).toMatchObject({ ok: false, missing: ['act.heal'] });
  });

  it('схема компилятора принимает слово только из открытого словаря', () => {
    const raw = { phrases: [{ condition: { id: 'always' }, preference: { id: 'act.heal' }, weight: 1 }], uncertainty: [] };
    expect(validateOutput(raw, ['act.heal'], [], 4).ok).toBe(true);
    expect(validateOutput(raw, [], [], 4).ok).toBe(false);
  });

  it('карточки активов показывают цифры', () => {
    expect(describeActive(HEAL)).toBe('исцеление (+10 hp, дальность 4, 2 на бой)');
    expect(describeActive(BLESS)).toBe('благословение (урон союзника ×1.25, до конца боя, 1 на бой)');
  });
});
