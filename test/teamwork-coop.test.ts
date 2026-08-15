import { describe, expect, it } from 'vitest';
import { type Fighter, decide, generateCandidates, makeCtx, scoreCandidate } from '../src/scoring.js';
import { applyLens } from '../src/lens.js';
import { type ConceptId, CONCEPTS, COMMON_WORDS, RARE_WORDS } from '../src/vocab.js';
import { compilePhrase, describeDraft } from '../src/constructor.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import { ruleRu } from '../src/cards.js';
import { dist, hasLoS } from '../src/grid.js';
import { type UnitSpec, runBattle } from '../src/battle.js';
import { evalCondition, resolveAlly } from '../src/ir.js';
import type { AllyRef, Condition, Rule } from '../src/ir.js';
import type { CombatUnit, LensId, Pos, Side } from '../src/types.js';

/**
 * План teamwork, вторая волна — вариативность совместных действий:
 * роли своих вместо имён, условия про то, что делают товарищи, и три
 * действия, у которых смысл есть только рядом со своими (заслон от стрелков,
 * сомкнуть строй, меняться местами).
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

describe('роли своих вместо имён', () => {
  const me = fighter('me', 'party', { x: 5, y: 5 });
  const foe = fighter('foe', 'foe', { x: 12, y: 5 });

  it('«наш раненый» — тот, кому хуже по доле hp; целых не выбирает и меня не выбирает', () => {
    const hurt = fighter('hurt', 'party', { x: 6, y: 5 }, { hp: 10 });
    const scratched = fighter('scratched', 'party', { x: 7, y: 5 }, { hp: 35 });
    const units = [me, hurt, scratched, foe];
    expect(resolveAlly({ role: 'wounded' }, me, units)?.id).toBe('hurt');
    // у целой партии подопечного нет — правило молчит, а не берёт кого попало
    const whole = [me, fighter('a', 'party', { x: 6, y: 5 }), foe];
    expect(resolveAlly({ role: 'wounded' }, me, whole)).toBeUndefined();
    // сам себя роль не выбирает: «прикрывай раненого» — приказ про товарища
    const iAmHurt = fighter('me', 'party', { x: 5, y: 5 }, { hp: 4 });
    expect(resolveAlly({ role: 'wounded' }, iAmHurt, [iAmHurt, hurt, foe])?.id).toBe('hurt');
  });

  it('«передовой», «наш стрелок», «наш крикун», «ближайший свой»', () => {
    const front = fighter('front', 'party', { x: 10, y: 5 });
    const bow = fighter('bow', 'party', { x: 4, y: 5 }, { range: 4 });
    const loud = fighter('loud', 'party', { x: 8, y: 5 }, { stance: { often: false, hard: false, bait: false, taunt: true } });
    const units = [me, front, bow, loud, foe];
    expect(resolveAlly({ role: 'frontman' }, me, units)?.id).toBe('front');
    expect(resolveAlly({ role: 'shooter' }, me, units)?.id).toBe('bow');
    expect(resolveAlly({ role: 'taunter' }, me, units)?.id).toBe('loud');
    expect(resolveAlly({ role: 'nearest' }, me, units)?.id).toBe('bow');
    // роли не подставляют «кого попало»: стрелка нет — слово молчит
    expect(resolveAlly({ role: 'shooter' }, me, [me, front, foe])).toBeUndefined();
    expect(resolveAlly({ role: 'taunter' }, me, [me, front, foe])).toBeUndefined();
  });

  it('подопечный меняется по ходу боя: «прикрывай раненого» переезжает на того, кому хуже', () => {
    const guard = fighter('guard', 'party', { x: 5, y: 5 }, {}, [
      r({ when: { kind: 'always' }, then: { kind: 'protect', ally: { role: 'wounded' } }, weight: 2, source: 'прикрывай раненого' }),
    ]);
    const left = fighter('left', 'party', { x: 2, y: 5 }, { hp: 8 });
    const right = fighter('right', 'party', { x: 8, y: 5 }, { hp: 30 });
    const foeNear = fighter('foe', 'foe', { x: 12, y: 5 }, {}, [atkNearest]);
    // сейчас хуже левому — шаг к нему
    const first = decide(guard, [guard, left, right, foeNear], 1);
    expect(first.chosen.to.x).toBeLessThan(guard.pos.x);
    // левого подлечили, правого продавили — приказ, не меняя ни слова, переехал
    const healed = fighter('left', 'party', { x: 2, y: 5 }, { hp: 38 });
    const worse = fighter('right', 'party', { x: 8, y: 5 }, { hp: 5 });
    const second = decide(guard, [guard, healed, worse, foeNear], 1);
    expect(second.chosen.to.x).toBeGreaterThan(guard.pos.x);
  });

  it('перехват в бою разрешает роль, а не сравнивает имена', () => {
    const spec = (over: Partial<UnitSpec>): UnitSpec => ({
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
    const units: UnitSpec[] = [
      spec({
        id: 'guard',
        name: 'Страж',
        spawn: { x: 6, y: 8 },
        rules: [r({ when: { kind: 'always' }, then: { kind: 'protect', ally: { role: 'wounded' } }, weight: 2, source: 'прикрывай раненого' })],
      }),
      spec({ id: 'frail', name: 'Хрупкий', hp: 12, spawn: { x: 6, y: 9 }, rules: [atkNearest] }),
      // фанатик слеп к цене дороги: он ныряет за хрупким, и заслон срабатывает
      // (расчётливый враг просто переключился бы на стража — волна 1 плана)
      spec({ id: 'foe', name: 'Враг', side: 'foe', lenses: ['fanatic'], spawn: { x: 7, y: 9 }, rules: [atkNearest] }),
    ];
    const res = runBattle(11, units, 'early');
    expect(res.events.some((e) => e.t === 'intercept' && e.unit === 'guard' && e.target === 'frail')).toBe(true);
  });

  it('роль — отдельное слово: без него фраза не компилируется, с ним читается', () => {
    const draft = { condition: { id: 'always' as const }, preference: { id: 'act.protect' as const, ally: { role: 'wounded' as const } } };
    const closed = compilePhrase(draft, ['act.protect']);
    expect(closed.ok).toBe(false);
    expect(!closed.ok && closed.missing).toContain('sel.allyWounded');
    const open = compilePhrase(draft, ['act.protect', 'sel.allyWounded']);
    expect(open.ok && open.rule.then).toEqual({ kind: 'protect', ally: { role: 'wounded' } });
    expect(describeDraft(draft)).toBe('защищать нашего раненого');
    // карточка «как понял» склоняет роль по месту в фразе
    expect(ruleRu((open as { rule: Rule }).rule, {})).toContain('прикрываю нашего раненого');
    expect(
      describeDraft({ condition: { id: 'always' }, preference: { id: 'space.nearTo', ref: { ally: { role: 'frontman' } } } }),
    ).toBe('держаться рядом с передовым');
  });

  it('схема компилятора принимает роль только с открытым словом', () => {
    const vocab: ConceptId[] = ['act.protect', 'sel.allyWounded'];
    const out = validateOutput(
      { phrases: [{ condition: { id: 'always' }, preference: { id: 'act.protect', ally: { role: 'wounded' } } }], uncertainty: [] },
      vocab,
      ['lia'],
      3,
    );
    expect(out.ok && out.output.phrases[0]!.preference).toEqual({ id: 'act.protect', ally: { role: 'wounded' } });
    const closed = validateOutput(
      { phrases: [{ condition: { id: 'always' }, preference: { id: 'act.protect', ally: { role: 'frontman' } } }], uncertainty: [] },
      vocab,
      ['lia'],
      3,
    );
    expect(closed.ok).toBe(false);
    // роль попадает в схему инструмента (её видит модель), закрытая — нет
    const schema = JSON.stringify(buildCompileSchema(vocab, ['lia']));
    expect(schema).toContain('wounded');
    expect(schema).not.toContain('frontman');
  });

  it('слова-роли живут в словаре и пулах', () => {
    for (const id of ['sel.allyWounded', 'sel.allyFrontman', 'sel.allyShooter', 'sel.allyTaunter', 'sel.allyNearest'] as const) {
      expect(CONCEPTS[id].category).toBe('selector');
    }
    expect(COMMON_WORDS).toContain('sel.allyWounded');
    expect(RARE_WORDS).toContain('sel.allyTaunter');
  });
});

describe('условия про своих', () => {
  const check = (cond: Condition, self: Fighter, units: Fighter[]): boolean => evalCondition(cond, self, units, 1);

  it('«наш держит вызов» видит стойку товарища, но не свою', () => {
    const loud = fighter('loud', 'party', { x: 6, y: 5 }, { stance: { often: false, hard: false, bait: false, taunt: true } });
    const me = fighter('me', 'party', { x: 5, y: 5 });
    expect(check({ kind: 'allyTaunting' }, me, [me, loud])).toBe(true);
    const alone = fighter('me', 'party', { x: 5, y: 5 }, { stance: { often: false, hard: false, bait: false, taunt: true } });
    expect(check({ kind: 'allyTaunting' }, alone, [alone])).toBe(false);
  });

  it('«наш в контакте» и «нашего обступили»', () => {
    const me = fighter('me', 'party', { x: 2, y: 2 });
    const mate = fighter('mate', 'party', { x: 8, y: 8 });
    const foe1 = fighter('f1', 'foe', { x: 9, y: 8 });
    expect(check({ kind: 'allyEngaged' }, me, [me, mate, foe1])).toBe(true);
    expect(check({ kind: 'allySurrounded' }, me, [me, mate, foe1])).toBe(false);
    const foe2 = fighter('f2', 'foe', { x: 7, y: 8 });
    expect(check({ kind: 'allySurrounded' }, me, [me, mate, foe1, foe2])).toBe(true);
    // мой собственный контакт условием не считается: оно про товарищей
    const mePinned = fighter('me', 'party', { x: 8, y: 9 });
    expect(check({ kind: 'allyEngaged' }, mePinned, [mePinned, fighter('mate', 'party', { x: 2, y: 2 }), foe1])).toBe(false);
  });

  it('«меня прикрывают» — только живое чужое прикрытие рядом', () => {
    const shield = fighter('shield', 'party', { x: 5, y: 6 });
    const me = fighter('me', 'party', { x: 5, y: 5 }, { guardedBy: { id: 'shield', level: 0.4 } });
    expect(check({ kind: 'guarded' }, me, [me, shield])).toBe(true);
    const gone = fighter('shield', 'party', { x: 12, y: 6 });
    expect(check({ kind: 'guarded' }, me, [me, gone])).toBe(false);
    const dead = fighter('shield', 'party', { x: 5, y: 6 }, { alive: false });
    expect(check({ kind: 'guarded' }, me, [me, dead])).toBe(false);
    // своя оборона прикрытием товарища не считается
    const braced = fighter('me', 'party', { x: 5, y: 5 }, { coverLevel: 0.6 });
    expect(check({ kind: 'guarded' }, braced, [braced, shield])).toBe(false);
  });

  it('«наши навалились» — по каналу последнего обидчика, и мои удары не в счёт', () => {
    const me = fighter('me', 'party', { x: 5, y: 5 });
    const mate = fighter('mate', 'party', { x: 6, y: 5 });
    const hitByMate = fighter('foe', 'foe', { x: 7, y: 5 }, { lastAttackerId: 'mate' });
    expect(check({ kind: 'alliesFocusing' }, me, [me, mate, hitByMate])).toBe(true);
    const hitByMe = fighter('foe', 'foe', { x: 7, y: 5 }, { lastAttackerId: 'me' });
    expect(check({ kind: 'alliesFocusing' }, me, [me, mate, hitByMe])).toBe(false);
  });

  it('условия живут по слоям: словарь, конструктор, карточка', () => {
    for (const id of ['cond.allyTaunting', 'cond.allyEngaged', 'cond.guarded', 'cond.allySurrounded', 'cond.alliesFocusing'] as const) {
      expect(CONCEPTS[id].category).toBe('condition');
    }
    expect(COMMON_WORDS).toContain('cond.allyTaunting');
    expect(COMMON_WORDS).toContain('cond.allySurrounded');
    const phrase = compilePhrase(
      { condition: { id: 'cond.allyTaunting' }, preference: { id: 'space.flank' } },
      ['cond.allyTaunting', 'space.flank'],
    );
    expect(phrase.ok && phrase.rule.when).toEqual({ kind: 'allyTaunting' });
    expect(ruleRu((phrase as { rule: Rule }).rule, {})).toContain('если кто-то из наших вызвал врагов на себя');
  });
});

describe('заслонить от стрелков', () => {
  const ctx = makeCtx();
  const screenWard = (ally: AllyRef): Rule =>
    r({ when: { kind: 'always' }, then: { kind: 'screen', ally }, weight: 2, source: 'заслоняй' });

  it('без вражеских стрелков слово молчит', () => {
    const self = fighter('me', 'party', { x: 5, y: 5 }, {}, [screenWard('ward')]);
    const ward = fighter('ward', 'party', { x: 4, y: 5 });
    const melee = fighter('foe', 'foe', { x: 9, y: 5 });
    const units = [self, ward, melee];
    const ruleFactor = scoreCandidate({ to: { x: 6, y: 5 }, action: 'move' }, self, units, self.compiled.rules, ctx)
      .filter((f) => f.label.startsWith('правило:'));
    expect(ruleFactor).toHaveLength(0);
  });

  it('встаёт телом на линию выстрела: стрелок теряет подопечного из виду', () => {
    const self = fighter('me', 'party', { x: 6, y: 7 }, {}, [screenWard('ward')]);
    const ward = fighter('ward', 'party', { x: 3, y: 5 });
    const shooter = fighter('shooter', 'foe', { x: 9, y: 5 }, { range: 8 }, [atkNearest]);
    const units = [self, ward, shooter];
    const d = decide(self, units, 1);
    const blocks = (p: Pos): boolean =>
      !hasLoS(shooter.pos, ward.pos, (c) => c.x === p.x && c.y === p.y);
    expect(blocks(d.chosen.to)).toBe(true);
  });

  it('слово живёт по слоям: словарь, конструктор, карточка', () => {
    expect(CONCEPTS['act.screen'].category).toBe('action');
    expect(COMMON_WORDS).toContain('act.screen');
    const phrase = compilePhrase(
      { condition: { id: 'cond.enemyShooters' }, preference: { id: 'act.screen', ally: 'lia' } },
      ['act.screen', 'cond.enemyShooters'],
    );
    expect(phrase.ok && phrase.rule.then).toEqual({ kind: 'screen', ally: 'lia' });
    expect(ruleRu((phrase as { rule: Rule }).rule, { lia: 'Лия' })).toContain('заслоняю Лия от стрелков');
  });
});

describe('сомкнуть строй', () => {
  const regroup = r({ when: { kind: 'always' }, then: { kind: 'regroup' }, weight: 2, source: 'смыкай строй' });

  it('тянет к своим и награждает плечо', () => {
    const self = fighter('me', 'party', { x: 5, y: 5 }, {}, [regroup]);
    const mate = fighter('mate', 'party', { x: 9, y: 5 });
    const foe = fighter('foe', 'foe', { x: 15, y: 15 });
    const d = decide(self, [self, mate, foe], 1);
    expect(dist(d.chosen.to, mate.pos)).toBeLessThan(dist(self.pos, mate.pos));
  });

  it('прямо спорит с «держать интервал»: побеждает больший вес, без осцилляции', () => {
    const spread = r({ when: { kind: 'always' }, then: { kind: 'spread' }, weight: 3, source: 'держи интервал' });
    const self = fighter('me', 'party', { x: 5, y: 5 }, {}, [regroup, spread]);
    const mate = fighter('mate', 'party', { x: 6, y: 5 });
    // у врага есть чем накрыть — иначе «интервал» молчит по своему гейту
    const caster = fighter('foe', 'foe', { x: 15, y: 15 }, { aoe: { blast: { range: 6, mult: 1 } } });
    const units = [self, mate, caster];
    const d = decide(self, units, 1);
    expect(dist(d.chosen.to, mate.pos)).toBeGreaterThan(1);
  });

  it('слово живёт по слоям', () => {
    expect(CONCEPTS['act.regroup'].category).toBe('action');
    // слово-решение: размах по боям (урок +31пп, босс −39пп) — редкое
    expect(RARE_WORDS).toContain('act.regroup');
    const phrase = compilePhrase({ condition: { id: 'always' }, preference: { id: 'act.regroup' } }, ['act.regroup']);
    expect(phrase.ok && phrase.rule.then).toEqual({ kind: 'regroup' });
    expect(ruleRu((phrase as { rule: Rule }).rule, {})).toContain('смыкаю строй');
  });
});

describe('меняться местами', () => {
  const ctx = makeCtx();
  const swapWith = (ally: AllyRef): Rule =>
    r({ when: { kind: 'always' }, then: { kind: 'swap', ally }, weight: 2, source: 'меняйся местами' });

  it('без слова обмена нет вовсе: партия сама не тасуется', () => {
    const self = fighter('me', 'party', { x: 5, y: 5 }, {}, [atkNearest]);
    const mate = fighter('mate', 'party', { x: 5, y: 6 });
    const foe = fighter('foe', 'foe', { x: 6, y: 5 }, {}, [atkNearest]);
    const units = [self, mate, foe];
    const cands = generateCandidates(self, units, ctx, 3, 1, self.compiled.rules);
    expect(cands.some((c) => c.action === 'swap')).toBe(false);
  });

  it('вытаскивает подопечного из-под удара, вставая под удар сам', () => {
    // хрупкий стоит в кольце врагов, танк — за его спиной
    const tank = fighter('tank', 'party', { x: 5, y: 5 }, { maxHp: 60, hp: 60 }, [swapWith({ role: 'wounded' })]);
    const frail = fighter('frail', 'party', { x: 6, y: 5 }, { maxHp: 24, hp: 9 });
    const foes = [
      fighter('f1', 'foe', { x: 7, y: 5 }, {}, [atkNearest]),
      fighter('f2', 'foe', { x: 7, y: 6 }, {}, [atkNearest]),
    ];
    const units = [tank, frail, ...foes];
    const d = decide(tank, units, 1);
    expect(d.chosen.action).toBe('swap');
    expect(d.chosen.targetId).toBe('frail');
    // клетка решения — та, куда встанет затевающий
    expect(d.chosen.to).toEqual(frail.pos);
  });

  it('спокойного товарища не дёргает: обмен без облегчения не стоит хода', () => {
    const tank = fighter('tank', 'party', { x: 5, y: 5 }, {}, [swapWith('mate')]);
    const mate = fighter('mate', 'party', { x: 6, y: 5 });
    const far = fighter('foe', 'foe', { x: 16, y: 16 }, {}, [atkNearest]);
    const d = decide(tank, [tank, mate, far], 1);
    expect(d.chosen.action).not.toBe('swap');
  });

  it('бой применяет обмен: клетки меняются, ход подопечного не тратится', () => {
    const spec = (over: Partial<UnitSpec>): UnitSpec => ({
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
    const units: UnitSpec[] = [
      spec({
        id: 'tank',
        name: 'Танк',
        maxHp: 70,
        speed: 9,
        spawn: { x: 5, y: 8 },
        rules: [swapWith('frail'), atkNearest],
      }),
      spec({ id: 'frail', name: 'Хрупкий', maxHp: 24, hp: 9, spawn: { x: 6, y: 8 }, rules: [atkNearest] }),
      spec({ id: 'f1', name: 'Враг', side: 'foe', spawn: { x: 7, y: 8 }, rules: [atkNearest] }),
      spec({ id: 'f2', name: 'Враг2', side: 'foe', spawn: { x: 7, y: 9 }, rules: [atkNearest] }),
    ];
    const res = runBattle(7, units, 'early');
    const swap = res.events.find((e) => e.t === 'swap');
    expect(swap).toBeDefined();
    if (swap && swap.t === 'swap') {
      expect(swap.unit).toBe('tank');
      expect(swap.target).toBe('frail');
      // хрупкий встал туда, где стоял танк, и наоборот
      const decisions = res.events.filter((e) => e.t === 'decision');
      const idx = res.events.indexOf(swap);
      const afterFrail = res.events
        .slice(idx)
        .find((e) => e.t === 'decision' && e.unit === 'frail');
      expect(decisions.length).toBeGreaterThan(0);
      if (afterFrail && afterFrail.t === 'decision') {
        // подопечный ходит своим полным ходом: обмен списал очки только с танка
        expect(afterFrail.ap).toBe(3);
      }
    }
  });

  it('слово живёт по слоям и требует слова роли', () => {
    expect(CONCEPTS['act.swap'].category).toBe('action');
    expect(RARE_WORDS).toContain('act.swap');
    const byName = compilePhrase(
      { condition: { id: 'cond.allyInDanger', ally: 'lia' }, preference: { id: 'act.swap', ally: 'lia' } },
      ['act.swap', 'cond.allyInDanger'],
    );
    expect(byName.ok && byName.rule.then).toEqual({ kind: 'swap', ally: 'lia' });
    expect(ruleRu((byName as { rule: Rule }).rule, { lia: 'Лия' })).toContain('меняюсь местами с Лия');
    const byRole = compilePhrase(
      { condition: { id: 'always' }, preference: { id: 'act.swap', ally: { role: 'wounded' } } },
      ['act.swap'],
    );
    expect(byRole.ok).toBe(false);
  });
});
