import { describe, expect, it } from 'vitest';
import { type Rule, evalCondition } from '../src/ir.js';
import { applyLens } from '../src/lens.js';
import { decide } from '../src/scoring.js';
import {
  type PhraseDraft,
  type PhraseNodeDraft,
  compileNested,
  compilePhrase,
} from '../src/constructor.js';
import { CONCEPTS, STARTING_VOCAB, type ConceptId } from '../src/vocab.js';
import { ruleRu } from '../src/cards.js';
import { type UnitSpec, runBattle } from '../src/battle.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import type { CombatUnit, Pos } from '../src/types.js';

/**
 * Глубокие чипсы: конъюнкция условий «и» (and) и вложенные группы —
 * if (a) { if (b) { doA }; if (c) { doB } } → правила a∧b→doA, a∧c→doB.
 */

const FULL_VOCAB = Object.keys(CONCEPTS) as ConceptId[];

function unit(id: string, side: 'party' | 'foe', pos: Pos, over: Partial<CombatUnit> = {}): CombatUnit {
  return {
    id, name: id, side, maxHp: 40, hp: 40, atk: 6, range: 1, speed: 5, move: 2,
    pos: { ...pos }, startPos: { ...pos }, alive: true, coverLevel: 0, exposed: false,
    tags: [], lenses: ['plain'], ...over,
  };
}

type Fighter = CombatUnit & { compiled: ReturnType<typeof applyLens> };

function fighter(id: string, side: 'party' | 'foe', pos: Pos, rules: Rule[] = [], over: Partial<CombatUnit> = {}): Fighter {
  return { ...unit(id, side, pos, over), compiled: applyLens(['plain'], rules) };
}

describe('evalCondition: and', () => {
  it('истинно, только когда истинны все части', () => {
    const self = unit('a', 'party', { x: 3, y: 3 }, { hp: 10 });
    const e1 = unit('e1', 'foe', { x: 4, y: 3 });
    const e2 = unit('e2', 'foe', { x: 3, y: 4 });
    const both: Rule['when'] = {
      kind: 'and',
      conds: [{ kind: 'surrounded' }, { kind: 'hpBelow', who: 'self', frac: 0.5 }],
    };
    expect(evalCondition(both, self, [self, e1, e2])).toBe(true);
    // не окружён — конъюнкция гаснет
    expect(evalCondition(both, self, [self, e1])).toBe(false);
    // окружён, но цел
    const healthy = unit('a', 'party', { x: 3, y: 3 });
    expect(evalCondition(both, healthy, [healthy, e1, e2])).toBe(false);
  });
});

describe('evalCondition: or', () => {
  it('истинно при любой истинной части, ложно без единой', () => {
    const self = unit('a', 'party', { x: 3, y: 3 });
    const melee = unit('e1', 'foe', { x: 9, y: 9 });
    const either: Rule['when'] = {
      kind: 'or',
      conds: [{ kind: 'enemyShooters' }, { kind: 'enemyCasters' }],
    };
    expect(evalCondition(either, self, [self, melee])).toBe(false);
    const archer = unit('e2', 'foe', { x: 10, y: 9 }, { range: 4 });
    expect(evalCondition(either, self, [self, melee, archer])).toBe(true);
  });

  it('вложенная форма and[or[…], …] вычисляется рекурсивно', () => {
    const self = unit('a', 'party', { x: 3, y: 3 });
    const e1 = unit('e1', 'foe', { x: 4, y: 3 }, { range: 4 });
    const e2 = unit('e2', 'foe', { x: 3, y: 4 });
    const when: Rule['when'] = {
      kind: 'and',
      conds: [
        { kind: 'or', conds: [{ kind: 'enemyShooters' }, { kind: 'enemyCasters' }] },
        { kind: 'surrounded' },
      ],
    };
    expect(evalCondition(when, self, [self, e1, e2])).toBe(true);
    // стрелок пал — «или» гаснет, конъюнкция тоже
    e1.alive = false;
    expect(evalCondition(when, self, [self, e1, e2])).toBe(false);
  });
});

