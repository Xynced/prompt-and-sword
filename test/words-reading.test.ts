import { describe, expect, it } from 'vitest';
import { type Fighter, decide, makeCtx } from '../src/scoring.js';
import { applyLens } from '../src/lens.js';
import { CONCEPTS, COMMON_WORDS, RARE_WORDS } from '../src/vocab.js';
import { compilePhrase, describeDraft } from '../src/constructor.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import { ruleRu } from '../src/cards.js';
import { type UnitSpec, runBattle } from '../src/battle.js';
import { type GroundView, evalCondition, resolveSelector } from '../src/ir.js';
import type { Rule } from '../src/ir.js';
import { AP_PER_TURN } from '../src/tuning.js';
import { foesForNode } from '../src/run.js';
import type { CombatUnit, LensId, Pos, Side } from '../src/types.js';
import type { Tile } from '../src/terrain.js';

/**
 * Четвёртая партия слов (план words) — «чтение боя»: условия про землю и
 * момент («затишье», «я на высоте», «меня прижали», «строй сомкнут») и
 * селекторы про чужое внимание и контакт («вражеский крикун», «свободный
 * враг»). Условия рельефа читают GroundView; без него — молчат.
 */

const r = (rule: Omit<Rule, 'scope'>): Rule => ({ ...rule, scope: 'self' });
const atkNearest = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 2, source: 'бей ближайшего' });

function fighter(
  id: string,
  side: Side,
  pos: Pos,
  over: Partial<CombatUnit> = {},
  rules: Rule[] = [],
  lenses: LensId[] = ['plain'],
): Fighter {
  return {
    id,
    name: id,
    side,
    maxHp: 40,
    hp: 40,
    atk: 6,
    range: 1,
    speed: 5,
    move: 2,
    pos,
    startPos: { ...pos },
    alive: true,
    coverLevel: 0,
    exposed: false,
    tags: [],
    lenses,
    ...over,
    compiled: applyLens(lenses, rules),
  };
}

const spec = (over: Partial<UnitSpec>): UnitSpec =>
  ({
    id: 'x',
    name: 'x',
    side: 'party',
    lenses: ['plain'],
    rules: [],
    maxHp: 40,
    atk: 6,
    range: 1,
    speed: 5,
    move: 2,
    ...over,
  } as UnitSpec);

const flatTiles = (): Tile[][] =>
  Array.from({ length: 18 }, () => Array.from({ length: 18 }, () => ({}) as Tile));

describe('затишье', () => {
  it('истинно, когда ни один враг не дотянется за свой ход, и ложно под накатом', () => {
    const me = fighter('me', 'party', { x: 2, y: 2 });
    const far = fighter('foe', 'foe', { x: 12, y: 12 }); // move 2×2 + range 1 = 5 < dist 10
    expect(evalCondition({ kind: 'lull' }, me, [me, far])).toBe(true);
    const near = fighter('foe', 'foe', { x: 6, y: 2 }); // dist 4 ≤ 5 — дотянется
    expect(evalCondition({ kind: 'lull' }, me, [me, near])).toBe(false);
    // точное отрицание «накатывают» при живом враге
    expect(evalCondition({ kind: 'underCharge' }, me, [me, far])).toBe(false);
    expect(evalCondition({ kind: 'underCharge' }, me, [me, near])).toBe(true);
  });

  it('без врагов молчит', () => {
    const me = fighter('me', 'party', { x: 2, y: 2 });
    expect(evalCondition({ kind: 'lull' }, me, [me])).toBe(false);
  });
});

describe('я на высоте', () => {
  const hill: GroundView = {
    heightAt: (p) => (p.x === 3 && p.y === 3 ? 1 : 0),
    blocked: () => false,
  };

  it('читает землю: на холме истинно, на равнине и без GroundView — ложно', () => {
    const onHill = fighter('me', 'party', { x: 3, y: 3 });
    const flat = fighter('me', 'party', { x: 5, y: 5 });
    expect(evalCondition({ kind: 'onHighGround' }, onHill, [onHill], 1, hill)).toBe(true);
    expect(evalCondition({ kind: 'onHighGround' }, flat, [flat], 1, hill)).toBe(false);
    expect(evalCondition({ kind: 'onHighGround' }, onHill, [onHill])).toBe(false);
  });

  it('в decide гейтит стойку: «пока на высоте — бить наверняка» горит только на холме', () => {
    const tiles = flatTiles();
    tiles[3]![3]!.height = 1;
    const blocked = (): boolean => false;
    const ctx = makeCtx(blocked, tiles);
    const rules = [
      atkNearest,
      r({ when: { kind: 'onHighGround' }, then: { kind: 'strikeHard' }, weight: 2, source: 'на высоте — наверняка' }),
    ];
    const onHill = fighter('me', 'party', { x: 3, y: 3 }, {}, rules);
    const foe = fighter('foe', 'foe', { x: 4, y: 3 }, {}, [atkNearest]);
    expect(decide(onHill, [onHill, foe], 1, blocked, AP_PER_TURN, ctx).stance.hard).toBe(true);
    const flat = fighter('me', 'party', { x: 8, y: 8 }, {}, rules);
    const foe2 = fighter('foe', 'foe', { x: 9, y: 8 }, {}, [atkNearest]);
    expect(decide(flat, [flat, foe2], 1, blocked, AP_PER_TURN, ctx).stance.hard).toBe(false);
  });
});

