import { describe, expect, it } from 'vitest';
import { type Rule, evalCondition, resolveSelector } from '../src/ir.js';
import { applyLens } from '../src/lens.js';
import { type Candidate, type Fighter, makeCtx, scoreCandidate } from '../src/scoring.js';
import { type PhraseDraft, compilePhrase } from '../src/constructor.js';
import { CONCEPTS, STARTING_VOCAB, type ConceptId } from '../src/vocab.js';
import { understandingCard } from '../src/cards.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import { type UnitSpec, runBattle } from '../src/battle.js';
import type { CombatUnit, Pos } from '../src/types.js';

/** Поздний словарь фазы 4: 9 концептов поверх 12 MVP. */

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
    coverLevel: 0,
    exposed: false,
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

describe('условия позднего словаря', () => {
  it('battleDrags: срабатывает с 5-го раунда', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    expect(evalCondition({ kind: 'battleDrags' }, self, [self], 4)).toBe(false);
    expect(evalCondition({ kind: 'battleDrags' }, self, [self], 5)).toBe(true);
  });

  it('initiativeEdge: я быстрее своего ближайшего врага (переработка words)', () => {
    const self = unit('a', 'party', { x: 0, y: 0 }, { speed: 6 });
    const slow = unit('e1', 'foe', { x: 2, y: 2 }, { speed: 4 });
    const fast = unit('e2', 'foe', { x: 9, y: 9 }, { speed: 9 });
    // ближайший — медленный: окно «ударь до ответа» открыто, дальний быстрый не важен
    expect(evalCondition({ kind: 'initiativeEdge' }, self, [self, slow, fast])).toBe(true);
    // ближайший — быстрый: окна нет
    const fastNear = unit('e2', 'foe', { x: 1, y: 1 }, { speed: 9 });
    expect(evalCondition({ kind: 'initiativeEdge' }, self, [self, slow, fastNear])).toBe(false);
    expect(evalCondition({ kind: 'initiativeEdge' }, self, [self])).toBe(false); // врагов нет
  });
});

describe('селекторы позднего словаря', () => {
  it('mostDangerous — максимальная атака, тайбрейк по id', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const weakHit = unit('e1', 'foe', { x: 1, y: 0 }, { atk: 3 });
    const hardHit = unit('e2', 'foe', { x: 7, y: 7 }, { atk: 9 });
    expect(resolveSelector('mostDangerous', self, [self, weakHit, hardHit])?.id).toBe('e2');
  });

  it('attacker — кто бил меня последним; пока не били или обидчик мёртв — ближайший', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const near = unit('e1', 'foe', { x: 1, y: 0 });
    const far = unit('e2', 'foe', { x: 6, y: 6 });
    expect(resolveSelector('attacker', self, [self, near, far])?.id).toBe('e1');
    self.lastAttackerId = 'e2';
    expect(resolveSelector('attacker', self, [self, near, far])?.id).toBe('e2');
    far.alive = false;
    expect(resolveSelector('attacker', self, [self, near, far])?.id).toBe('e1');
  });
});

describe('линзы и поздний словарь', () => {
  it('трус: «приманка» = просто отойти', () => {
    const c = applyLens(['coward'], [rule({ kind: 'bait' })]);
    expect(c.rules[0]!.then).toEqual({ kind: 'retreat' });
    expect(c.rules[0]!.marks).toEqual([{ lens: 'coward', kind: 'reword', from: { kind: 'bait' } }]);
  });

  it('трус: размен и фланг — неохотно (штраф веса)', () => {
    const c = applyLens(['coward'], [rule({ kind: 'trade' }, 2), rule({ kind: 'flank' }, 2)]);
    expect(c.rules[0]!.weight).toBeCloseTo(1.4);
    expect(c.rules[1]!.weight).toBeCloseTo(1.4);
  });

  it('фанатик: «прикрывать отход» и «вне линии огня» превращаются в атаку', () => {
    const c = applyLens(['fanatic'], [rule({ kind: 'coverRetreat' }), rule({ kind: 'avoidLineOfFire' })]);
    expect(c.rules[0]!.then).toEqual({ kind: 'attack', target: 'nearest' });
    expect(c.rules[1]!.then).toEqual({ kind: 'attack', target: 'nearest' });
    for (const r of c.rules) expect(r.marks?.[0]).toMatchObject({ lens: 'fanatic', kind: 'reword' });
  });

  it('трус: «держать дистанцию» исполняет рьяно (буст веса)', () => {
    const c = applyLens(['coward'], [rule({ kind: 'standoff' }, 2)]);
    expect(c.rules[0]!.then).toEqual({ kind: 'standoff' });
    expect(c.rules[0]!.weight).toBeCloseTo(2.6);
    expect(c.rules[0]!.marks).toEqual([{ lens: 'coward', kind: 'reweight', mult: 1.3 }]);
  });

  it('фанатик: «держать дистанцию» превращается в атаку ближайшего', () => {
    const c = applyLens(['fanatic'], [rule({ kind: 'standoff' })]);
    expect(c.rules[0]!.then).toEqual({ kind: 'attack', target: 'nearest' });
    expect(c.rules[0]!.marks).toEqual([{ lens: 'fanatic', kind: 'reword', from: { kind: 'standoff' } }]);
  });

  it('буквалист: «держать дистанцию» не искажает', () => {
    const c = applyLens(['literalist'], [rule({ kind: 'standoff' }, 2)]);
    expect(c.rules[0]!.then).toEqual({ kind: 'standoff' });
    expect(c.rules[0]!.weight).toBe(2);
    expect(c.rules[0]!.source).toBe('тест');
  });
});

