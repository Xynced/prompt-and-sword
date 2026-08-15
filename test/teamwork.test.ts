import { describe, expect, it } from 'vitest';
import { type Fighter, decide, makeCtx, scoreCandidate, targetAppeal } from '../src/scoring.js';
import { applyLens } from '../src/lens.js';
import { APPEAL_FLOOR, BRACE_AC, INTERCEPT_APPEAL } from '../src/tuning.js';
import { type ConceptId, CONCEPTS, COMMON_WORDS, RARE_WORDS } from '../src/vocab.js';
import { compilePhrase } from '../src/constructor.js';
import { ruleRu } from '../src/cards.js';
import { dist } from '../src/grid.js';
import { type UnitSpec, runBattle } from '../src/battle.js';
import { thug, wolf } from '../src/foes.js';
import { PARTY_SPAWNS, heroArchetype } from '../src/heroes.js';
import type { CombatUnit, LensId, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * План teamwork, шаг 1 — цена дороги: доступность цели (заслон телохранителя,
 * крюк пути) множит тягу и премии правила «атаковать X», а когда цель приказа
 * дороже доступной — правило переезжает на ту, что под рукой. Скидку юнит
 * видит по своей осторожности (`caution`): фанатик и буквалист (0) слепы к ней
 * и прут за целью приказа, трус преувеличивает.
 */

const r = (rule: Omit<Rule, 'scope'>): Rule => ({ ...rule, scope: 'self' });
const atkWeakest = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 2, source: 'бей слабейшего' });
const atkNearest = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 2, source: 'бей ближайшего' });
const protectLia = r({ when: { kind: 'always' }, then: { kind: 'protect', ally: 'lia' }, weight: 2, source: 'прикрывай Лию' });

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
    guard: 0,
    exposed: false,
    tags: [],
    lenses,
    ...over,
    compiled: applyLens(lenses, rules),
  };
}

describe('цена дороги: доступность цели', () => {
  const ctx = makeCtx();

  it('заслон: смежный телохранитель со сработавшим «защищать» дешевит цель', () => {
    // слабейшая цель стоит вплотную к стражу, чьё «прикрывай Лию» горит
    const foe = fighter('foe', 'foe', { x: 5, y: 5 }, {}, [atkWeakest]);
    const lia = fighter('lia', 'party', { x: 7, y: 5 }, { hp: 10 });
    const grom = fighter('grom', 'party', { x: 7, y: 6 }, {}, [protectLia]);
    const units = [foe, lia, grom];
    // крюка нет: страж стоит рядом с подопечной, обе цели равноудалены
    expect(targetAppeal(lia, foe, units, ctx)).toBeCloseTo(INTERCEPT_APPEAL);
    expect(targetAppeal(grom, foe, units, ctx)).toBe(1);
  });

  it('заслон снят: страж уже потратил реакцию или его правило не горит', () => {
    const foe = fighter('foe', 'foe', { x: 5, y: 5 }, {}, [atkWeakest]);
    const lia = fighter('lia', 'party', { x: 7, y: 5 }, { hp: 10 });
    const spent = fighter('grom', 'party', { x: 7, y: 6 }, { reactionUsed: true }, [protectLia]);
    expect(targetAppeal(lia, foe, [foe, lia, spent], ctx)).toBe(1);
    // условное «прикрывай, пока цел» при hp ниже порога не горит — заслона нет
    const hurt = fighter(
      'grom',
      'party',
      { x: 7, y: 6 },
      { hp: 5 },
      [{ ...protectLia, when: { kind: 'hpAbove', who: 'self', frac: 0.5 } }],
    );
    expect(targetAppeal(lia, foe, [foe, lia, hurt], ctx)).toBe(1);
  });

  it('глухая оборона цели скидки НЕ даёт: «умный переключается» уже есть у рипоста', () => {
    // вторая механика на тот же случай только ухудшала оборонительное слово
    // (аудит: «глухая оборона» −34 → −38пп наиву), поэтому скидку убрали
    const foe = fighter('foe', 'foe', { x: 5, y: 5 }, {}, [atkWeakest]);
    const turtle = fighter('t', 'party', { x: 7, y: 5 }, { hp: 10, guard: BRACE_AC, guardFrom: 'fullCover' });
    const open = fighter('o', 'party', { x: 7, y: 6 });
    const units = [foe, turtle, open];
    expect(targetAppeal(turtle, foe, units, ctx)).toBe(1);
    expect(targetAppeal(open, foe, units, ctx)).toBe(1);
  });

  it('крюк: первая лишняя клетка бесплатна, дальний нырок дешевеет', () => {
    const foe = fighter('foe', 'foe', { x: 2, y: 5 }, {}, [atkWeakest]);
    const near = fighter('near', 'party', { x: 4, y: 5 });
    const oneOff = fighter('one', 'party', { x: 5, y: 5 });
    const far = fighter('far', 'party', { x: 12, y: 5 });
    const units = [foe, near, oneOff, far];
    // клетка разницы — ещё не нырок: фокус по чуть-дальней цели не наказывается
    expect(targetAppeal(oneOff, foe, units, ctx)).toBe(1);
    expect(targetAppeal(far, foe, units, ctx)).toBeLessThan(1);
    // и всё же приказ не глохнет целиком — иначе юнит застыл бы без дела
    expect(targetAppeal(far, foe, units, ctx)).toBeGreaterThanOrEqual(APPEAL_FLOOR);
  });

  it('осторожность: фанатик и буквалист слепы к цене дороги, трус преувеличивает', () => {
    const scene = (lenses: LensId[]): number => {
      const foe = fighter('foe', 'foe', { x: 2, y: 5 }, {}, [atkWeakest], lenses);
      const near = fighter('near', 'party', { x: 4, y: 5 });
      const far = fighter('far', 'party', { x: 12, y: 5 }, { hp: 5, guard: BRACE_AC, guardFrom: 'fullCover' });
      return targetAppeal(far, foe, [foe, near, far], ctx);
    };
    expect(scene(['fanatic'])).toBe(1);
    expect(scene(['literalist'])).toBe(1);
    expect(scene(['coward'])).toBeLessThan(scene(['plain']));
    expect(scene(['plain'])).toBeLessThan(1);
  });
});

