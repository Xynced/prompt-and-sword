import { describe, expect, it } from 'vitest';
import { type Rule, evalCondition, resolveSelector } from '../src/ir.js';
import { applyLens } from '../src/lens.js';
import { type Candidate, generateCandidates, makeCtx, scoreCandidate } from '../src/scoring.js';
import { type PhraseDraft, compilePhrase } from '../src/constructor.js';
import {
  COMMON_WORDS,
  CONCEPTS,
  RARE_WORDS,
  RETIRED_WORDS,
  STARTING_VOCAB,
  UNLOCKABLE,
  type ConceptId,
} from '../src/vocab.js';
import { lensQuip, understandingCard } from '../src/cards.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import type { CombatUnit, Pos } from '../src/types.js';

/**
 * Вторая партия слов (план words): 14 условий, 6 селекторов, 4 действия.
 * Условия дёшевы поодиночке — их ценность раскрывают глубокие чипсы «и».
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

const rule = (then: Rule['then'], w = 2): Rule => ({
  when: { kind: 'always' },
  then,
  weight: w,
  scope: 'self',
  source: 'тест',
});

/** Вклад правила в оценку кандидата. */
function ruleFactor(cand: Candidate, self: Fighter, units: Fighter[], rules: Rule[]): number {
  const f = scoreCandidate(cand, self, units, rules, makeCtx()).find((x) => x.label.startsWith('правило:'));
  return f?.value ?? 0;
}

describe('новые условия', () => {
  it('enemyAdjacent: враг вплотную', () => {
    const self = unit('a', 'party', { x: 3, y: 3 });
    const far = unit('e1', 'foe', { x: 6, y: 3 });
    expect(evalCondition({ kind: 'enemyAdjacent' }, self, [self, far])).toBe(false);
    const близко = unit('e2', 'foe', { x: 4, y: 4 });
    expect(evalCondition({ kind: 'enemyAdjacent' }, self, [self, far, близко])).toBe(true);
  });

  it('allyAdjacent: считаются свои, а не смежные враги', () => {
    const self = unit('a', 'party', { x: 3, y: 3 });
    const foe = unit('e1', 'foe', { x: 4, y: 3 });
    expect(evalCondition({ kind: 'allyAdjacent' }, self, [self, foe])).toBe(false);
    const ally = unit('b', 'party', { x: 3, y: 4 });
    expect(evalCondition({ kind: 'allyAdjacent' }, self, [self, ally, foe])).toBe(true);
  });

  it('alone: никого из своих в двух клетках', () => {
    const self = unit('a', 'party', { x: 3, y: 3 });
    const near = unit('b', 'party', { x: 5, y: 3 });
    expect(evalCondition({ kind: 'alone' }, self, [self, near])).toBe(false);
    near.pos = { x: 6, y: 3 };
    expect(evalCondition({ kind: 'alone' }, self, [self, near])).toBe(true);
  });

  it('weOutnumber: нас больше (мёртвые не в счёт)', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const ally = unit('b', 'party', { x: 1, y: 0 });
    const foe = unit('e1', 'foe', { x: 5, y: 5 });
    expect(evalCondition({ kind: 'weOutnumber' }, self, [self, ally, foe])).toBe(true);
    ally.alive = false;
    expect(evalCondition({ kind: 'weOutnumber' }, self, [self, ally, foe])).toBe(false);
  });

  it('enemyShooters / enemyCasters: живые носители дальнобоя и АОЕ', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const melee = unit('e1', 'foe', { x: 5, y: 5 });
    expect(evalCondition({ kind: 'enemyShooters' }, self, [self, melee])).toBe(false);
    expect(evalCondition({ kind: 'enemyCasters' }, self, [self, melee])).toBe(false);
    const archer = unit('e2', 'foe', { x: 6, y: 5 }, { range: 4 });
    const shaman = unit('e3', 'foe', { x: 7, y: 5 }, { aoe: { blast: { range: 4, mult: 0.8 } } });
    expect(evalCondition({ kind: 'enemyShooters' }, self, [self, melee, archer])).toBe(true);
    expect(evalCondition({ kind: 'enemyCasters' }, self, [self, melee, shaman])).toBe(true);
  });

  it('enemyWavering: пала половина вражеского отряда', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const foes = [0, 1, 2, 3].map((i) => unit(`e${i}`, 'foe', { x: 5 + i, y: 5 }));
    expect(evalCondition({ kind: 'enemyWavering' }, self, [self, ...foes])).toBe(false);
    foes[0]!.alive = false;
    expect(evalCondition({ kind: 'enemyWavering' }, self, [self, ...foes])).toBe(false);
    foes[1]!.alive = false;
    expect(evalCondition({ kind: 'enemyWavering' }, self, [self, ...foes])).toBe(true);
  });

  it('lastEnemy: остался один живой враг', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const e1 = unit('e1', 'foe', { x: 5, y: 5 });
    const e2 = unit('e2', 'foe', { x: 6, y: 5 });
    expect(evalCondition({ kind: 'lastEnemy' }, self, [self, e1, e2])).toBe(false);
    e2.alive = false;
    expect(evalCondition({ kind: 'lastEnemy' }, self, [self, e1, e2])).toBe(true);
  });

  it('allyHurt: ранен кто-то из наших, не я сам', () => {
    const self = unit('a', 'party', { x: 0, y: 0 }, { hp: 5 });
    const ally = unit('b', 'party', { x: 1, y: 0 }, { hp: 30 });
    expect(evalCondition({ kind: 'allyHurt' }, self, [self, ally])).toBe(false);
    ally.hp = 10;
    expect(evalCondition({ kind: 'allyHurt' }, self, [self, ally])).toBe(true);
  });

  it('enemiesClustered: двое врагов вплотную друг к другу', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const e1 = unit('e1', 'foe', { x: 5, y: 5 });
    const e2 = unit('e2', 'foe', { x: 8, y: 5 });
    expect(evalCondition({ kind: 'enemiesClustered' }, self, [self, e1, e2])).toBe(false);
    e2.pos = { x: 6, y: 5 };
    expect(evalCondition({ kind: 'enemiesClustered' }, self, [self, e1, e2])).toBe(true);
  });
});

