import { describe, expect, it } from 'vitest';
import type { Rule } from '../src/ir.js';
import { applyLens } from '../src/lens.js';
import {
  type Candidate,
  effectiveGuard,
  makeCtx,
  scoreCandidate,
  stanceAttackMult,
  stanceGuard,
  stanceOf,
} from '../src/scoring.js';
import { BAIT_AC, BRACE_AC, HARD_PIERCE, OFTEN_STANCE_BONUS, WEAK_ATK_MULT } from '../src/tuning.js';
import { TERRAIN_LAYOUTS, tileAt } from '../src/terrain.js';
import { CONCEPTS, RETIRED_WORDS, UNLOCKABLE } from '../src/vocab.js';
import { type UnitSpec, runBattle } from '../src/battle.js';
import type { CombatUnit, Pos, WeaponMove } from '../src/types.js';

/**
 * Переработка мёртвого пласта слов (план words): стойки манер, приманка,
 * фланговый манёвр, кап «подальше», отрыв толчком, щель частокола, изъятие.
 */

type Fighter = CombatUnit & { compiled: ReturnType<typeof applyLens> };

function unit(id: string, side: 'party' | 'foe', pos: Pos, over: Partial<CombatUnit> = {}): CombatUnit {
  return {
    id, name: id, side, maxHp: 60, hp: 60, atk: 8, range: 1, speed: 5, move: 2,
    pos: { ...pos }, startPos: { ...pos }, alive: true, guard: 0, exposed: false,
    tags: [], lenses: ['plain'], ...over,
  };
}

function fighter(id: string, side: 'party' | 'foe', pos: Pos, rules: Rule[], over: Partial<CombatUnit> = {}): Fighter {
  return { ...unit(id, side, pos, over), compiled: applyLens(['plain'], rules) };
}

const rule = (then: Rule['then'], w = 2): Rule => ({
  when: { kind: 'always' },
  then,
  weight: w,
  scope: 'self',
  source: 'тест',
});

/** Вклад правила в оценку кандидата. */
function ruleFactor(cand: Candidate, self: Fighter, units: Fighter[], rules: Rule[]): number {
  const f = scoreCandidate(cand, self, units, rules).find((x) => x.label.startsWith('правило:'));
  return f?.value ?? 0;
}

// приёмы дефолт-тройки (план weapon-moves): стойки читают слот-темп приёма
const JAB: WeaponMove = { id: 'jab', name: 'тычок', slot: 'weakAttack', mult: WEAK_ATK_MULT };
const STRIKE: WeaponMove = { id: 'strike', name: 'удар', slot: 'attack', mult: 1 };

describe('стойки манер', () => {
  it('stanceOf собирает стойки из сработавших правил', () => {
    expect(stanceOf([rule({ kind: 'strikeOften' }), rule({ kind: 'bait' })])).toEqual({
      often: true, hard: false, bait: true, taunt: false, mark: false,
    });
    expect(stanceOf([rule({ kind: 'attack', target: 'nearest' })])).toEqual({
      often: false, hard: false, bait: false, taunt: false, mark: false,
    });
  });

  it('«часто»: слабый удар в стойке бьёт крепче', () => {
    const stance = { often: true, hard: false, bait: false };
    expect(stanceAttackMult(JAB, stance)).toBeCloseTo(WEAK_ATK_MULT + OFTEN_STANCE_BONUS);
    expect(stanceAttackMult(STRIKE, stance)).toBe(1);
    expect(stanceAttackMult(JAB, undefined)).toBeCloseTo(WEAK_ATK_MULT);
  });

  it('«наверняка»: полный удар режет бонус обороны, слабый — нет', () => {
    const stance = { often: false, hard: true, bait: false };
    expect(stanceGuard(BRACE_AC, STRIKE, stance)).toBe(Math.round(BRACE_AC * HARD_PIERCE));
    expect(stanceGuard(BRACE_AC, JAB, stance)).toBe(BRACE_AC);
    expect(stanceGuard(BRACE_AC, STRIKE, undefined)).toBe(BRACE_AC);
  });

  it('в бою стойка «наверняка» пробивает глухую оборону — урон заметно выше', () => {
    // буквалист без правил весь бой стоит в глухой обороне — идеальная мишень
    const turtle: UnitSpec = {
      id: 't', name: 'Панцирь', side: 'foe', maxHp: 200, atk: 1, range: 1,
      speed: 1, move: 0, lenses: ['literalist'], rules: [], spawn: { x: 6, y: 5 },
    };
    const run = (rules: Rule[]): { dmg: number; ripostes: number } => {
      const striker: UnitSpec = {
        id: 's', name: 'Боец', side: 'party', maxHp: 60, atk: 8, range: 1,
        speed: 5, move: 2, lenses: ['plain'], rules, spawn: { x: 4, y: 5 },
      };
      let dmg = 0;
      let ripostes = 0;
      for (const e of runBattle(7, [striker, turtle]).events) {
        if (e.t === 'attack' && e.unit === 's' && e.action === 'attack') dmg += e.dmg;
        if (e.t === 'riposte' && e.unit === 's') ripostes++;
      }
      return { dmg, ripostes };
    };
    const plain = run([rule({ kind: 'attack', target: 'nearest' })]);
    const hard = run([rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'strikeHard' })]);
    expect(plain.dmg).toBeGreaterThan(0);
    expect(hard.dmg).toBeGreaterThan(plain.dmg * 1.5);
    // расчётливый удар не напарывается на рипост обороны
    expect(hard.ripostes).toBe(0);
  });
});