describe('цена дороги в решении', () => {
  it('приказ переезжает на доступную цель, когда приказанная дороже её', () => {
    // сцена: слабейшая цель под заслоном телохранителя, здоровая — вплотную
    const scene = (lenses: LensId[]): string | undefined => {
      const foe = fighter('foe', 'foe', { x: 5, y: 5 }, {}, [atkWeakest], lenses);
      const tough = fighter('tough', 'party', { x: 6, y: 5 });
      const frail = fighter('lia', 'party', { x: 9, y: 5 }, { hp: 6 });
      const guard = fighter('grom', 'party', { x: 9, y: 6 }, {}, [protectLia]);
      return ruleTargetId(foe, [foe, tough, frail, guard]);
    };
    // осторожный уходит с прикрытой цели на любую доступную (кто именно —
    // решает тайбрейк по id: страж и здоровяк равно доступны)
    expect(scene(['plain'])).not.toBe('lia');
    // буквалисту цена дороги не видна: сказано «бей слабейшего» — идёт за ним
    expect(scene(['literalist'])).toBe('lia');
    expect(scene(['fanatic'])).toBe('lia');
  });

  it('доступную цель приказа не подменяют: приказ читается буквально', () => {
    const foe = fighter('foe', 'foe', { x: 5, y: 5 }, {}, [atkWeakest]);
    const tough = fighter('tough', 'party', { x: 6, y: 5 });
    // слабейший рядом и не прикрыт — никаких скидок, подмены быть не может
    const frail = fighter('frail', 'party', { x: 6, y: 6 }, { hp: 6 });
    expect(ruleTargetId(foe, [foe, tough, frail])).toBe('frail');
  });

  it('подмена видна в разборе боя: фактор называет, кого выбрали вместо приказанного', () => {
    const foe = fighter('foe', 'foe', { x: 5, y: 5 }, {}, [atkWeakest]);
    const tough = fighter('tough', 'party', { x: 6, y: 5 });
    const frail = fighter('lia', 'party', { x: 9, y: 5 }, { hp: 6 });
    const guard = fighter('grom', 'party', { x: 9, y: 6 }, {}, [protectLia]);
    const units = [foe, tough, frail, guard];
    const factors = scoreCandidate(
      { to: foe.pos, action: 'attack', targetId: 'tough' },
      foe,
      units,
      foe.compiled.rules,
      makeCtx(),
    );
    const rule = factors.find((f) => f.label.startsWith('правило:'))!;
    expect(rule.label).toContain('кто доступен');
    // приказ по доступной цели читается дословно, без пометки
    const plainUnits = [foe, tough, fighter('lia', 'party', { x: 6, y: 6 }, { hp: 6 })];
    const plainFactors = scoreCandidate(
      { to: foe.pos, action: 'attack', targetId: 'lia' },
      foe,
      plainUnits,
      foe.compiled.rules,
      makeCtx(),
    );
    expect(plainFactors.find((f) => f.label.startsWith('правило:'))!.label).not.toContain('кто доступен');
  });

  it('без альтернатив приказ не глохнет: юнит идёт к единственной цели', () => {
    const foe = fighter('foe', 'foe', { x: 5, y: 5 }, {}, [atkWeakest]);
    const lone = fighter('lone', 'party', { x: 13, y: 5 }, { hp: 6, guard: BRACE_AC, guardFrom: 'fullCover' });
    const d = decide(foe, [foe, lone], 1);
    // единственная цель — крюка нет, приказ ведёт к ней как раньше
    expect(d.chosen.action).toBe('move');
    expect(d.chosen.to.x).toBeGreaterThan(5);
  });
});