describe('новые селекторы', () => {
  it('strongest / fastest — максимум hp и скорости, тайбрейк по id', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const tank = unit('e1', 'foe', { x: 3, y: 0 }, { hp: 40 });
    const runt = unit('e2', 'foe', { x: 1, y: 0 }, { hp: 10, speed: 9 });
    const units = [self, tank, runt];
    expect(resolveSelector('strongest', self, units)?.id).toBe('e1');
    expect(resolveSelector('fastest', self, units)?.id).toBe('e2');
  });

  it('healer — ближайший вражеский лекарь; лекарей нет — ближайший враг', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const brute = unit('e1', 'foe', { x: 1, y: 0 });
    const medic = unit('e2', 'foe', { x: 6, y: 0 }, { active: { heal: { amount: 10, range: 4, usesPerBattle: 4 } } });
    expect(resolveSelector('healer', self, [self, brute, medic])?.id).toBe('e2');
    expect(resolveSelector('healer', self, [self, brute])?.id).toBe('e1');
  });

  it('caster — ближайший носитель АОЕ; нет — ближайший враг', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const brute = unit('e1', 'foe', { x: 1, y: 0 });
    const shaman = unit('e2', 'foe', { x: 6, y: 0 }, { aoe: { ritual: { range: 5, mult: 1 } } });
    expect(resolveSelector('caster', self, [self, brute, shaman])?.id).toBe('e2');
    expect(resolveSelector('caster', self, [self, brute])?.id).toBe('e1');
  });

  it('straggler — дальше всех от своих; одиночка и есть отряд', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const pack1 = unit('e1', 'foe', { x: 4, y: 4 });
    const pack2 = unit('e2', 'foe', { x: 5, y: 4 });
    const stray = unit('e3', 'foe', { x: 12, y: 12 });
    expect(resolveSelector('straggler', self, [self, pack1, pack2, stray])?.id).toBe('e3');
    expect(resolveSelector('straggler', self, [self, pack1])?.id).toBe('e1');
  });

  it('tormentor — чей удар последним получил кто-то из наших; никого — ближайший', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const ally = unit('b', 'party', { x: 1, y: 1 }, { lastAttackerId: 'e2' });
    const near = unit('e1', 'foe', { x: 2, y: 0 });
    const bully = unit('e2', 'foe', { x: 7, y: 7 });
    expect(resolveSelector('tormentor', self, [self, ally, near, bully])?.id).toBe('e2');
    ally.lastAttackerId = undefined;
    expect(resolveSelector('tormentor', self, [self, ally, near, bully])?.id).toBe('e1');
  });
});