describe('меня прижали', () => {
  it('в углу за телами истинно, в чистом поле ложно', () => {
    const me = fighter('me', 'party', { x: 0, y: 0 });
    const a = fighter('a', 'party', { x: 0, y: 1 });
    const b = fighter('b', 'foe', { x: 1, y: 1 });
    // свободна только (1,0)
    expect(evalCondition({ kind: 'cornered' }, me, [me, a, b])).toBe(true);
    const open = fighter('me', 'party', { x: 8, y: 8 });
    expect(evalCondition({ kind: 'cornered' }, open, [open, a, b])).toBe(false);
  });

  it('камень считается через GroundView, мёртвые тела — нет', () => {
    const wall: GroundView = {
      heightAt: () => 0,
      blocked: (p) => p.y === 1 && p.x !== 3, // стена с одной щелью на (3,1)
    };
    const me = fighter('me', 'party', { x: 3, y: 0 });
    const left = fighter('l', 'foe', { x: 2, y: 0 });
    const right = fighter('rt', 'foe', { x: 4, y: 0 });
    // у стены между двумя телами свободна лишь щель — прижали
    expect(evalCondition({ kind: 'cornered' }, me, [me, left, right], 1, wall)).toBe(true);
    // без стены — свободна вся вторая строка
    expect(evalCondition({ kind: 'cornered' }, me, [me, left, right])).toBe(false);
    // павшее тело клетку не занимает: свободных две — уже не прижали
    const dead = { ...right, alive: false };
    expect(evalCondition({ kind: 'cornered' }, me, [me, left, dead], 1, wall)).toBe(false);
  });
});

describe('строй сомкнут', () => {
  it('зеркало «мы растянулись»: при двух и больше своих истинно ровно одно из двух', () => {
    const a = fighter('a', 'party', { x: 4, y: 4 });
    const b = fighter('b', 'party', { x: 5, y: 4 });
    const c = fighter('c', 'party', { x: 9, y: 9 });
    const tight = [a, b];
    expect(evalCondition({ kind: 'inFormation' }, a, tight)).toBe(true);
    expect(evalCondition({ kind: 'spreadThin' }, a, tight)).toBe(false);
    const torn = [a, b, c];
    expect(evalCondition({ kind: 'inFormation' }, a, torn)).toBe(false);
    expect(evalCondition({ kind: 'spreadThin' }, a, torn)).toBe(true);
  });

  it('у отряда из одного строя нет — молчит, как и «растянулись»', () => {
    const solo = fighter('a', 'party', { x: 4, y: 4 });
    expect(evalCondition({ kind: 'inFormation' }, solo, [solo])).toBe(false);
    expect(evalCondition({ kind: 'spreadThin' }, solo, [solo])).toBe(false);
  });
});

describe('вражеский крикун', () => {
  it('выбирает того, кто держит стойку вызова, даже если он дальше; без крикунов — ближайшего', () => {
    const me = fighter('me', 'party', { x: 2, y: 2 });
    const near = fighter('near', 'foe', { x: 3, y: 2 });
    const loud = fighter('loud', 'foe', { x: 8, y: 2 }, { stance: { taunt: true } });
    expect(resolveSelector('heckler', me, [me, near, loud])?.id).toBe('loud');
    expect(resolveSelector('heckler', me, [me, near])?.id).toBe('near');
  });
});

describe('свободный враг', () => {
  it('пропускает врага, которого держит товарищ; мой собственный контакт не в счёт', () => {
    const me = fighter('me', 'party', { x: 4, y: 4 });
    const mate = fighter('mate', 'party', { x: 8, y: 4 });
    const held = fighter('held', 'foe', { x: 8, y: 5 }); // вплотную к товарищу
    const free = fighter('free', 'foe', { x: 4, y: 5 }); // вплотную только ко мне
    expect(resolveSelector('unengaged', me, [me, mate, held, free])?.id).toBe('free');
    // все разобраны — ближайший
    expect(resolveSelector('unengaged', me, [me, mate, held])?.id).toBe('held');
  });
});