describe('канал внимания: вызывать на себя и уводить от X', () => {
  const ctx = makeCtx();
  const taunter = (pos: Pos, over: Partial<CombatUnit> = {}): Fighter =>
    fighter('bruiser', 'party', pos, { stance: { taunt: true }, ...over });

  it('провокатор уводит внимание с прочих целей, себе скидки не платит', () => {
    const foe = fighter('foe', 'foe', { x: 6, y: 5 }, {}, [atkWeakest]);
    const frail = fighter('frail', 'party', { x: 7, y: 5 }, { hp: 8 });
    const units = [foe, frail, taunter({ x: 6, y: 6 })];
    expect(targetAppeal(frail, foe, units, ctx)).toBeLessThan(0.5);
    expect(targetAppeal(units[2]!, foe, units, ctx)).toBe(1);
    // и приказ переезжает на крикуна — это и есть отвлечение
    expect(ruleTargetId(foe, units)).toBe('bruiser');
  });

  it('вне досягаемости выкрик не слышен: издалека провокация не работает', () => {
    const foe = fighter('foe', 'foe', { x: 2, y: 5 }, {}, [atkWeakest]);
    const frail = fighter('frail', 'party', { x: 3, y: 5 }, { hp: 8 });
    // крикун за пределами strikeReach врага (move 2, range 1 → 5 клеток)
    const far = taunter({ x: 15, y: 5 });
    expect(targetAppeal(frail, foe, [foe, frail, far], ctx)).toBe(1);
  });

  it('восприимчивость: горячка ведётся, буквалист и дуэлянт почти нет', () => {
    const share = (lenses: LensId[]): number => {
      const foe = fighter('foe', 'foe', { x: 6, y: 5 }, {}, [atkWeakest], lenses);
      const frail = fighter('frail', 'party', { x: 7, y: 5 }, { hp: 8 });
      return targetAppeal(frail, foe, [foe, frail, taunter({ x: 6, y: 6 })], ctx);
    };
    expect(share(['literalist'])).toBe(1); // ему сказано, кого бить
    expect(share(['hothead'])).toBeLessThan(share(['plain']));
    expect(share(['duelist'])).toBeGreaterThan(share(['plain']));
  });

  it('стойку ставит только вызов: слова ортогональны, увод внимания не забирает', () => {
    const shout = r({ when: { kind: 'always' }, then: { kind: 'taunt' }, weight: 2, source: 'вызывать на себя' });
    const self = fighter('me', 'party', { x: 5, y: 5 }, {}, [shout]);
    const foe = fighter('foe', 'foe', { x: 6, y: 5 }, {}, [atkWeakest]);
    expect(decide(self, [self, foe], 1).stance.taunt).toBe(true);
    // «уводить от X» стойку НЕ ставит: иначе оно поглощало бы вызов целиком
    // (аудит: комбо не было сильнее одного слова, и вызов становился лишним)
    const lure = r({ when: { kind: 'always' }, then: { kind: 'lure', ally: 'lia' }, weight: 2, source: 'уводить от Лии' });
    const luring = fighter('me', 'party', { x: 5, y: 5 }, {}, [lure]);
    const lia = fighter('lia', 'party', { x: 4, y: 5 });
    expect(decide(luring, [luring, lia, foe], 1).stance.taunt).toBe(false);
  });

  it('«уводить от X» тянет прочь от подопечного, но не из боя', () => {
    const lure = r({ when: { kind: 'always' }, then: { kind: 'lure', ally: 'lia' }, weight: 2, source: 'уводить от Лии' });
    const self = fighter('me', 'party', { x: 8, y: 8 }, {}, [lure]);
    const lia = fighter('lia', 'party', { x: 8, y: 9 });
    const foe = fighter('foe', 'foe', { x: 10, y: 8 }, {}, [atkNearest]);
    const d = decide(self, [self, lia, foe], 1);
    // шаг прочь от подопечной, а не к ней
    expect(dist(d.chosen.to, lia.pos)).toBeGreaterThan(dist(self.pos, lia.pos));
    // и всё ещё в пределах досягаемости врага — уводить можно только собой
    expect(dist(d.chosen.to, foe.pos)).toBeLessThanOrEqual(6);
  });

  it('слова живут по слоям: словарь, конструктор, карточка', () => {
    expect(CONCEPTS['act.taunt'].category).toBe('action');
    expect(RARE_WORDS).toContain('act.taunt');
    expect(COMMON_WORDS).toContain('act.lure');
    const vocab: ConceptId[] = ['act.taunt', 'act.lure'];
    const shout = compilePhrase({ condition: { id: 'always' }, preference: { id: 'act.taunt' } }, vocab);
    expect(shout.ok && shout.rule.then.kind).toBe('taunt');
    const lure = compilePhrase(
      { condition: { id: 'cond.allyInDanger', ally: 'lia' }, preference: { id: 'act.lure', ally: 'lia' } },
      [...vocab, 'cond.allyInDanger'],
    );
    expect(lure.ok && lure.rule.then).toEqual({ kind: 'lure', ally: 'lia' });
    // закрытое слово — ошибка компиляции, а не догадка
    const closed = compilePhrase({ condition: { id: 'always' }, preference: { id: 'act.taunt' } }, ['act.attack']);
    expect(closed.ok).toBe(false);
    // карточка «как понял» читается по-человечески
    expect(ruleRu({ ...(lure as { rule: Rule }).rule }, { lia: 'Лия' })).toContain('увожу врагов от Лия');
  });
});