describe('скоринг: добивать и бить туда же', () => {
  it('finish: премия только удару, снимающему цель', () => {
    const self = fighter('a', 'party', { x: 3, y: 3 });
    const dying = fighter('e1', 'foe', { x: 4, y: 3 }, [], { hp: 2 });
    const healthy = fighter('e2', 'foe', { x: 3, y: 4 });
    const units = [self, dying, healthy];
    const r = rule({ kind: 'finish' });
    expect(ruleFactor({ to: self.pos, action: 'attack', targetId: 'e1' }, self, units, [r])).toBeGreaterThan(0);
    expect(ruleFactor({ to: self.pos, action: 'attack', targetId: 'e2' }, self, units, [r])).toBe(0);
    expect(ruleFactor({ to: self.pos, action: 'wait' }, self, units, [r])).toBe(0);
  });

  it('focusFire: премия по цели, которую уже бил кто-то из своих', () => {
    const self = fighter('a', 'party', { x: 3, y: 3 });
    const ally = fighter('b', 'party', { x: 2, y: 3 });
    const started = fighter('e1', 'foe', { x: 4, y: 3 }, [], { lastAttackerId: 'b' });
    const fresh = fighter('e2', 'foe', { x: 3, y: 4 });
    // цель, битую самим врагом (грызня), слово не выделяет
    const bitten = fighter('e3', 'foe', { x: 4, y: 4 }, [], { lastAttackerId: 'e1' });
    const units = [self, ally, started, fresh, bitten];
    const r = rule({ kind: 'focusFire' });
    expect(ruleFactor({ to: self.pos, action: 'attack', targetId: 'e1' }, self, units, [r])).toBeGreaterThan(0);
    expect(ruleFactor({ to: self.pos, action: 'attack', targetId: 'e2' }, self, units, [r])).toBe(0);
    expect(ruleFactor({ to: self.pos, action: 'attack', targetId: 'e3' }, self, units, [r])).toBe(0);
  });
});

describe('слова-гейты: благословить и финтить', () => {
  it('благословение жмётся только со словом (или врождённым правилом)', () => {
    const active = { bless: { dmgMult: 1.25, range: 3, usesPerBattle: 1 } };
    const ally = fighter('b', 'party', { x: 5, y: 3 });
    const foe = fighter('e1', 'foe', { x: 9, y: 3 });
    const wordy = fighter('a', 'party', { x: 3, y: 3 }, [rule({ kind: 'bless' })], { active });
    const cands = generateCandidates(wordy, [wordy, ally, foe]);
    expect(cands.some((c) => c.action === 'bless' && c.targetId === 'b')).toBe(true);

    const mute = fighter('a', 'party', { x: 3, y: 3 }, [rule({ kind: 'attack', target: 'nearest' })], { active });
    expect(generateCandidates(mute, [mute, ally, foe]).some((c) => c.action === 'bless')).toBe(false);
  });

  it('финт открывается словом; открытого второй раз не финтят', () => {
    const active = { feint: {} };
    const foe = fighter('e1', 'foe', { x: 4, y: 3 });
    const wordy = fighter('a', 'party', { x: 3, y: 3 }, [rule({ kind: 'feint' })], { active });
    expect(generateCandidates(wordy, [wordy, foe]).some((c) => c.action === 'feint' && c.targetId === 'e1')).toBe(true);

    foe.exposed = true;
    expect(generateCandidates(wordy, [wordy, foe]).some((c) => c.action === 'feint')).toBe(false);

    foe.exposed = false;
    const mute = fighter('a', 'party', { x: 3, y: 3 }, [rule({ kind: 'attack', target: 'nearest' })], { active });
    expect(generateCandidates(mute, [mute, foe]).some((c) => c.action === 'feint')).toBe(false);
  });
});

describe('линза: дуэлянт не добивает', () => {
  it('«добивать» перечитывается в вызов сильнейшему, реплика раскрывает', () => {
    const c = applyLens(['duelist'], [rule({ kind: 'finish' })]);
    expect(c.rules[0]!.then).toEqual({ kind: 'attack', target: 'mostDangerous' });
    const mark = c.rules[0]!.marks?.[0];
    expect(mark).toBeDefined();
    expect(lensQuip(mark!, {}, c.rules[0])).toBe('Добивать? Бесчестье. Вызываю сильнейшего.');
  });
});