describe('конструктор: условие «или»', () => {
  it('or-фраза компилируется в дизъюнкцию с читаемым source', () => {
    const draft: PhraseDraft = {
      condition: { id: 'or', conds: [{ id: 'cond.outnumbered' }, { id: 'cond.surrounded' }] },
      preference: { id: 'act.retreat' },
    };
    const r = compilePhrase(draft, FULL_VOCAB);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rule.when).toEqual({ kind: 'or', conds: [{ kind: 'outnumbered' }, { kind: 'surrounded' }] });
    expect(r.rule.source).toBe('если врагов больше или если меня окружили: отступать');
  });

  it('закрытое слово внутри «или» — ошибка компиляции', () => {
    const draft: PhraseDraft = {
      condition: { id: 'or', conds: [{ id: 'cond.hpBelow', who: 'self', frac: 0.5 }, { id: 'cond.alone' }] },
      preference: { id: 'act.retreat' },
    };
    const r = compilePhrase(draft, STARTING_VOCAB);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(['cond.alone']);
  });
});

describe('конструктор: условие «и»', () => {
  it('and-фраза компилируется в правило с конъюнкцией и вложенным source', () => {
    const draft: PhraseDraft = {
      condition: { id: 'and', conds: [{ id: 'cond.outnumbered' }, { id: 'cond.surrounded' }] },
      preference: { id: 'act.brace' },
    };
    const r = compilePhrase(draft, FULL_VOCAB);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rule.when).toEqual({ kind: 'and', conds: [{ kind: 'outnumbered' }, { kind: 'surrounded' }] });
    expect(r.rule.source).toBe('если врагов больше: если меня окружили: вставать в глухую оборону');
  });

  it('закрытое слово внутри «и» — ошибка компиляции, а не догадка', () => {
    const draft: PhraseDraft = {
      condition: { id: 'and', conds: [{ id: 'cond.hpBelow', who: 'self', frac: 0.5 }, { id: 'cond.surrounded' }] },
      preference: { id: 'act.retreat' },
    };
    const r = compilePhrase(draft, STARTING_VOCAB);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(['cond.surrounded']);
  });
});

describe('compileNested: вложенные группы', () => {
  it('if (a) { if (b) doA; if (c) doB } → два правила с конъюнкциями', () => {
    const node: PhraseNodeDraft = {
      condition: { id: 'cond.outnumbered' },
      branches: [
        { condition: { id: 'cond.surrounded' }, preference: { id: 'act.brace' }, weight: 2 },
        { condition: { id: 'cond.hpBelow', who: 'self', frac: 0.3 }, preference: { id: 'act.retreat' } },
      ],
    };
    const r = compileNested(node, FULL_VOCAB);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules).toHaveLength(2);
    expect(r.rules[0]!.when).toEqual({ kind: 'and', conds: [{ kind: 'outnumbered' }, { kind: 'surrounded' }] });
    expect(r.rules[0]!.then.kind).toBe('brace');
    expect(r.rules[0]!.weight).toBe(3); // вес листа × 1.5, как у плоской фразы
    expect(r.rules[1]!.when).toEqual({
      kind: 'and',
      conds: [{ kind: 'outnumbered' }, { kind: 'hpBelow', who: 'self', frac: 0.3 }],
    });
    expect(r.rules[1]!.then.kind).toBe('retreat');
    expect(r.rules[1]!.source).toBe('если врагов больше: если hp ниже 30%: отступать');
  });

  it('три уровня вложенности сплющиваются в одну конъюнкцию', () => {
    const node: PhraseNodeDraft = {
      condition: { id: 'cond.outnumbered' },
      branches: [
        {
          condition: { id: 'cond.enemyShooters' },
          branches: [{ condition: { id: 'cond.alone' }, preference: { id: 'space.behindCover' } }],
        },
      ],
    };
    const r = compileNested(node, FULL_VOCAB);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]!.when).toEqual({
      kind: 'and',
      conds: [{ kind: 'outnumbered' }, { kind: 'enemyShooters' }, { kind: 'alone' }],
    });
  });

  it('«или» внутри группы остаётся вложенным условием конъюнкции', () => {
    const node: PhraseNodeDraft = {
      condition: { id: 'cond.surrounded' },
      branches: [
        {
          condition: { id: 'or', conds: [{ id: 'cond.enemyShooters' }, { id: 'cond.enemyCasters' }] },
          preference: { id: 'space.behindCover' },
        },
      ],
    };
    const r = compileNested(node, FULL_VOCAB);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]!.when).toEqual({
      kind: 'and',
      conds: [
        { kind: 'surrounded' },
        { kind: 'or', conds: [{ kind: 'enemyShooters' }, { kind: 'enemyCasters' }] },
      ],
    });
    expect(r.rules[0]!.source).toBe(
      'если меня окружили: если у врага стрелки или если у врага заклинатель: держаться за укрытием',
    );
  });

  it('группа с condition=always не плодит пустых конъюнкций', () => {
    const node: PhraseNodeDraft = {
      condition: { id: 'always' },
      branches: [
        { condition: { id: 'always' }, preference: { id: 'act.holdPosition' } },
        { condition: { id: 'cond.hpBelow', who: 'self', frac: 0.5 }, preference: { id: 'act.retreat' } },
      ],
    };
    const r = compileNested(node, FULL_VOCAB);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules[0]!.when).toEqual({ kind: 'always' });
    expect(r.rules[1]!.when).toEqual({ kind: 'hpBelow', who: 'self', frac: 0.5 });
  });

  it('закрытые концепты собираются со всего дерева без повторов', () => {
    const node: PhraseNodeDraft = {
      condition: { id: 'cond.surrounded' },
      branches: [
        { condition: { id: 'always' }, preference: { id: 'act.brace' } },
        { condition: { id: 'always' }, preference: { id: 'act.brace' } },
      ],
    };
    const r = compileNested(node, STARTING_VOCAB);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(['cond.surrounded', 'act.brace']);
  });
});

