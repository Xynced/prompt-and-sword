import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import {
  type Fighter,
  decide,
  generateCandidates,
  guardAgainst,
  guardFor,
  makeCtx,
  shieldRaised,
  stanceGuard,
} from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { heroArchetype } from '../src/heroes.js';
import { soldier } from '../src/foes.js';
import { describeShield } from '../src/cards.js';
import { BAIT_AC, BRACE_AC, COVER_AC, OFF_GUARD_AC, guardMitigation } from '../src/tuning.js';
import type { CombatUnit, Pos, ShieldSpec, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Броня, укрытия и щиты (план armor): вся оборона «труднее попасть» — одна
 * валюта, бонус обстоятельств к КБ, и по правилу pf2e бонусы обстоятельств не
 * складываются (берётся высший). Щит — снаряжение танка: поднятый даёт бонус,
 * прошедший удар гасит твёрдостью и копит вмятины до поломки. Фланг —
 * не множитель урона, а «застигнут врасплох» (−КБ).
 */

const SHIELD: ShieldSpec = { ac: 2, hardness: 3, hp: 6 };

function fighter(id: string, side: Side, pos: Pos, over: Partial<CombatUnit> = {}, rules: Rule[] = []): Fighter {
  return {
    id,
    name: id,
    side,
    maxHp: 40,
    hp: 40,
    atk: 5,
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

const spec = (over: Partial<UnitSpec> & Pick<UnitSpec, 'id' | 'side' | 'spawn'>): UnitSpec => ({
  name: over.id,
  maxHp: 200,
  atk: 8,
  range: 1,
  speed: 5,
  move: 0,
  lenses: ['plain'],
  rules: [],
  ...over,
});

const atkNearest = rule({ kind: 'attack', target: 'nearest' });
const events = (evs: readonly BattleEvent[], t: BattleEvent['t']): BattleEvent[] =>
  evs.filter((e) => e.t === t);

describe('одна валюта обороны', () => {
  it('бонусы обстоятельств не складываются — берётся высший', () => {
    const me = fighter('me', 'party', { x: 5, y: 5 }, { guard: COVER_AC, guardFrom: 'raiseShield' });
    const mate = fighter('mate', 'party', { x: 6, y: 5 });
    me.guardedBy = { id: 'mate', bonus: 3 };
    // свой поднятый щит +2, чужой щит +3 — не пять, а три
    expect(guardAgainst(me, [me, mate], 0)).toBe(3);
    // и каменное укрытие в ту же копилку: высший, не сумма
    expect(guardAgainst(me, [me, mate], COVER_AC)).toBe(3);
  });

  it('Take Cover из pf2e: укрытие плюс потраченный на оборону ход — ступенью выше', () => {
    const inCover = fighter('c', 'party', { x: 5, y: 5 }, { guard: COVER_AC, guardFrom: 'cover' });
    expect(guardAgainst(inCover, [inCover], COVER_AC)).toBe(BRACE_AC);
    // без камня «прикрыться» остаётся обычным укрытием
    expect(guardAgainst(inCover, [inCover], 0)).toBe(COVER_AC);
    // поднятый щит камня не повышает (в pf2e щит и укрытие — один канал)
    const shielded = fighter('s', 'party', { x: 5, y: 5 }, { guard: COVER_AC, guardFrom: 'raiseShield' });
    expect(guardAgainst(shielded, [shielded], COVER_AC)).toBe(COVER_AC);
    // и приманка (стойка, а не ход) укрытие тоже не повышает
    const bait = fighter('b', 'party', { x: 5, y: 5 }, { stance: { bait: true } });
    expect(guardAgainst(bait, [bait], 0)).toBe(BAIT_AC);
    expect(guardAgainst(bait, [bait], COVER_AC)).toBe(COVER_AC);
  });

  it('бонус к КБ переводится в долю снятого урона монотонно', () => {
    expect(guardMitigation(0)).toBe(0);
    expect(guardMitigation(COVER_AC)).toBeGreaterThan(0.15);
    expect(guardMitigation(BRACE_AC)).toBeGreaterThan(guardMitigation(COVER_AC));
    // честная pf2e-шкала слабее прежних долей: глухая оборона снимает не 2/3
    expect(guardMitigation(BRACE_AC)).toBeLessThan(0.5);
  });
});

describe('поднять щит', () => {
  const tank = (over: Partial<CombatUnit> = {}): Fighter =>
    fighter('tank', 'party', { x: 5, y: 5 }, { shield: { ...SHIELD }, ...over }, [atkNearest]);

  it('щитоносцу дешёвая оборона — щит, безоружному — «прикрыться»', () => {
    const foe = fighter('e', 'foe', { x: 6, y: 5 });
    const withShield = tank();
    const kinds = (self: Fighter): string[] =>
      generateCandidates(self, [self, foe], undefined, 1).map((c) => c.action);
    expect(kinds(withShield)).toContain('raiseShield');
    expect(kinds(withShield)).not.toContain('cover');
    const bare = fighter('bare', 'party', { x: 5, y: 5 }, {}, [atkNearest]);
    expect(kinds(bare)).toContain('cover');
    expect(kinds(bare)).not.toContain('raiseShield');
  });

  it('сломанный щит не поднимается', () => {
    const foe = fighter('e', 'foe', { x: 6, y: 5 });
    const broken = tank({ shieldBroken: true });
    const kinds = generateCandidates(broken, [broken, foe], undefined, 1).map((c) => c.action);
    expect(kinds).not.toContain('raiseShield');
    expect(kinds).toContain('cover');
  });

  it('бонус берётся со щита носителя, а пирс приёма его режет', () => {
    const heavy = tank({ shield: { ac: 3, hardness: 3, hp: 6 } });
    expect(guardFor('raiseShield', heavy)).toBe(3);
    const breakMove = heroArchetype('ryk').weapons.flatMap((w) => w.moves ?? []).find((m) => m.id === 'rykBreak')!;
    // «пролом щитов» оставляет цели треть бонуса — оборону пробивают
    expect(stanceGuard(BRACE_AC, breakMove, undefined)).toBe(Math.round(BRACE_AC * breakMove.pierce!));
  });
});

describe('щит в бою: блок, раз в раунд, поломка', () => {
  // танк не может ни двигаться, ни бить: единственное осмысленное действие —
  // поднять щит, поэтому сцена детерминированно показывает блок
  const scene = (shield: ShieldSpec | undefined, foes: number): UnitSpec[] => [
    spec({ id: 'tank', side: 'party', spawn: { x: 5, y: 5 }, maxHp: 300, atk: 1, shield }),
    ...Array.from({ length: foes }, (_, i) =>
      spec({ id: `e${i}`, side: 'foe', spawn: { x: 6, y: 5 + i }, atk: 8, rules: [atkNearest] }),
    ),
  ];

  it('поднятый щит гасит удар на твёрдость — и не больше раза в раунд', () => {
    const res = runBattle(11, scene({ ac: 2, hardness: 3, hp: 100 }, 2));
    const blocks = events(res.events, 'shieldBlock') as Extract<BattleEvent, { t: 'shieldBlock' }>[];
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => b.unit === 'tank' && b.absorbed <= 3)).toBe(true);
    // в каждом раунде блок один: считаем по раундам лога
    let round = 0;
    const perRound = new Map<number, number>();
    for (const e of res.events) {
      if (e.t === 'round') round = e.n;
      if (e.t === 'shieldBlock') perRound.set(round, (perRound.get(round) ?? 0) + 1);
    }
    expect(Math.max(...perRound.values())).toBe(1);
  });

  it('щит копит вмятины и разваливается — дальше ни блока, ни бонуса', () => {
    const res = runBattle(11, scene({ ac: 2, hardness: 3, hp: 6 }, 2));
    const breaks = events(res.events, 'shieldBreak');
    expect(breaks.length).toBe(1);
    const breakAt = res.events.findIndex((e) => e.t === 'shieldBreak');
    expect(res.events.slice(breakAt).some((e) => e.t === 'shieldBlock')).toBe(false);
    const tank = res.units.find((u) => u.id === 'tank')!;
    expect(tank.shieldBroken).toBe(true);
    expect(shieldRaised(tank)).toBe(false);
  });

  it('смоук: со щитом танк держится дольше, чем просто прикрываясь', () => {
    // мерим раунды, а не потерянные hp: под двумя ударниками танк всё равно
    // ляжет, вопрос — насколько дольше он продержит строй. Сравнение честное:
    // без щита он тратит то же очко на «прикрыться» (+2 к КБ), так что вся
    // разница — поглощение твёрдостью
    const held = (shield: ShieldSpec | undefined): number => {
      let rounds = 0;
      for (let seed = 1; seed <= 10; seed++) rounds += runBattle(seed * 101, scene(shield, 2)).rounds;
      return rounds;
    };
    expect(held({ ac: 2, hardness: 3, hp: 100 })).toBeGreaterThan(held(undefined) * 1.1);
  });
});

describe('застигнут врасплох', () => {
  it('фланг снимает КБ, а урон прошедшего удара не множит', () => {
    // цель между двумя ударниками: фланг есть, прикрытия у неё нет
    const res = runBattle(11, [
      spec({ id: 'a', side: 'party', spawn: { x: 4, y: 5 }, rules: [atkNearest] }),
      spec({ id: 'b', side: 'party', spawn: { x: 6, y: 5 }, rules: [atkNearest] }),
      spec({ id: 'e', side: 'foe', spawn: { x: 5, y: 5 }, maxHp: 400, atk: 1, rules: [atkNearest] }),
    ]);
    const hits = res.events.filter(
      (e): e is Extract<BattleEvent, { t: 'attack' }> => e.t === 'attack' && e.target === 'e' && e.outcome !== 'miss',
    );
    expect(hits.some((h) => h.flank)).toBe(true);
    // фланговые и лобовые удары одного бойца несут один и тот же урон:
    // множителя больше нет, вся разница — в броске (план armor)
    const byFlank = (flank: boolean): number[] =>
      hits.filter((h) => h.unit === 'a' && h.flank === flank && h.action === 'attack').map((h) => h.dmg);
    const flanked = byFlank(true);
    const front = byFlank(false);
    if (flanked.length > 0 && front.length > 0) {
      expect(new Set([...flanked, ...front]).size).toBeLessThanOrEqual(2); // крит — вдвое, прочее одинаково
    }
  });

  it('глубже общего — у плутовского пассива', () => {
    expect(heroArchetype('tessa').passives?.sneak?.offGuard).toBe(3);
    expect(OFF_GUARD_AC).toBe(2);
  });
});

describe('щит виден игроку', () => {
  it('строка щита в карточке и в разведке', () => {
    expect(describeShield({ ac: 2, hardness: 3, hp: 10 })).toBe(
      'щит +2 к КБ · гасит 3 (раз в раунд) · запас 10',
    );
    expect(heroArchetype('grom').shield).toBeDefined();
    expect(heroArchetype('skala').shield).toBeDefined();
    expect(soldier(1, 'soldier2').shield).toBeDefined();
  });
});

describe('оборона и укрытие в решении', () => {
  it('под обстрелом щитоносец поднимает щит, а не стоит открытым', () => {
    const self = fighter('tank', 'party', { x: 5, y: 5 }, { shield: { ...SHIELD }, move: 0, range: 1 }, [
      rule({ kind: 'brace' }, 2),
    ]);
    const shooters = [
      fighter('s1', 'foe', { x: 5, y: 8 }, { range: 6, atk: 9 }),
      fighter('s2', 'foe', { x: 8, y: 5 }, { range: 6, atk: 9 }),
    ];
    const d = decide(self, [self, ...shooters], 1, () => false, 1, makeCtx());
    expect(d.chosen.action).toBe('raiseShield');
  });
});
