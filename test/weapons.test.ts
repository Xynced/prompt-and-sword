import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import { type Fighter, decide, generateCandidates, scoreCandidate, weaponsOf } from '../src/scoring.js';
import { type UnitSpec, runBattle } from '../src/battle.js';
import { heroArchetype } from '../src/heroes.js';
import { foeIntel, grunt } from '../src/foes.js';
import { describeWeapons } from '../src/cards.js';
import type { CombatUnit, Pos, Side, WeaponSpec } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Оружие (план классов, шаг 1): урон и дальность переезжают с юнита на
 * WeaponSpec; кандидаты атак — на каждое оружие (мастер выбирает по
 * ситуации); аффинность манер — мягкая: слово игрока её перебивает.
 */

function fighter(
  id: string,
  side: Side,
  pos: Pos,
  over: Partial<CombatUnit> = {},
  rules: Rule[] = [],
): Fighter {
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
    coverLevel: 0,
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

const YAR: WeaponSpec[] = heroArchetype('yar').weapons;

const yarAt = (pos: Pos, rules: Rule[]): Fighter =>
  fighter('yar', 'party', pos, { maxHp: 56, weapons: YAR, atk: 8, range: 2 }, rules);

describe('оружие: производные и шортхенд', () => {
  it('weaponsOf: без спеки — неявное оружие из atk/range', () => {
    const bare = fighter('u', 'party', { x: 0, y: 0 }, { atk: 7, range: 3 });
    expect(weaponsOf(bare)).toEqual([{ name: '', dmg: 7, range: 3, aoe: undefined }]);
  });

  it('makeFighter: atk/range юнита — максимумы по оружию (Яр 8/2)', () => {
    const spec: UnitSpec = {
      id: 'yar', name: 'Яр', side: 'party', maxHp: 56, weapons: YAR,
      speed: 5, move: 2, lenses: ['plain'],
      rules: [rule({ kind: 'attack', target: 'nearest' })], spawn: { x: 1, y: 1 },
    };
    const dummy: UnitSpec = {
      id: 'e', name: 'e', side: 'foe', maxHp: 90, atk: 1, range: 1, speed: 1,
      move: 0, lenses: ['plain'], rules: [], spawn: { x: 10, y: 10 },
    };
    const r = runBattle(1, [spec, dummy]);
    const yar = r.units.find((u) => u.id === 'yar')!;
    expect(yar.atk).toBe(8);
    expect(yar.range).toBe(2);
  });
});

describe('мастер оружия выбирает по ситуации', () => {
  it('враг на дистанции 2 — достаёт только копьё', () => {
    const yar = yarAt({ x: 4, y: 4 }, [rule({ kind: 'attack', target: 'nearest' })]);
    const foe = fighter('e', 'foe', { x: 6, y: 4 });
    const cands = generateCandidates(yar, [yar, foe]);
    const attacks = cands.filter((c) => c.targetId === 'e' && c.action === 'attack');
    expect(attacks.map((c) => c.weapon)).toEqual([0]); // копьё
  });

  it('в упор полный удар — молотом (тяжелее), слабый — мечом (кит приёмов)', () => {
    const yar = yarAt({ x: 4, y: 4 }, [rule({ kind: 'attack', target: 'nearest' })]);
    const foe = fighter('e', 'foe', { x: 5, y: 4 });
    const units = [yar, foe];
    // полновесный удар (пролом или сплеча — по обстановке) берёт молот
    const strong = decide(yar, units, 1, () => false, 2);
    expect(['attack', 'selflessAttack']).toContain(strong.chosen.action);
    expect(YAR[strong.chosen.weapon!]!.name).toBe('молот');
    // а среди быстрых приёмов лучший — серия уколов мечом (у молота быстрого
    // темпа нет вовсе — план weapon-moves)
    const score = (c: { action: string }): number =>
      scoreCandidate(c as Parameters<typeof scoreCandidate>[0], yar, units, yar.compiled.rules)
        .reduce((s, f) => s + f.value, 0);
    const weak = generateCandidates(yar, units)
      .filter((c) => c.action === 'weakAttack')
      .sort((a, b) => score(b) - score(a));
    expect(weak.length).toBe(2); // укол копьём и серия уколов; молот не частит
    expect(YAR[weak[0]!.weapon!]!.name).toBe('меч');
  });
});

describe('аффинность мягкая: слово перебивает', () => {
  // аффинность живёт у оружий без кита приёмов (враги, дуэлянт); герои
  // переехали на киты (план weapon-moves) — тут синтетический арбалет
  const XBOW: WeaponSpec[] = [{ name: 'арбалет', dmg: 7, range: 6, affinity: { attack: 1, weakAttack: -1 } }];

  it('без слова стрелок не частит арбалетом', () => {
    const shooter = fighter('shooter', 'party', { x: 4, y: 4 },
      { maxHp: 36, weapons: XBOW, atk: 7, range: 6 },
      [rule({ kind: 'attack', target: 'nearest' })]);
    const foe = fighter('e', 'foe', { x: 8, y: 4 });
    const d = decide(shooter, [shooter, foe], 1, () => false, 3);
    expect(d.chosen.action).toBe('attack');
  });

  it('со словом «бить часто» — частит, аффинность уступает приказу', () => {
    const shooter = fighter('shooter', 'party', { x: 4, y: 4 },
      { maxHp: 36, weapons: XBOW, atk: 7, range: 6 },
      [rule({ kind: 'attack', target: 'nearest' }), rule({ kind: 'strikeOften' })]);
    const foe = fighter('e', 'foe', { x: 8, y: 4 });
    const d = decide(shooter, [shooter, foe], 1, () => false, 3);
    expect(d.chosen.action).toBe('weakAttack');
  });
});

describe('оружие видно игроку', () => {
  it('разведка рядового: имя и урон тесака', () => {
    const intel = foeIntel([grunt(1)])[0]!;
    expect(intel.lines).toContain('оружие: ржавый тесак (удар 5)');
  });

  it('карточка мастера: три оружия с приёмами через «;»', () => {
    expect(describeWeapons(YAR)).toBe(
      'копьё (укол копьём 3 (даль 2); отмах древком 5 (даль 2)); ' +
        'меч (серия уколов 4); ' +
        'молот (пролом 8 (пробивает укрытия); сплеча 12 (открывает))',
    );
  });
});