describe('стойка приманки', () => {
  it('effectiveGuard: приманка держит плавающее прикрытие, максимум со своим', () => {
    const bait = unit('b', 'party', { x: 0, y: 0 }, { stance: { bait: true } });
    expect(effectiveGuard(bait, [bait])).toBe(BAIT_AC);
    bait.guard = BRACE_AC; // своё сильнее — берётся оно
    expect(effectiveGuard(bait, [bait])).toBe(BRACE_AC);
    const plain = unit('p', 'party', { x: 0, y: 0 });
    expect(effectiveGuard(plain, [plain])).toBe(0);
  });
});

describe('фланговый манёвр', () => {
  it('шаг во фланговую клетку у цели ценнее шага на сторону союзника', () => {
    // союзник прижался к цели слева — правая клетка фланговая (угол ≥ 90°),
    // клетка с той же стороны, что союзник, — нет
    const target = fighter('e', 'foe', { x: 6, y: 5 }, []);
    const ally = fighter('a', 'party', { x: 5, y: 5 }, []);
    const self = fighter('s', 'party', { x: 6, y: 3 }, [rule({ kind: 'flank' })]);
    const units = [self, ally, target];
    const flankStep = ruleFactor({ to: { x: 7, y: 5 }, action: 'move' }, self, units, [rule({ kind: 'flank' })]);
    const sameSide = ruleFactor({ to: { x: 5, y: 4 }, action: 'move' }, self, units, [rule({ kind: 'flank' })]);
    expect(flankStep).toBeGreaterThan(sameSide);
  });
});

describe('кап «держаться подальше»', () => {
  it('премия не растёт за безопасной дистанцией — стрелок не убегает вечно', () => {
    const foe = fighter('e', 'foe', { x: 0, y: 0 }, []);
    const self = fighter('s', 'party', { x: 4, y: 0 }, [], { range: 4, atk: 6 });
    const away: Rule = rule({ kind: 'awayFrom', ref: { type: 'enemy', sel: 'nearest' } });
    const units = [self, foe];
    const atCap = ruleFactor({ to: { x: 5, y: 0 }, action: 'move' }, self, units, [away]);
    const wayPast = ruleFactor({ to: { x: 12, y: 0 }, action: 'move' }, self, units, [away]);
    const tooClose = ruleFactor({ to: { x: 2, y: 0 }, action: 'move' }, self, units, [away]);
    expect(wayPast).toBeCloseTo(atCap); // за капом премия плоская
    expect(atCap).toBeGreaterThan(tooClose);
  });
});

describe('щель частокола', () => {
  it('на частоколе есть клетка «узкого места» — камни с двух сторон', () => {
    const fence = TERRAIN_LAYOUTS.find((l) => l.name === 'частокол')!;
    const gaps: Pos[] = [];
    for (let y = 1; y < 17; y++) {
      for (let x = 0; x < 18; x++) {
        if (tileAt(fence.tiles, { x, y }).blocked) continue;
        if (tileAt(fence.tiles, { x, y: y - 1 }).blocked && tileAt(fence.tiles, { x, y: y + 1 }).blocked) {
          gaps.push({ x, y });
        }
      }
    }
    expect(gaps.length).toBeGreaterThan(0);
  });
});

describe('изъятые слова', () => {
  it('«самый дальний» и «наши пали» не выпадают, но живы в словаре концептов', () => {
    for (const wId of RETIRED_WORDS) {
      expect(UNLOCKABLE).not.toContain(wId);
      expect(CONCEPTS[wId]).toBeDefined();
    }
  });
});
