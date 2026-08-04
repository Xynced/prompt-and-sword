import { describe, expect, it } from 'vitest';
import { type Rule, evalCondition, resolveSelector } from '../src/ir.js';
import { applyLens } from '../src/lens.js';
import { type Candidate, type Fighter, scoreCandidate } from '../src/scoring.js';
import { type PhraseDraft, compilePhrase } from '../src/constructor.js';
import { CONCEPTS, STARTING_VOCAB, type ConceptId } from '../src/vocab.js';
import { understandingCard } from '../src/cards.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import type { CombatUnit, Pos } from '../src/types.js';

/** Глубокий словарь фазы 6: 6 концептов поверх позднего словаря. */

const FULL_VOCAB = Object.keys(CONCEPTS) as ConceptId[];

function unit(id: string, side: 'party' | 'foe', pos: Pos, over: Partial<CombatUnit> = {}): CombatUnit {
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
    defending: false,
    tags: [],
    lenses: ['plain'],
    ...over,
  };
}

function fighter(id: string, side: 'party' | 'foe', pos: Pos, over: Partial<CombatUnit> = {}): Fighter {
  return { ...unit(id, side, pos, over), compiled: applyLens(['plain'], []) };
}

const rule = (then: Rule['then'], w = 2): Rule => ({
  when: { kind: 'always' },
  then,
  weight: w,
  scope: 'self',
  source: 'тест',
});

/** Фактор вклада правила в оценку кандидата (0, если правило не отметилось). */
function ruleFactor(cand: Candidate, self: Fighter, units: Fighter[], r: Rule): number {
  const f = scoreCandidate(cand, self, units, [r]).find((x) => x.label.startsWith('правило:'));
  return f?.value ?? 0;
}

describe('условия глубокого словаря', () => {
  it('allyFallen: срабатывает, когда погиб союзник, а не враг и не я сам', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const ally = unit('b', 'party', { x: 1, y: 0 });
    const foe = unit('e1', 'foe', { x: 5, y: 5 }, { alive: false });
    expect(evalCondition({ kind: 'allyFallen' }, self, [self, ally, foe])).toBe(false);
    ally.alive = false;
    expect(evalCondition({ kind: 'allyFallen' }, self, [self, ally, foe])).toBe(true);
  });

  it('surrounded: двое вплотную — окружили, один — нет', () => {
    const self = unit('a', 'party', { x: 3, y: 3 });
    const e1 = unit('e1', 'foe', { x: 4, y: 3 });
    const e2 = unit('e2', 'foe', { x: 3, y: 4 });
    expect(evalCondition({ kind: 'surrounded' }, self, [self, e1])).toBe(false);
    expect(evalCondition({ kind: 'surrounded' }, self, [self, e1, e2])).toBe(true);
  });
});

describe('селекторы глубокого словаря', () => {
  it('shooter — ближайший стрелок; стрелков нет — просто ближайший', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const meleeNear = unit('e1', 'foe', { x: 1, y: 0 });
    const archerFar = unit('e2', 'foe', { x: 5, y: 0 }, { range: 4 });
    const archerNear = unit('e3', 'foe', { x: 3, y: 0 }, { range: 4 });
    expect(resolveSelector('shooter', self, [self, meleeNear, archerFar, archerNear])?.id).toBe('e3');
    expect(resolveSelector('shooter', self, [self, meleeNear])?.id).toBe('e1');
  });

  it('farthest — максимальная дистанция, тайбрейк по id', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const near = unit('e1', 'foe', { x: 1, y: 0 });
    const far = unit('e2', 'foe', { x: 6, y: 6 });
    expect(resolveSelector('farthest', self, [self, near, far])?.id).toBe('e2');
  });
});