describe('решение и бой: and-правило', () => {
  const braceWhenBoth = (): Rule => ({
    when: { kind: 'and', conds: [{ kind: 'outnumbered' }, { kind: 'surrounded' }] },
    then: { kind: 'brace' },
    weight: 3,
    scope: 'self',
    source: 'если врагов больше: если меня окружили: глухая оборона',
  });

  it('правило горит только при обоих условиях (condRules это видит)', () => {
    const near = fighter('e1', 'foe', { x: 4, y: 3 });
    const far = fighter('e2', 'foe', { x: 9, y: 9 });
    // врагов больше, но не окружён
    const aloneSelf = fighter('a', 'party', { x: 3, y: 3 }, [braceWhenBoth()]);
    expect(decide(aloneSelf, [aloneSelf, near, far]).condRules).toBe(0);
    // врагов больше И окружили — конъюнкция горит
    const near2 = fighter('e3', 'foe', { x: 3, y: 4 });
    const boxed = fighter('a', 'party', { x: 3, y: 3 }, [braceWhenBoth()]);
    expect(decide(boxed, [boxed, near, near2, far]).condRules).toBe(1);
  });

  it('бой с and-правилами детерминирован: тот же seed — тот же лог', () => {
    const spec = (id: string, side: 'party' | 'foe', rules: Rule[]): UnitSpec => ({
      id, name: id, side, maxHp: 30, atk: 5, range: 1, speed: 5, move: 2, lenses: ['plain'], rules,
    });
    const specs = (): UnitSpec[] => [
      spec('a', 'party', [braceWhenBoth(), { when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1.5, scope: 'self', source: 'бей ближайшего' }]),
      spec('e1', 'foe', [{ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1.5, scope: 'self', source: 'бей' }]),
      spec('e2', 'foe', [{ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1.5, scope: 'self', source: 'бей' }]),
    ];
    const a = runBattle(11, specs());
    const b = runBattle(11, specs());
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });
});

describe('линзы: and-правило проходит трансформацию целым', () => {
  it('фанатик перекраивает действие, не трогая конъюнкцию', () => {
    const r: Rule = {
      when: { kind: 'and', conds: [{ kind: 'outnumbered' }, { kind: 'surrounded' }] },
      then: { kind: 'wait' },
      weight: 1.5,
      scope: 'self',
      source: 'если врагов больше: если окружили: ждать',
    };
    const c = applyLens(['fanatic'], [r]);
    expect(c.rules[0]!.then).toEqual({ kind: 'attack', target: 'nearest' });
    expect(c.rules[0]!.when.kind).toBe('and');
  });
});