describe('конструктор: вторая партия слов', () => {
  it('новые фразы компилируются при открытом словаре', () => {
    const cases: [PhraseDraft, string][] = [
      [{ condition: { id: 'cond.firstBlood' }, preference: { id: 'act.trade' } }, 'trade'],
      [{ condition: { id: 'cond.leaderDown' }, preference: { id: 'act.retreat' } }, 'retreat'],
      [{ condition: { id: 'cond.wasHit' }, preference: { id: 'act.brace' } }, 'brace'],
      [{ condition: { id: 'cond.hpAbove', who: 'self', frac: 0.7 }, preference: { id: 'act.bait' } }, 'bait'],
      [{ condition: { id: 'cond.allyHurt' }, preference: { id: 'act.heal' } }, 'heal'],
      [{ condition: { id: 'cond.enemiesClustered' }, preference: { id: 'act.barrage' } }, 'barrage'],
      [{ condition: { id: 'always' }, preference: { id: 'act.finish' } }, 'finish'],
      [{ condition: { id: 'always' }, preference: { id: 'act.focusFire' } }, 'focusFire'],
      [{ condition: { id: 'always' }, preference: { id: 'act.bless' } }, 'bless'],
      [{ condition: { id: 'always' }, preference: { id: 'act.feint' } }, 'feint'],
      [{ condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.healer' } }, 'attack'],
      [{ condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.straggler' } }, 'attack'],
    ];
    for (const [draft, kind] of cases) {
      const r = compilePhrase(draft, FULL_VOCAB);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.rule.then.kind).toBe(kind);
    }
    // условие hpAbove действительно доехало до IR
    const above = compilePhrase(
      { condition: { id: 'cond.hpAbove', who: 'self', frac: 0.7 }, preference: { id: 'act.bait' } },
      FULL_VOCAB,
    );
    if (above.ok) expect(above.rule.when).toEqual({ kind: 'hpAbove', who: 'self', frac: 0.7 });
  });

  it('в стартовом словаре вторая партия закрыта', () => {
    const r = compilePhrase(
      { condition: { id: 'cond.enemyAdjacent' }, preference: { id: 'act.finish' } },
      STARTING_VOCAB,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(['cond.enemyAdjacent', 'act.finish']);
  });
});

describe('карточки: вторая партия слов', () => {
  it('новые условия, селекторы и действия читаются по-русски', () => {
    const card = understandingCard({ name: 'Дарт', lenses: ['plain'] }, [
      { when: { kind: 'allyHurt' }, then: { kind: 'heal' }, weight: 1.5, scope: 'self', source: 'т1' },
      rule({ kind: 'attack', target: 'strongest' }),
      rule({ kind: 'finish' }),
      rule({ kind: 'focusFire' }),
    ]);
    expect(card.lines[0]).toContain('если кто-то из наших ранен');
    expect(card.lines[1]).toContain('самого здорового');
    expect(card.lines[2]).toContain('добиваю');
    expect(card.lines[3]).toContain('туда же');
  });
});

describe('LLM-схема: вторая партия слов', () => {
  it('открытые концепты в схеме и валидации, закрытые — нет', () => {
    const s = JSON.stringify(buildCompileSchema(FULL_VOCAB, []));
    for (const c of ['cond.enemyShooters', 'cond.hpAbove', 'sel.tormentor', 'act.finish', 'act.bless']) {
      expect(s).toContain(c);
    }
    const start = JSON.stringify(buildCompileSchema(STARTING_VOCAB, []));
    expect(start).not.toContain('act.finish');
    expect(start).not.toContain('cond.enemyShooters');

    const raw = {
      phrases: [{
        condition: { id: 'cond.hpAbove', who: 'self', frac: 0.7 },
        preference: { id: 'act.focusFire' },
        weight: 1,
      }],
      uncertainty: [],
    };
    expect(validateOutput(raw, FULL_VOCAB, [], 4).ok).toBe(true);
    expect(validateOutput(raw, STARTING_VOCAB, [], 4).ok).toBe(false);
  });
});

describe('словарь: пулы редкости', () => {
  it('все 24 новых слова открываемы, изъятия не тронуты', () => {
    const fresh: ConceptId[] = [
      'cond.hpAbove', 'cond.firstBlood', 'cond.leaderDown', 'cond.wasHit',
      'cond.enemyAdjacent', 'cond.allyAdjacent', 'cond.alone', 'cond.weOutnumber',
      'cond.enemyShooters', 'cond.enemyCasters', 'cond.enemyWavering', 'cond.lastEnemy',
      'cond.allyHurt', 'cond.enemiesClustered',
      'sel.strongest', 'sel.fastest', 'sel.healer', 'sel.caster', 'sel.straggler', 'sel.tormentor',
      'act.finish', 'act.focusFire', 'act.bless', 'act.feint',
    ];
    for (const c of fresh) {
      expect(CONCEPTS[c], c).toBeDefined();
      expect(UNLOCKABLE, c).toContain(c);
      expect(STARTING_VOCAB).not.toContain(c);
    }
    // слово в одном пуле, не в обоих
    for (const c of fresh) {
      expect(COMMON_WORDS.includes(c) !== RARE_WORDS.includes(c), c).toBe(true);
    }
    expect(RETIRED_WORDS).toEqual(['sel.farthest', 'cond.allyFallen']);
  });
});