describe('скоринг глубоких предпочтений', () => {
  it('brace: премия глухой обороне только под досягаемостью врага', () => {
    const self = fighter('a', 'party', { x: 3, y: 3 });
    const foe = fighter('e1', 'foe', { x: 5, y: 3 }, { move: 3, range: 1 });
    const units = [self, foe];
    const r = rule({ kind: 'brace' });
    const braced = ruleFactor({ to: self.pos, action: 'defend' }, self, units, r);
    const idle = ruleFactor({ to: self.pos, action: 'wait' }, self, units, r);
    expect(braced).toBeGreaterThan(0);
    expect(idle).toBe(0);
    // вне досягаемости оборона дешевле, чем под ударом
    const far = ruleFactor({ to: { x: 0, y: 7 }, action: 'defend' }, self, units, r);
    expect(braced).toBeGreaterThan(far);
  });

  it('awayFrom: чем дальше от якоря, тем лучше', () => {
    const self = fighter('a', 'party', { x: 3, y: 3 });
    const bully = fighter('e1', 'foe', { x: 4, y: 3 }, { atk: 9 });
    const weak = fighter('e2', 'foe', { x: 0, y: 0 }, { atk: 2 });
    const units = [self, bully, weak];
    const r = rule({ kind: 'awayFrom', ref: { type: 'enemy', sel: 'mostDangerous' } });
    const close = ruleFactor({ to: { x: 3, y: 3 }, action: 'wait' }, self, units, r);
    const away = ruleFactor({ to: { x: 1, y: 6 }, action: 'wait' }, self, units, r);
    expect(away).toBeGreaterThan(close);
  });
});

describe('линзы и глубокий словарь', () => {
  it('фанатик и горячка превращают глухую оборону в атаку', () => {
    for (const lens of ['fanatic', 'hothead'] as const) {
      const c = applyLens([lens], [rule({ kind: 'brace' })]);
      expect(c.rules[0]!.then).toEqual({ kind: 'attack', target: 'nearest' });
    }
  });
});

describe('конструктор: глубокие концепты', () => {
  it('новые фразы компилируются в IR при открытом словаре', () => {
    const cases: [PhraseDraft, Rule['then']['kind']][] = [
      [{ condition: { id: 'cond.allyFallen' }, preference: { id: 'act.brace' } }, 'brace'],
      [{ condition: { id: 'cond.surrounded' }, preference: { id: 'act.retreat' } }, 'retreat'],
      [{ condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.shooter' } }, 'attack'],
      [{ condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.farthest' } }, 'attack'],
      [
        { condition: { id: 'always' }, preference: { id: 'space.awayFrom', ref: { enemy: 'sel.mostDangerous' } } },
        'awayFrom',
      ],
    ];
    for (const [draft, kind] of cases) {
      const r = compilePhrase(draft, FULL_VOCAB);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.rule.then.kind).toBe(kind);
    }
  });

  it('в стартовом словаре глубокие концепты закрыты', () => {
    const r = compilePhrase(
      { condition: { id: 'always' }, preference: { id: 'act.brace' } },
      STARTING_VOCAB,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(['act.brace']);
  });
});

describe('карточки и LLM-схема: глубокие концепты', () => {
  it('карточка читает новые предпочтения по-русски', () => {
    const card = understandingCard({ name: 'Мара', lenses: ['plain'] }, [
      rule({ kind: 'brace' }),
      rule({ kind: 'awayFrom', ref: { type: 'enemy', sel: 'shooter' } }),
    ]);
    expect(card.lines[0]).toContain('оборону');
    expect(card.lines[1]).toContain('подальше от стрелка');
  });

  it('открытый концепт попадает в схему и валидацию, закрытый — нет', () => {
    const s = JSON.stringify(buildCompileSchema(FULL_VOCAB, ['lia']));
    expect(s).toContain('act.brace');
    expect(s).toContain('sel.shooter');
    expect(s).toContain('space.awayFrom');
    const start = JSON.stringify(buildCompileSchema(STARTING_VOCAB, ['lia']));
    expect(start).not.toContain('act.brace');
    expect(start).not.toContain('cond.surrounded');

    const raw = {
      phrases: [{ condition: { id: 'cond.surrounded' }, preference: { id: 'act.brace' }, weight: 1 }],
      uncertainty: [],
    };
    expect(validateOutput(raw, FULL_VOCAB, [], 4).ok).toBe(true);
    expect(validateOutput(raw, STARTING_VOCAB, [], 4).ok).toBe(false);
  });
});