describe('конструктор: поздние концепты', () => {
  it('новые фразы компилируются в IR при открытом словаре', () => {
    const cases: [PhraseDraft, Rule['then']['kind']][] = [
      [{ condition: { id: 'cond.battleDrags' }, preference: { id: 'act.bait' } }, 'bait'],
      [{ condition: { id: 'cond.initiativeEdge' }, preference: { id: 'act.trade' } }, 'trade'],
      [{ condition: { id: 'always' }, preference: { id: 'act.coverRetreat' } }, 'coverRetreat'],
      [{ condition: { id: 'always' }, preference: { id: 'act.standoff' } }, 'standoff'],
      [{ condition: { id: 'always' }, preference: { id: 'space.flank' } }, 'flank'],
      [{ condition: { id: 'always' }, preference: { id: 'space.lineOfFire' } }, 'avoidLineOfFire'],
      [{ condition: { id: 'always' }, preference: { id: 'space.chokepoint' } }, 'chokepoint'],
      [
        { condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.mostDangerous' } },
        'attack',
      ],
    ];
    for (const [draft, kind] of cases) {
      const r = compilePhrase(draft, FULL_VOCAB);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.rule.then.kind).toBe(kind);
    }
  });

  it('в стартовом словаре поздние концепты закрыты', () => {
    const r = compilePhrase(
      { condition: { id: 'always' }, preference: { id: 'act.bait' } },
      STARTING_VOCAB,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(['act.bait']);
  });
});

describe('скоринг поздних предпочтений', () => {
  it('trade: премия добивающему удару больше, чем обычному', () => {
    const self = fighter('a', 'party', { x: 3, y: 3 });
    const dying = fighter('e1', 'foe', { x: 4, y: 3 }, { hp: 2 });
    const full = fighter('e2', 'foe', { x: 3, y: 4 });
    const units = [self, dying, full];
    const r = rule({ kind: 'trade' });
    const lethal = ruleFactor({ to: self.pos, action: 'attack', targetId: 'e1' }, self, units, r);
    const chip = ruleFactor({ to: self.pos, action: 'attack', targetId: 'e2' }, self, units, r);
    expect(lethal).toBeGreaterThan(chip);
    expect(chip).toBeGreaterThan(0);
    expect(ruleFactor({ to: self.pos, action: 'cover' }, self, units, r)).toBe(0);
  });

  it('flank: атака с фланга ценнее атаки в лоб', () => {
    const self = fighter('a', 'party', { x: 3, y: 3 });
    const ally = fighter('b', 'party', { x: 5, y: 3 });
    const target = fighter('e1', 'foe', { x: 4, y: 3 });
    const units = [self, ally, target];
    const r = rule({ kind: 'flank' });
    // (3,3) напротив союзника (5,3) — фланг; (4,2) сбоку под 90° — тоже фланг по правилу «≤0»,
    // а (5,2)? смежна и с союзником — важно лишь сравнение с атакой без фланга
    const flankHit = ruleFactor({ to: { x: 3, y: 3 }, action: 'attack', targetId: 'e1' }, self, units, r);
    ally.alive = false;
    const plainHit = ruleFactor({ to: { x: 3, y: 3 }, action: 'attack', targetId: 'e1' }, self, units, r);
    expect(flankHit).toBeGreaterThan(plainHit);
  });

  it('bait: быть досягаемым для врага лучше, чем стоять у него под ударом', () => {
    const self = fighter('a', 'party', { x: 0, y: 0 });
    const foe = fighter('e1', 'foe', { x: 4, y: 0 }, { move: 3, range: 1 });
    const units = [self, foe];
    const r = rule({ kind: 'bait' });
    const tease = ruleFactor({ to: { x: 1, y: 0 }, action: 'wait' }, self, units, r); // досягаем (3×2+1)
    const exposed = ruleFactor({ to: { x: 3, y: 0 }, action: 'wait' }, self, units, r); // под ударом
    const hiding = ruleFactor({ to: { x: 0, y: 11 }, action: 'wait' }, self, units, r); // вне игры
    expect(tease).toBeGreaterThan(exposed);
    expect(tease).toBeGreaterThan(hiding);
  });

  it('coverRetreat: заслон между врагом и раненым союзником ценнее позиции за спиной', () => {
    const self = fighter('a', 'party', { x: 3, y: 5 });
    const wounded = fighter('b', 'party', { x: 2, y: 3 }, { hp: 6 });
    const foe = fighter('e1', 'foe', { x: 5, y: 3 });
    const units = [self, wounded, foe];
    const r = rule({ kind: 'coverRetreat' });
    const screen = ruleFactor({ to: { x: 3, y: 3 }, action: 'wait' }, self, units, r); // между
    const cower = ruleFactor({ to: { x: 1, y: 3 }, action: 'wait' }, self, units, r); // за спиной
    expect(screen).toBeGreaterThan(cower);
    wounded.hp = 20; // здоровым отход не прикрывают — правило молчит
    expect(ruleFactor({ to: { x: 3, y: 3 }, action: 'wait' }, self, units, r)).toBe(0);
  });

  it('standoff: премия ровно на своей дальности, штраф за ближе, дальше — нейтрально', () => {
    const self = fighter('a', 'party', { x: 0, y: 3 }, { range: 4 });
    const foe = fighter('e1', 'foe', { x: 6, y: 3 });
    const units = [self, foe];
    const r = rule({ kind: 'standoff' });
    const atRange = ruleFactor({ to: { x: 2, y: 3 }, action: 'wait' }, self, units, r); // дист 4
    const close = ruleFactor({ to: { x: 4, y: 3 }, action: 'wait' }, self, units, r); // дист 2
    const closer = ruleFactor({ to: { x: 5, y: 3 }, action: 'wait' }, self, units, r); // дист 1
    const far = ruleFactor({ to: { x: 0, y: 3 }, action: 'wait' }, self, units, r); // дист 6
    expect(atRange).toBeGreaterThan(0);
    expect(close).toBeLessThan(0);
    expect(closer).toBeLessThan(close); // штраф растёт с приближением
    expect(far).toBe(0); // вне досягаемости — не штрафуется
  });

  it('chokepoint: премия проходу между камнями, обычной клетке — нет', () => {
    const self = fighter('a', 'party', { x: 3, y: 3 });
    const foe = fighter('e1', 'foe', { x: 9, y: 3 });
    const units = [self, foe];
    // камни (5,2) и (5,4) — клетка (5,3) — проход
    const rocks = new Set(['5,2', '5,4']);
    const ctx = makeCtx((p) => rocks.has(`${p.x},${p.y}`));
    const r = rule({ kind: 'chokepoint' });
    const inChoke = scoreCandidate({ to: { x: 5, y: 3 }, action: 'wait' }, self, units, [r], ctx)
      .find((f) => f.label.startsWith('правило:'))?.value ?? 0;
    const open = scoreCandidate({ to: { x: 3, y: 3 }, action: 'wait' }, self, units, [r], ctx)
      .find((f) => f.label.startsWith('правило:'))?.value ?? 0;
    expect(inChoke).toBeGreaterThan(0);
    expect(open).toBe(0);
  });

  it('avoidLineOfFire: штраф только под прицелом стрелка', () => {
    const self = fighter('a', 'party', { x: 0, y: 3 });
    const archer = fighter('e1', 'foe', { x: 6, y: 3 }, { range: 4 });
    const wall = fighter('e2', 'foe', { x: 4, y: 5 });
    const units = [self, archer, wall];
    const r = rule({ kind: 'avoidLineOfFire' });
    expect(ruleFactor({ to: { x: 3, y: 3 }, action: 'wait' }, self, units, r)).toBeLessThan(0); // на линии
    expect(ruleFactor({ to: { x: 0, y: 3 }, action: 'wait' }, self, units, r)).toBe(0); // вне дальности
    expect(ruleFactor({ to: { x: 3, y: 6 }, action: 'wait' }, self, units, r)).toBe(0); // за «стеной» (e2 на линии)
  });
});

describe('карточки: поздние концепты читаются', () => {
  it('шаблоны на месте, искажение труса — только факт; детали в debug', () => {
    const card = understandingCard({ name: 'Гром', lenses: ['coward'] }, [
      rule({ kind: 'bait' }),
      rule({ kind: 'flank' }),
    ]);
    // оба правила делят source «тест» — карточка группирует по фразе: одна строка
    expect(card.lines).toEqual(['тест ⚠ понял по-своему']);
    const dbg = understandingCard({ name: 'Гром', lenses: ['coward'] }, [rule({ kind: 'bait' })], {}, [], true);
    expect(dbg.lines[0]).toContain('отхожу');
  });

  it('standoff читается по-русски, буст труса помечен', () => {
    const plain = understandingCard({ name: 'Дарт', lenses: ['plain'] }, [rule({ kind: 'standoff' })]);
    expect(plain.lines[0]).toContain('держу дистанцию');
    expect(plain.lines[0]).not.toContain('⚠');
    const coward = understandingCard({ name: 'Лия', lenses: ['coward'] }, [rule({ kind: 'standoff' })]);
    expect(coward.lines[0]).toContain('⚠ понял по-своему');
  });
});

describe('LLM-схема: поздние концепты', () => {
  it('открытый концепт попадает в схему, закрытый — невыразим', () => {
    const s = JSON.stringify(buildCompileSchema(FULL_VOCAB, ['lia']));
    expect(s).toContain('act.bait');
    expect(s).toContain('sel.mostDangerous');
    expect(s).toContain('act.standoff');
    const start = JSON.stringify(buildCompileSchema(STARTING_VOCAB, ['lia']));
    expect(start).not.toContain('act.bait');
    expect(start).not.toContain('cond.battleDrags');
    expect(start).not.toContain('act.standoff');
  });

  it('validateOutput пропускает поздние концепты только при открытом словаре', () => {
    const raw = {
      phrases: [{ condition: { id: 'cond.battleDrags' }, preference: { id: 'act.trade' }, weight: 1 }],
      uncertainty: [],
    };
    expect(validateOutput(raw, FULL_VOCAB, [], 4).ok).toBe(true);
    expect(validateOutput(raw, STARTING_VOCAB, [], 4).ok).toBe(false);
  });
});

describe('детерминизм с поздними правилами', () => {
  it('тот же seed — побайтово тот же лог', () => {
    const party: UnitSpec[] = [
      {
        id: 'a',
        name: 'А',
        side: 'party',
        maxHp: 30,
        atk: 6,
        range: 1,
        speed: 5,
        move: 3,
        lenses: ['plain'],
        rules: [rule({ kind: 'flank' }), rule({ kind: 'trade' })],
        spawn: { x: 1, y: 3 },
      },
      {
        id: 'b',
        name: 'Б',
        side: 'party',
        maxHp: 20,
        atk: 5,
        range: 4,
        speed: 6,
        move: 3,
        lenses: ['plain'],
        rules: [rule({ kind: 'avoidLineOfFire' }), rule({ kind: 'attack', target: 'attacker' })],
        spawn: { x: 1, y: 5 },
      },
    ];
    const foes: UnitSpec[] = [
      {
        id: 'e1',
        name: 'Враг 1',
        side: 'foe',
        maxHp: 22,
        atk: 5,
        range: 1,
        speed: 4,
        move: 3,
        lenses: ['plain'],
        rules: [rule({ kind: 'bait' }), rule({ kind: 'attack', target: 'mostDangerous' })],
      },
      {
        id: 'e2',
        name: 'Враг 2',
        side: 'foe',
        maxHp: 18,
        atk: 6,
        range: 3,
        speed: 5,
        move: 2,
        lenses: ['plain'],
        rules: [rule({ kind: 'coverRetreat' }), rule({ kind: 'attack', target: 'weakest' })],
      },
    ];
    const a = runBattle(11, [...party, ...foes]);
    const b = runBattle(11, [...party, ...foes]);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });
});
