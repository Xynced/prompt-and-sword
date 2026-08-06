import { describe, expect, it } from 'vitest';
import type { Rule } from '../src/ir.js';
import { LENS_POOL, applyLens, rollLenses } from '../src/lens.js';
import { mulberry32 } from '../src/rng.js';
import { type UnitSpec, runBattle } from '../src/battle.js';
import { type Fighter, decide, generateCandidates, makeCtx } from '../src/scoring.js';
import { pickTerrain } from '../src/terrain.js';
import type { CombatUnit, LensId, Pos, Side } from '../src/types.js';

const attack = (w = 2): Rule => ({
  when: { kind: 'always' },
  then: { kind: 'attack', target: 'nearest' },
  weight: w,
  scope: 'self',
  source: 'бей ближайшего',
});
const protect = (): Rule => ({
  when: { kind: 'always' },
  then: { kind: 'protect', ally: 'mage' },
  weight: 2,
  scope: 'self',
  source: 'прикрывай мага',
});
const retreat = (): Rule => ({
  when: { kind: 'hpBelow', who: 'self', frac: 0.5 },
  then: { kind: 'retreat' },
  weight: 2,
  scope: 'self',
  source: 'ранен — отходи',
});

describe('линза: plain', () => {
  it('ничего не меняет', () => {
    const rules = [attack(), protect(), retreat()];
    const c = applyLens(['plain'], rules);
    expect(c.rules).toEqual(rules);
    expect(c.instincts).toMatchObject({ aggression: 1, survival: 1, ignoreZoC: false, gapFill: true });
  });
});

describe('линза: трус', () => {
  it('«прикрывать» превращается в «стоять позади»', () => {
    const c = applyLens(['coward'], [protect()]);
    const r = c.rules[0]!;
    expect(r.then).toEqual({ kind: 'behind', ref: { type: 'ally', id: 'mage' } });
    expect(r.source).toContain('трус');
  });

  it('атакующие правила получают штраф веса', () => {
    const c = applyLens(['coward'], [attack(2)]);
    expect(c.rules[0]!.weight).toBeCloseTo(1.4);
  });

  it('добавляется правило бегства при hp<30%', () => {
    const c = applyLens(['coward'], [attack()]);
    const flee = c.rules.find((r) => r.then.kind === 'retreat')!;
    expect(flee.when).toEqual({ kind: 'hpBelow', who: 'self', frac: 0.3 });
    expect(flee.weight).toBe(100);
  });

  it('инстинкты: самосохранение выше, агрессия ниже', () => {
    const c = applyLens(['coward'], []);
    expect(c.instincts.survival).toBeGreaterThan(1);
    expect(c.instincts.aggression).toBeLessThan(1);
  });
});

describe('линза: фанатик', () => {
  it('«отступай» превращается в «атакуй ближайшего»', () => {
    const c = applyLens(['fanatic'], [retreat()]);
    const r = c.rules[0]!;
    expect(r.then).toEqual({ kind: 'attack', target: 'nearest' });
    expect(r.when).toEqual(retreat().when); // условие сохраняется
    expect(r.source).toContain('фанатик');
  });

  it('игнорирует зоны контроля, агрессия выше', () => {
    const c = applyLens(['fanatic'], []);
    expect(c.instincts.ignoreZoC).toBe(true);
    expect(c.instincts.aggression).toBeGreaterThan(1);
    expect(c.instincts.survival).toBeLessThan(1);
  });
});

describe('линза: буквалист', () => {
  it('правила не трогает, но не достраивает пропуски', () => {
    const rules = [attack(), retreat()];
    const c = applyLens(['literalist'], rules);
    expect(c.rules).toEqual(rules);
    expect(c.instincts.gapFill).toBe(false);
  });
});

describe('линза: мститель', () => {
  it('добавляет правило «бить обидчика», агрессия выше', () => {
    const c = applyLens(['avenger'], [attack()]);
    const r = c.rules.find((x) => x.then.kind === 'attack' && x.then.target === 'attacker')!;
    expect(r.weight).toBe(2.5);
    expect(r.source).toContain('инстинкт мстителя');
    expect(c.instincts.aggression).toBeGreaterThan(1);
  });
});

