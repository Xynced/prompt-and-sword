import { describe, expect, it } from 'vitest';
import { type Fighter, decide, makeCtx, scoreCandidate, stanceOf } from '../src/scoring.js';
import { applyLens } from '../src/lens.js';
import { CONCEPTS, COMMON_WORDS, RARE_WORDS } from '../src/vocab.js';
import { compilePhrase, describeDraft } from '../src/constructor.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import { ruleRu } from '../src/cards.js';
import { dist, hasLoS } from '../src/grid.js';
import { type UnitSpec, runBattle } from '../src/battle.js';
import { evalCondition, resolveAlly } from '../src/ir.js';
import type { Rule } from '../src/ir.js';
import { heckler, slinger } from '../src/foes.js';
import { foesForNode } from '../src/run.js';
import type { CombatUnit, LensId, Pos, Side } from '../src/types.js';

/**
 * План teamwork, третья волна: канал метки («метить цель» → sel.marked),
 * позиция относительно своих («отходить за спины», «не застить своим»),
 * разбор толпы по одному («связывать боем»), роли «наш заклинатель» / «наш
 * лекарь», условие «мы растянулись» и враг-задира.
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

describe('метить цель', () => {
  it('стойку метки ставит только слово «метить цель»', () => {
    expect(stanceOf([r({ when: { kind: 'always' }, then: { kind: 'mark' }, weight: 1, source: 'мечу' })]).mark).toBe(true);
    expect(stanceOf([atkNearest]).mark).toBe(false);
  });

  it('в бою удар носителя вешает метку, и напарник со словом «помеченный» идёт туда же', () => {
    const units: UnitSpec[] = [
      spec({
        id: 'leader',
        name: 'Вожак',
        speed: 9,
        spawn: { x: 5, y: 8 },
        rules: [
          r({ when: { kind: 'always' }, then: { kind: 'mark' }, weight: 1.5, source: 'мечу цель' }),
          r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'leader' }, weight: 2, source: 'бей вожака' }),
        ],
      }),
      spec({
        id: 'mate',
        name: 'Напарник',
        speed: 5,
        spawn: { x: 5, y: 9 },
        rules: [r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'marked' }, weight: 2, source: 'бей помеченного' })],
      }),
      spec({ id: 'boss', name: 'Главарь', side: 'foe', maxHp: 80, tags: ['leader'], spawn: { x: 7, y: 8 }, rules: [atkNearest] }),
      spec({ id: 'add', name: 'Шавка', side: 'foe', spawn: { x: 7, y: 10 }, rules: [atkNearest] }),
    ];
    const res = runBattle(3, units, 'early');
    // метку поставил удар носителя слова, а не пассивка
    const mark = res.events.find((e) => e.t === 'mark');
    expect(mark).toBeDefined();
    if (mark && mark.t === 'mark') {
      expect(mark.unit).toBe('leader');
      expect(mark.target).toBe('boss');
    }
    // напарник после метки бьёт именно помеченного
    const idx = res.events.findIndex((e) => e.t === 'mark');
    const mateHits = res.events.slice(idx).filter((e) => e.t === 'attack' && e.unit === 'mate');
    expect(mateHits.length).toBeGreaterThan(0);
    expect(mateHits.every((e) => e.t === 'attack' && e.target === 'boss')).toBe(true);
  });

  it('слово живёт по слоям: словарь, конструктор, карточка, схема', () => {
    expect(CONCEPTS['act.mark'].category).toBe('action');
    // канал, меняющий чужой выбор цели, — редкое (как вызов)
    expect(RARE_WORDS).toContain('act.mark');
    const phrase = compilePhrase({ condition: { id: 'always' }, preference: { id: 'act.mark' } }, ['act.mark']);
    expect(phrase.ok && phrase.rule.then).toEqual({ kind: 'mark' });
    expect(describeDraft({ condition: { id: 'always' }, preference: { id: 'act.mark' } })).toBe('метить цель ударами');
    expect(ruleRu((phrase as { rule: Rule }).rule, {})).toContain('мечу цель ударами');
    const out = validateOutput(
      { phrases: [{ condition: { id: 'always' }, preference: { id: 'act.mark' } }], uncertainty: [] },
      ['act.mark'],
      [],
      3,
    );
    expect(out.ok).toBe(true);
  });
});

describe('отходить за спины', () => {
  const ctx = makeCtx();
  const fallback = r({ when: { kind: 'always' }, then: { kind: 'fallback' }, weight: 2, source: 'за спины' });

  it('без живых своих слово молчит', () => {
    const self = fighter('me', 'party', { x: 5, y: 5 }, {}, [fallback]);
    const foe = fighter('foe', 'foe', { x: 9, y: 5 });
    const factors = scoreCandidate({ to: { x: 4, y: 5 }, action: 'move' }, self, [self, foe], self.compiled.rules, ctx)
      .filter((f) => f.label.startsWith('правило:'));
    expect(factors).toHaveLength(0);
  });

  it('отступает К своим, за живой заслон, — а не от врага в никуда', () => {
    // товарищ стоит СБОКУ, «просто отступать» увело бы по прямой от врага
    const self = fighter('me', 'party', { x: 8, y: 8 }, {}, [fallback]);
    const mate = fighter('mate', 'party', { x: 4, y: 8 }, { maxHp: 60, hp: 60 });
    const foe = fighter('foe', 'foe', { x: 11, y: 8 }, {}, [atkNearest]);
    const d = decide(self, [self, mate, foe], 1);
    expect(dist(d.chosen.to, mate.pos)).toBeLessThan(dist(self.pos, mate.pos));
    // а чистое «отступать» на том же поле уходит от товарища не ближе
    const runner = fighter('me', 'party', { x: 8, y: 8 }, {}, [
      r({ when: { kind: 'always' }, then: { kind: 'retreat' }, weight: 2, source: 'отступай' }),
    ]);
    const rd = decide(runner, [runner, mate, foe], 1);
    expect(dist(rd.chosen.to, foe.pos)).toBeGreaterThanOrEqual(dist(d.chosen.to, foe.pos) - 1);
  });

  it('клетка за спиной своего дороже клетки на отшибе', () => {
    const self = fighter('me', 'party', { x: 6, y: 5 }, {}, [fallback]);
    const mate = fighter('mate', 'party', { x: 5, y: 5 });
    const foe = fighter('foe', 'foe', { x: 9, y: 5 });
    const units = [self, mate, foe];
    const behindMate = scoreCandidate({ to: { x: 4, y: 5 }, action: 'move' }, self, units, self.compiled.rules, ctx)
      .filter((f) => f.label.startsWith('правило:'))
      .reduce((s, f) => s + f.value, 0);
    const sideways = scoreCandidate({ to: { x: 6, y: 3 }, action: 'move' }, self, units, self.compiled.rules, ctx)
      .filter((f) => f.label.startsWith('правило:'))
      .reduce((s, f) => s + f.value, 0);
    expect(behindMate).toBeGreaterThan(sideways);
  });

  it('слово живёт по слоям', () => {
    expect(CONCEPTS['space.fallback'].category).toBe('space');
    expect(COMMON_WORDS).toContain('space.fallback');
    const phrase = compilePhrase(
      { condition: { id: 'cond.hpBelow', who: 'self', frac: 0.4 }, preference: { id: 'space.fallback' } },
      ['space.fallback', 'cond.hpBelow'],
    );
    expect(phrase.ok && phrase.rule.then).toEqual({ kind: 'fallback' });
    expect(ruleRu((phrase as { rule: Rule }).rule, {})).toContain('отхожу за спины');
  });
});

describe('не застить своим', () => {
  const ctx = makeCtx();
  const clearLine = r({ when: { kind: 'always' }, then: { kind: 'clearLine' }, weight: 2, source: 'не засти' });

  it('без своих стрелков слово молчит', () => {
    const self = fighter('me', 'party', { x: 5, y: 5 }, {}, [clearLine]);
    const mate = fighter('mate', 'party', { x: 3, y: 5 });
    const foe = fighter('foe', 'foe', { x: 9, y: 5 });
    const factors = scoreCandidate({ to: { x: 6, y: 5 }, action: 'move' }, self, [self, mate, foe], self.compiled.rules, ctx)
      .filter((f) => f.label.startsWith('правило:'));
    expect(factors).toHaveLength(0);
  });

  it('клетка на линии выстрела своего стрелка штрафуется, чистая — нет', () => {
    const self = fighter('me', 'party', { x: 6, y: 6 }, {}, [clearLine]);
    const bow = fighter('bow', 'party', { x: 3, y: 5 }, { range: 8 });
    const foe = fighter('foe', 'foe', { x: 9, y: 5 });
    const units = [self, bow, foe];
    const onLine = scoreCandidate({ to: { x: 6, y: 5 }, action: 'move' }, self, units, self.compiled.rules, ctx)
      .filter((f) => f.label.startsWith('правило:'))
      .reduce((s, f) => s + f.value, 0);
    const offLine = scoreCandidate({ to: { x: 6, y: 7 }, action: 'move' }, self, units, self.compiled.rules, ctx)
      .filter((f) => f.label.startsWith('правило:'))
      .reduce((s, f) => s + f.value, 0);
    expect(onLine).toBeLessThan(offLine);
    expect(offLine).toBe(0);
  });

  it('в решении ближник оставляет стрелку коридор огня', () => {
    const self = fighter('me', 'party', { x: 6, y: 6 }, {}, [clearLine, atkNearest]);
    const bow = fighter('bow', 'party', { x: 3, y: 5 }, { range: 8 });
    const foe = fighter('foe', 'foe', { x: 10, y: 5 }, {}, [atkNearest]);
    const units = [self, bow, foe];
    const d = decide(self, units, 1);
    // куда бы ни шёл — линия «стрелок → враг» остаётся чистой
    const blocks = (p: Pos): boolean => !hasLoS(bow.pos, foe.pos, (c) => c.x === p.x && c.y === p.y);
    expect(blocks(d.chosen.to)).toBe(false);
  });

  it('слово живёт по слоям', () => {
    expect(CONCEPTS['space.clearLine'].category).toBe('space');
    expect(COMMON_WORDS).toContain('space.clearLine');
    const phrase = compilePhrase({ condition: { id: 'always' }, preference: { id: 'space.clearLine' } }, ['space.clearLine']);
    expect(phrase.ok && phrase.rule.then).toEqual({ kind: 'clearLine' });
    expect(ruleRu((phrase as { rule: Rule }).rule, {})).toContain('не встаю на линию выстрела наших стрелков');
  });
});

describe('связывать боем', () => {
  const ctx = makeCtx();
  const pin = r({ when: { kind: 'always' }, then: { kind: 'pin' }, weight: 2, source: 'вяжи боем' });

  it('идёт к несвязанному врагу, а не в толкучку к товарищу', () => {
    const self = fighter('me', 'party', { x: 6, y: 6 }, {}, [pin]);
    const mate = fighter('mate', 'party', { x: 8, y: 4 });
    const held = fighter('held', 'foe', { x: 9, y: 4 }, {}, [atkNearest]); // его уже держит mate
    const free = fighter('free', 'foe', { x: 9, y: 8 }, {}, [atkNearest]);
    const units = [self, mate, held, free];
    const d = decide(self, units, 1);
    expect(dist(d.chosen.to, free.pos)).toBeLessThan(dist(d.chosen.to, held.pos));
  });

  it('контакт с несвязанным премируется; у связанного премии нет, и тяга зовёт к свободному', () => {
    const self = fighter('me', 'party', { x: 7, y: 6 }, {}, [pin]);
    const mate = fighter('mate', 'party', { x: 8, y: 4 });
    const held = fighter('held', 'foe', { x: 9, y: 4 }, {}, [atkNearest]);
    const free = fighter('free', 'foe', { x: 9, y: 8 }, {}, [atkNearest]);
    const units = [self, mate, held, free];
    const sum = (to: Pos): number =>
      scoreCandidate({ to, action: 'move' }, self, units, self.compiled.rules, ctx)
        .filter((f) => f.label.startsWith('правило:'))
        .reduce((s, f) => s + f.value, 0);
    expect(sum({ x: 8, y: 8 })).toBeGreaterThan(0); // вплотную к свободному
    expect(sum({ x: 8, y: 5 })).toBeLessThan(0); // у связанного: премии нет, тяга к свободному тянет прочь
  });

  it('слово живёт по слоям', () => {
    expect(CONCEPTS['act.pin'].category).toBe('action');
    expect(COMMON_WORDS).toContain('act.pin');
    const phrase = compilePhrase({ condition: { id: 'always' }, preference: { id: 'act.pin' } }, ['act.pin']);
    expect(phrase.ok && phrase.rule.then).toEqual({ kind: 'pin' });
    expect(ruleRu((phrase as { rule: Rule }).rule, {})).toContain('связываю боем');
  });
});

describe('роли «наш заклинатель» и «наш лекарь»', () => {
  it('разрешаются по площадному оружию и активу исцеления, без подстановок', () => {
    const me = fighter('me', 'party', { x: 5, y: 5 });
    const mage = fighter('mage', 'party', { x: 6, y: 5 }, { aoe: { blast: { range: 4, mult: 1 } } });
    const doc = fighter('doc', 'party', { x: 7, y: 5 }, { active: { heal: { amount: 8, range: 3, usesPerBattle: 2 } } });
    const foe = fighter('foe', 'foe', { x: 12, y: 5 });
    const units = [me, mage, doc, foe];
    expect(resolveAlly({ role: 'caster' }, me, units)?.id).toBe('mage');
    expect(resolveAlly({ role: 'healer' }, me, units)?.id).toBe('doc');
    // некого — молчит; себя не выбирает
    expect(resolveAlly({ role: 'caster' }, me, [me, doc, foe])).toBeUndefined();
    const iAmMage = fighter('me', 'party', { x: 5, y: 5 }, { aoe: { blast: { range: 4, mult: 1 } } });
    expect(resolveAlly({ role: 'caster' }, iAmMage, [iAmMage, doc, foe])).toBeUndefined();
  });

  it('роль — слово: фраза и схема требуют его открытым', () => {
    expect(COMMON_WORDS).toContain('sel.allyCaster');
    expect(COMMON_WORDS).toContain('sel.allyHealer');
    const closed = compilePhrase(
      { condition: { id: 'always' }, preference: { id: 'act.protect', ally: { role: 'caster' } } },
      ['act.protect'],
    );
    expect(closed.ok).toBe(false);
    expect(!closed.ok && closed.missing).toContain('sel.allyCaster');
    const open = compilePhrase(
      { condition: { id: 'always' }, preference: { id: 'act.protect', ally: { role: 'caster' } } },
      ['act.protect', 'sel.allyCaster'],
    );
    expect(open.ok && open.rule.then).toEqual({ kind: 'protect', ally: { role: 'caster' } });
    expect(describeDraft({ condition: { id: 'always' }, preference: { id: 'act.protect', ally: { role: 'healer' } } })).toBe(
      'защищать нашего лекаря',
    );
    const schema = JSON.stringify(buildCompileSchema(['act.protect', 'sel.allyHealer'], []));
    expect(schema).toContain('healer');
    expect(schema).not.toContain('caster');
  });
});

describe('мы растянулись', () => {
  it('горит, когда у кого-то из наших нет соседа-своего; строй и одиночку не трогает', () => {
    const me = fighter('me', 'party', { x: 5, y: 5 });
    const near = fighter('near', 'party', { x: 6, y: 5 });
    const far = fighter('far', 'party', { x: 12, y: 12 });
    const foe = fighter('foe', 'foe', { x: 9, y: 9 });
    expect(evalCondition({ kind: 'spreadThin' }, me, [me, near, far, foe], 1)).toBe(true);
    // сомкнутый строй из трёх — не растянулись
    const third = fighter('third', 'party', { x: 7, y: 5 });
    expect(evalCondition({ kind: 'spreadThin' }, me, [me, near, third, foe], 1)).toBe(false);
    // одиночке рваться не от кого
    expect(evalCondition({ kind: 'spreadThin' }, me, [me, foe], 1)).toBe(false);
  });

  it('условие живёт по слоям — гейт «растянулись → сомкнуть строй»', () => {
    expect(CONCEPTS['cond.spreadThin'].category).toBe('condition');
    expect(COMMON_WORDS).toContain('cond.spreadThin');
    const phrase = compilePhrase(
      { condition: { id: 'cond.spreadThin' }, preference: { id: 'act.regroup' } },
      ['cond.spreadThin', 'act.regroup'],
    );
    expect(phrase.ok && phrase.rule.when).toEqual({ kind: 'spreadThin' });
    expect(ruleRu((phrase as { rule: Rule }).rule, {})).toContain('если мы растянулись');
  });
});

describe('враг-задира', () => {
  it('живёт в составе узла застрельщиков', () => {
    const foes = foesForNode({ id: 0, layer: 3, slot: 1, kind: 'fight', next: [] });
    expect(foes.map((f) => f.id)).toContain('heckler');
    expect(foes.filter((f) => f.id.startsWith('slinger'))).toHaveLength(3);
  });

  it('уводит приказ героя на себя; буквалист на выкрики не оборачивается', () => {
    // задира в стойке вызова и досягаем; пращник — настоящая цель приказа
    const loud = fighter('heckler', 'foe', { x: 6, y: 5 }, {
      maxHp: 34,
      hp: 34,
      move: 3,
      stance: { taunt: true },
    }, [atkNearest]);
    const sl = fighter('slinger', 'foe', { x: 7, y: 6 }, { maxHp: 16, hp: 16, range: 4 }, [atkNearest]);
    const atkWeakest = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 2, source: 'бей слабейшего' });
    const plain = fighter('hero', 'party', { x: 5, y: 5 }, {}, [atkWeakest], ['plain']);
    const dPlain = decide(plain, [plain, loud, sl], 1);
    expect(dPlain.chosen.targetId).toBe('heckler');
    expect(dPlain.factors.some((f) => f.label.includes('кто доступен'))).toBe(true);
    // буквалист (provocable 0) выкрика не слышит: идёт к пращнику из приказа
    const literalist = fighter('hero', 'party', { x: 5, y: 5 }, {}, [atkWeakest], ['literalist']);
    const dLit = decide(literalist, [literalist, loud, sl], 1);
    expect(dLit.chosen.targetId).toBeUndefined();
    expect(dist(dLit.chosen.to, sl.pos)).toBe(1);
    expect(dLit.factors.some((f) => f.label.includes('кто доступен'))).toBe(false);
  });

  it('смоук: бой с задирой детерминирован и задира собирает удары наивной партии', () => {
    const party: UnitSpec[] = [
      spec({ id: 'a', name: 'А', maxHp: 60, spawn: { x: 4, y: 8 }, rules: [atkNearest] }),
      spec({ id: 'b', name: 'Б', maxHp: 40, range: 4, spawn: { x: 3, y: 9 }, rules: [atkNearest] }),
    ];
    const foes = foesForNode({ id: 0, layer: 3, slot: 1, kind: 'fight', next: [] });
    const one = runBattle(21, [...party, ...foes], 'late');
    const two = runBattle(21, [...party, ...foes], 'late');
    expect(two.events).toEqual(one.events);
    const hitsOnHeckler = one.events.filter((e) => e.t === 'attack' && e.target === 'heckler').length;
    expect(hitsOnHeckler).toBeGreaterThan(0);
  });

  it('спека задиры: стойка вызова в правилах, характер ровный', () => {
    const h = heckler();
    expect(h.rules.some((x) => x.then.kind === 'taunt')).toBe(true);
    expect(h.rules.some((x) => x.then.kind === 'lure')).toBe(true);
    expect(h.lenses).toEqual(['plain']);
    // якорь увода — живой пращник из того же состава
    expect(slinger(1).id).toBe('slinger1');
  });
});