describe('смоук: «отвлекай врагов от Леи, уводи их в сторону»', () => {
  const heroOf = (archId: string, slot: number, rules: Rule[]): UnitSpec => {
    const a = heroArchetype(archId);
    return {
      id: a.id,
      name: a.name,
      side: 'party',
      lenses: ['plain'],
      rules: [...rules, ...a.innate],
      maxHp: a.stats.maxHp,
      speed: a.stats.speed,
      move: a.stats.move,
      weapons: a.weapons,
      active: a.active,
      passives: a.passives,
      defenses: a.defenses,
      spawn: { ...PARTY_SPAWNS[slot]! },
    };
  };
  const ambush = (): UnitSpec[] => [thug(), wolf(1), wolf(2)];
  const atkAll = (rules: Rule[] = []): UnitSpec[] => [
    heroOf('grom', 0, [atkNearest, ...rules]),
    heroOf('lia', 1, [atkNearest]),
    heroOf('zhalo', 2, [atkNearest]),
  ];

  it('связка спасает подопечную от охоты на тыл: удары переезжают на крикуна', () => {
    const distract = (): UnitSpec[] =>
      atkAll([
        r({ when: { kind: 'always' }, then: { kind: 'taunt' }, weight: 1.5, source: 'вызывай на себя' }),
        r({ when: { kind: 'always' }, then: { kind: 'lure', ally: 'lia' }, weight: 1.5, source: 'уводи врагов от Лии' }),
      ]);
    let liaBitesNaive = 0;
    let liaBitesLoud = 0;
    let liaDeathsNaive = 0;
    let liaDeathsLoud = 0;
    let gromBitesLoud = 0;
    for (let s = 1; s <= 20; s++) {
      const seed = s * 17 + 3;
      const n = runBattle(seed, [...atkAll(), ...ambush()], 'late');
      const d = runBattle(seed, [...distract(), ...ambush()], 'late');
      const bites = (res: typeof n, id: string): number =>
        res.events.filter((e) => e.t === 'attack' && e.target === id).length;
      liaBitesNaive += bites(n, 'lia');
      liaBitesLoud += bites(d, 'lia');
      gromBitesLoud += bites(d, 'grom');
      if (!n.units.find((u) => u.id === 'lia')!.alive) liaDeathsNaive++;
      if (!d.units.find((u) => u.id === 'lia')!.alive) liaDeathsLoud++;
    }
    // до мага почти не доходят, а удары достаются тому, кто их звал.
    // Порог /3 → /2.5 волной 3 weapon-moves: киты сдвинули позиционку партии
    // (64 укуса против ~181 у наива — связка держит смысл с запасом)
    expect(liaBitesLoud).toBeLessThan(liaBitesNaive / 2.5);
    expect(liaDeathsLoud).toBeLessThan(liaDeathsNaive / 4);
    expect(gromBitesLoud).toBeGreaterThan(liaBitesLoud * 3);
  });

  it('симметрия: вражеский крикун так же уводит удары партии на себя', () => {
    // тот же приём в руках врага — механика правило мира, а не привилегия партии
    const loud = (rules: Rule[]): UnitSpec => ({
      ...thug(),
      id: 'loud',
      name: 'Задира',
      rules: [...thug().rules, ...rules],
    });
    let onLoudQuiet = 0;
    let onLoudShout = 0;
    for (let s = 1; s <= 20; s++) {
      const seed = s * 17 + 3;
      const quiet = runBattle(seed, [...atkAll(), loud([]), wolf(1)], 'late');
      const shout = runBattle(
        seed,
        [
          ...atkAll(),
          loud([r({ when: { kind: 'always' }, then: { kind: 'taunt' }, weight: 1.5, source: 'задира: эй, я здесь!' })]),
          wolf(1),
        ],
        'late',
      );
      const bites = (res: typeof quiet): number =>
        res.events.filter((e) => e.t === 'attack' && e.target === 'loud').length;
      onLoudQuiet += bites(quiet);
      onLoudShout += bites(shout);
    }
    expect(onLoudShout).toBeGreaterThan(onLoudQuiet);
  });
});

/**
 * Кого правило приказа реально выберет: тяга правила «атаковать» — та же
 * функция цели, поэтому читаем её через премию шага под удар (сравнивать
 * `decide` нельзя: в упор выгоднее ударить у любого характера).
 */
function ruleTargetId(self: Fighter, units: readonly Fighter[]): string | undefined {
  const ctx = makeCtx();
  const enemies = units.filter((u) => u.alive && u.side !== self.side);
  // клетка, с которой видно, куда тянет правило: сравниваем вклад правила у
  // кандидатов-атак по каждому врагу — цель правила получает премию, прочие нет
  let best: { id: string; v: number } | undefined;
  for (const e of enemies) {
    const [factor] = scoreCandidate(
      { to: self.pos, action: 'attack', targetId: e.id },
      self,
      units,
      self.compiled.rules,
      ctx,
    ).filter((f) => f.label.startsWith('правило:'));
    const v = factor?.value ?? -Infinity;
    if (!best || v > best.v) best = { id: e.id, v };
  }
  return best?.id;
}