describe('линза: дуэлянт', () => {
  it('«бей слабейшего» → «вызывай сильнейшего»', () => {
    const weakest: Rule = {
      when: { kind: 'always' },
      then: { kind: 'attack', target: 'weakest' },
      weight: 2,
      scope: 'self',
      source: 'добивай раненых',
    };
    const c = applyLens(['duelist'], [weakest]);
    expect(c.rules[0]!.then).toEqual({ kind: 'attack', target: 'mostDangerous' });
    expect(c.rules[0]!.source).toContain('дуэлянт');
  });

  it('«фланг» → «атакуй в лоб»', () => {
    const flank: Rule = {
      when: { kind: 'always' },
      then: { kind: 'flank' },
      weight: 1,
      scope: 'self',
      source: 'заходи с фланга',
    };
    const c = applyLens(['duelist'], [flank]);
    expect(c.rules[0]!.then).toEqual({ kind: 'attack', target: 'nearest' });
  });
});

describe('линза: славолюб', () => {
  it('любая атака перенацеливается на вожака', () => {
    const c = applyLens(['gloryhound'], [attack()]);
    expect(c.rules[0]!.then).toEqual({ kind: 'attack', target: 'leader' });
    expect(c.rules[0]!.source).toContain('славолюб');
  });

  it('атака вожака не помечается', () => {
    const leader: Rule = {
      when: { kind: 'always' },
      then: { kind: 'attack', target: 'leader' },
      weight: 2,
      scope: 'self',
      source: 'фокусь вожака',
    };
    const c = applyLens(['gloryhound'], [leader]);
    expect(c.rules[0]).toEqual(leader);
  });
});

describe('линза: наседка', () => {
  it('защита усиливается, добавляется прикрытие раненых', () => {
    const c = applyLens(['guardian'], [protect()]);
    expect(c.rules[0]!.weight).toBeCloseTo(2.8);
    const cover = c.rules.find((x) => x.then.kind === 'coverRetreat')!;
    expect(cover.source).toContain('инстинкт наседки');
    expect(c.instincts.survival).toBeGreaterThan(1);
    expect(c.instincts.aggression).toBeLessThan(1);
  });
});

describe('линза: параноик', () => {
  it('добавляет «вне линии огня», самосохранение выше', () => {
    const c = applyLens(['paranoid'], [attack()]);
    const r = c.rules.find((x) => x.then.kind === 'avoidLineOfFire')!;
    expect(r.source).toContain('инстинкт параноика');
    expect(c.instincts.survival).toBeGreaterThan(1);
  });
});

describe('линза: горячка', () => {
  it('«держи позицию» и «приманка» → «атакуй ближайшего»', () => {
    const hold: Rule = {
      when: { kind: 'always' },
      then: { kind: 'holdPosition' },
      weight: 2,
      scope: 'self',
      source: 'держи позицию',
    };
    const bait: Rule = {
      when: { kind: 'always' },
      then: { kind: 'bait' },
      weight: 1,
      scope: 'self',
      source: 'изображай приманку',
    };
    const c = applyLens(['hothead'], [hold, bait]);
    expect(c.rules[0]!.then).toEqual({ kind: 'attack', target: 'nearest' });
    expect(c.rules[1]!.then).toEqual({ kind: 'attack', target: 'nearest' });
    expect(c.instincts.aggression).toBeGreaterThan(1);
    expect(c.instincts.survival).toBeLessThan(1);
  });
});

describe('линза: позёр', () => {
  it('фланг усиливается, добавляется приманка', () => {
    const flank: Rule = {
      when: { kind: 'always' },
      then: { kind: 'flank' },
      weight: 2,
      scope: 'self',
      source: 'заходи с фланга',
    };
    const c = applyLens(['showman'], [flank]);
    expect(c.rules[0]!.weight).toBeCloseTo(3);
    const bait = c.rules.find((x) => x.then.kind === 'bait')!;
    expect(bait.source).toContain('инстинкт позёра');
  });
});