describe('карточка и LLM-схема: and', () => {
  it('ruleRu читает конъюнкцию сцепкой «если … — если … — »', () => {
    const r: Rule = {
      when: { kind: 'and', conds: [{ kind: 'outnumbered' }, { kind: 'surrounded' }] },
      then: { kind: 'brace' },
      weight: 3,
      scope: 'self',
      source: 'тест',
    };
    expect(ruleRu(r)).toBe('если врагов больше, чем нас — если меня окружили — встаю в глухую оборону, когда до меня могут достать');
  });

  it('ruleRu читает дизъюнкцию через «или»', () => {
    const r: Rule = {
      when: { kind: 'or', conds: [{ kind: 'outnumbered' }, { kind: 'surrounded' }] },
      then: { kind: 'retreat' },
      weight: 3,
      scope: 'self',
      source: 'тест',
    };
    expect(ruleRu(r)).toBe('если врагов больше, чем нас — или если меня окружили — отхожу');
  });

  it('валидатор принимает «или» из открытого словаря и режет прочее', () => {
    const ok = {
      phrases: [{
        condition: { id: 'or', conds: [{ id: 'cond.outnumbered' }, { id: 'cond.surrounded' }] },
        preference: { id: 'act.retreat' },
        weight: 1,
      }],
      uncertainty: [],
    };
    expect(validateOutput(ok, FULL_VOCAB, [], 4).ok).toBe(true);
    expect(validateOutput(ok, STARTING_VOCAB, [], 4).ok).toBe(false);
    // and внутри or — не грамматика
    const mixed = {
      phrases: [{
        condition: {
          id: 'or',
          conds: [{ id: 'cond.outnumbered' }, { id: 'and', conds: [{ id: 'cond.surrounded' }, { id: 'cond.alone' }] }],
        },
        preference: { id: 'act.retreat' },
        weight: 1,
      }],
      uncertainty: [],
    };
    expect(validateOutput(mixed, FULL_VOCAB, [], 4).ok).toBe(false);
  });

  it('схема включает ветки «and» и «or» при открытых условиях; валидатор строг', () => {
    const s = JSON.stringify(buildCompileSchema(FULL_VOCAB, []));
    expect(s).toContain('"and"');
    expect(s).toContain('"or"');
    // в стартовом словаре есть условие (hpBelow) — грамматика связок доступна
    const start = JSON.stringify(buildCompileSchema(STARTING_VOCAB, []));
    expect(start).toContain('"and"');
    expect(start).toContain('"or"');

    const ok = {
      phrases: [{
        condition: { id: 'and', conds: [{ id: 'cond.outnumbered' }, { id: 'cond.surrounded' }] },
        preference: { id: 'act.brace' },
        weight: 1,
      }],
      uncertainty: [],
    };
    expect(validateOutput(ok, FULL_VOCAB, [], 4).ok).toBe(true);
    // закрытое слово внутри and — отказ целиком
    expect(validateOutput(ok, STARTING_VOCAB, [], 4).ok).toBe(false);
    // вложенный and и одиночный and — не грамматика
    const nested = {
      phrases: [{
        condition: { id: 'and', conds: [{ id: 'cond.outnumbered' }, { id: 'and', conds: [{ id: 'cond.surrounded' }, { id: 'cond.alone' }] }] },
        preference: { id: 'act.brace' },
        weight: 1,
      }],
      uncertainty: [],
    };
    expect(validateOutput(nested, FULL_VOCAB, [], 4).ok).toBe(false);
    const single = {
      phrases: [{
        condition: { id: 'and', conds: [{ id: 'cond.outnumbered' }] },
        preference: { id: 'act.brace' },
        weight: 1,
      }],
      uncertainty: [],
    };
    expect(validateOutput(single, FULL_VOCAB, [], 4).ok).toBe(false);
  });
});