describe('смоук: «бить крикуна» снимает задиру узла застрельщиков', () => {
  it('после первого хода задиры герой со словом бьёт только его, пока тот не падёт', () => {
    const party: UnitSpec[] = [
      spec({
        id: 'hero',
        name: 'Герой',
        maxHp: 70,
        atk: 9,
        spawn: { x: 4, y: 8 },
        rules: [r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'heckler' }, weight: 2, source: 'бей крикуна' })],
      }),
      spec({ id: 'mate', name: 'Спутник', maxHp: 50, range: 4, spawn: { x: 3, y: 9 }, rules: [atkNearest] }),
    ];
    const foes = foesForNode({ id: 0, layer: 3, slot: 1, kind: 'fight', next: [] });
    const res = runBattle(7, [...party, ...foes], 'late');
    const heckDeath = res.events.findIndex((e) => e.t === 'die' && e.unit === 'heckler');
    expect(heckDeath).toBeGreaterThan(-1);
    // с первого своего удара герой держит цель на задире до его смерти
    const heroHits = res.events
      .map((e, i) => ({ e, i }))
      .filter(({ e, i }) => e.t === 'attack' && e.unit === 'hero' && i < heckDeath);
    expect(heroHits.length).toBeGreaterThan(0);
    expect(heroHits.every(({ e }) => e.t === 'attack' && e.target === 'heckler')).toBe(true);
  });
});

describe('слова живут по слоям: словарь, конструктор, карточка, схема', () => {
  it('категории и пулы: крикун и «прижали» — редкие (по аудиту), остальные — обычные', () => {
    for (const id of ['cond.lull', 'cond.onHighGround', 'cond.cornered', 'cond.inFormation'] as const) {
      expect(CONCEPTS[id].category).toBe('condition');
    }
    for (const id of ['cond.lull', 'cond.onHighGround', 'cond.inFormation'] as const) {
      expect(COMMON_WORDS).toContain(id);
    }
    // «прижали → глухая оборона» пик +28пп на массе крыс — слово-событие
    expect(RARE_WORDS).toContain('cond.cornered');
    expect(CONCEPTS['sel.heckler'].category).toBe('selector');
    expect(CONCEPTS['sel.unengaged'].category).toBe('selector');
    expect(RARE_WORDS).toContain('sel.heckler');
    expect(COMMON_WORDS).toContain('sel.unengaged');
  });

  it('конструктор: «прижали → отчаянно» компилируется, закрытое слово — ошибка', () => {
    const draft = {
      condition: { id: 'cond.cornered' },
      preference: { id: 'act.strikeDesperate' },
    } as const;
    const ok = compilePhrase(draft, ['cond.cornered', 'act.strikeDesperate']);
    expect(ok.ok && ok.rule.when).toEqual({ kind: 'cornered' });
    expect(describeDraft(draft)).toBe('если меня прижали: бить отчаянно');
    const closed = compilePhrase(draft, ['act.strikeDesperate']);
    expect(!closed.ok && closed.missing).toEqual(['cond.cornered']);
  });

  it('карточка: селекторы и условия читаются по-русски', () => {
    const atkFree = compilePhrase(
      { condition: { id: 'cond.lull' }, preference: { id: 'act.attack', target: 'sel.unengaged' } },
      ['cond.lull', 'act.attack', 'sel.unengaged'],
    );
    expect(atkFree.ok).toBe(true);
    if (atkFree.ok) {
      const ru = ruleRu(atkFree.rule, {});
      expect(ru).toContain('пока затишье');
      expect(ru).toContain('свободного врага');
    }
  });

  it('схема: открытые слова в схеме и валидации, закрытые — нет', () => {
    const open = JSON.stringify(buildCompileSchema(['act.attack', 'sel.heckler', 'cond.inFormation'], []));
    expect(open).toContain('sel.heckler');
    expect(open).toContain('cond.inFormation');
    const closedSchema = JSON.stringify(buildCompileSchema(['act.attack', 'sel.nearest'], []));
    expect(closedSchema).not.toContain('sel.heckler');
    expect(closedSchema).not.toContain('cond.lull');
    const out = validateOutput(
      {
        phrases: [{ condition: { id: 'cond.onHighGround' }, preference: { id: 'act.attack', target: 'sel.heckler' } }],
        uncertainty: [],
      },
      ['cond.onHighGround', 'act.attack', 'sel.heckler'],
      [],
      3,
    );
    expect(out.ok).toBe(true);
    const rejected = validateOutput(
      { phrases: [{ condition: { id: 'cond.lull' }, preference: { id: 'act.holdPosition' } }], uncertainty: [] },
      ['act.holdPosition'],
      [],
      3,
    );
    expect(rejected.ok).toBe(false);
  });
});