describe('композиция линз', () => {
  it('пустой список = правила и инстинкты как есть', () => {
    const rules = [attack(), retreat()];
    const c = applyLens([], rules);
    expect(c.rules).toEqual(rules);
    expect(c.instincts).toEqual({
      aggression: 1,
      survival: 1,
      ffCare: 1,
      ignoreZoC: false,
      gapFill: true,
      actionBias: {},
    });
  });

  it('множители перемножаются, флаги складываются', () => {
    const c = applyLens(['coward', 'fanatic'], []);
    expect(c.instincts.aggression).toBeCloseTo(0.7 * 1.6);
    expect(c.instincts.survival).toBeCloseTo(2.2 * 0.4);
    expect(c.instincts.ignoreZoC).toBe(true);
    expect(c.instincts.gapFill).toBe(true);
  });

  it('порядок линз важен: трус→фанатик ≠ фанатик→трус', () => {
    // трус сперва добавляет бегство, фанатик обращает его в атаку — и наоборот
    const rules = [retreat()];
    const a = applyLens(['coward', 'fanatic'], rules);
    const b = applyLens(['fanatic', 'coward'], rules);
    expect(a.rules).not.toEqual(b.rules);
  });
});

describe('rollLenses', () => {
  it('выпадает 1–3 разных линзы из пула', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const lenses = rollLenses(mulberry32(seed));
      expect(lenses.length).toBeGreaterThanOrEqual(1);
      expect(lenses.length).toBeLessThanOrEqual(3);
      expect(new Set(lenses).size).toBe(lenses.length);
      for (const l of lenses) expect(LENS_POOL).toContain(l);
    }
  });

  it('детерминирован сидом', () => {
    expect(rollLenses(mulberry32(7))).toEqual(rollLenses(mulberry32(7)));
  });
});

describe('характер выбирает действие', () => {
  /**
   * Доли действий бойца с одним и тем же приказом, но разным характером.
   * `ally` добавляет в партию хилого союзника под ударом — иначе прикрыть
   * собой некого и тяга наседки не проявляется.
   */
  function actionMix(lenses: LensId[], ally = false): Record<string, number> {
    const counts = new Map<string, number>();
    let total = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const hero: UnitSpec = {
        id: 'h', name: 'Боец', side: 'party', maxHp: 60, atk: 8, range: 1,
        speed: 5, move: 2, lenses, rules: [attack()], spawn: { x: 4, y: 5 },
      };
      const mate: UnitSpec = {
        id: 'm', name: 'Хиляк', side: 'party', maxHp: 16, atk: 3, range: 1,
        speed: 1, move: 1, lenses: ['plain'], rules: [attack()], spawn: { x: 5, y: 5 },
      };
      const foes: UnitSpec[] = [1, 2].map((i) => ({
        id: `f${i}`, name: `Враг ${i}`, side: 'foe', maxHp: 40, atk: 6, range: 1,
        speed: 4, move: 2, lenses: ['plain'], rules: [attack()], spawn: { x: 6, y: 4 + i },
      }));
      const party = ally ? [hero, mate] : [hero];
      for (const e of runBattle(seed, [...party, ...foes]).events) {
        if (e.t !== 'decision' || e.unit !== 'h') continue;
        counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
        total++;
      }
    }
    return Object.fromEntries([...counts].map(([k, v]) => [k, v / total]));
  }

  const plain = actionMix(['plain']);

  it('трус прикрывается, фанатик не прикрывается вовсе', () => {
    const shield = (m: Record<string, number>): number => (m.cover ?? 0) + (m.fullCover ?? 0);
    expect(shield(actionMix(['coward']))).toBeGreaterThan(shield(plain));
    // «щиты — для трусов»: нулевая тяга — это запрет, а не редкость
    expect(shield(actionMix(['fanatic']))).toBe(0);
  });

  it('фанатик бьёт отчаянно чаще обычного, трус — реже', () => {
    expect(actionMix(['fanatic']).selflessAttack ?? 0).toBeGreaterThan(plain.selflessAttack ?? 0);
    expect(actionMix(['coward']).selflessAttack ?? 0).toBeLessThan(plain.selflessAttack ?? 0);
  });

  it('горячка бьёт вполсилы чаще, дуэлянт — реже', () => {
    expect(actionMix(['hothead']).weakAttack ?? 0).toBeGreaterThan(plain.weakAttack ?? 0);
    expect(actionMix(['duelist']).weakAttack ?? 0).toBeLessThan(plain.weakAttack ?? 0);
  });

  it('наседка закрывает союзника собой, обычный боец — нет', () => {
    expect(actionMix(['guardian'], true).shieldAlly ?? 0).toBeGreaterThan(
      actionMix(['plain'], true).shieldAlly ?? 0,
    );
  });
});

describe('линзы и поле (план поля, шаг 9)', () => {
  function fielder(id: string, side: Side, pos: Pos, lenses: LensId[], rules: Rule[], over: Partial<CombatUnit> = {}): Fighter {
    return {
      id, name: id, side, maxHp: 20, hp: 20, atk: 5, range: 1, speed: 5, move: 2,
      pos, startPos: { ...pos }, alive: true, coverLevel: 0, exposed: false, tags: [],
      lenses, ...over, compiled: applyLens(lenses, rules),
    };
  }
  const shove: Rule = { when: { kind: 'always' }, then: { kind: 'shove' }, weight: 2, scope: 'self', source: 'толкай' };

  it('тяга к новым действиям роздана скупо: трус/параноик, фанатик, дуэлянт', () => {
    expect(applyLens(['coward'], []).instincts.actionBias.carefulStep).toBe(1.5);
    expect(applyLens(['paranoid'], []).instincts.actionBias.carefulStep).toBe(1.5);
    expect(applyLens(['fanatic'], []).instincts.actionBias.carefulStep).toBe(0.3);
    expect(applyLens(['fanatic'], []).instincts.actionBias.shove).toBe(0);
    expect(applyLens(['duelist'], []).instincts.actionBias.shove).toBe(0);
  });

  it('фанатик прёт по шипам обычным шагом там, где обычный идёт осторожно', () => {
    // теснина (сид 8): цель за шипами (8,6) — бить можно только с них
    const layout = pickTerrain(8);
    const blocked = (p: Pos): boolean => layout.tiles[p.y]?.[p.x]?.blocked === true;
    const ctx = makeCtx(blocked, layout.tiles);
    const enemy = fielder('e', 'foe', { x: 8, y: 5 }, ['plain'], [], { move: 0 });
    const plain = fielder('s', 'party', { x: 7, y: 7 }, ['plain'], [attack()]);
    expect(decide(plain, [plain, enemy], 1, blocked, 3, ctx).chosen.action).toBe('carefulStep');
    const fanatic = fielder('f', 'party', { x: 7, y: 7 }, ['fanatic'], [attack()]);
    expect(decide(fanatic, [fanatic, enemy], 1, blocked, 3, ctx).chosen.action).toBe('move');
  });

  it('фанатик и дуэлянт не толкаются даже со словом: нулевая тяга — запрет', () => {
    const enemy = fielder('e', 'foe', { x: 6, y: 5 }, ['plain'], []);
    for (const lens of ['fanatic', 'duelist'] as const) {
      const self = fielder('s', 'party', { x: 5, y: 5 }, [lens], [shove]);
      expect(generateCandidates(self, [self, enemy]).some((c) => c.action === 'shove')).toBe(false);
    }
    const control = fielder('s', 'party', { x: 5, y: 5 }, ['plain'], [shove]);
    expect(generateCandidates(control, [control, enemy]).some((c) => c.action === 'shove')).toBe(true);
  });
});

describe('детерминизм линз', () => {
  it('одинаковый вход — одинаковый выход', () => {
    const rules = [attack(), protect(), retreat()];
    expect(applyLens(['coward'], rules)).toEqual(applyLens(['coward'], rules));
    expect(applyLens(['fanatic'], rules)).toEqual(applyLens(['fanatic'], rules));
  });

  it('исходный массив правил не мутирует', () => {
    const rules = [attack(2)];
    applyLens(['coward'], rules);
    expect(rules[0]!.weight).toBe(2);
  });
});
