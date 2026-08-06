import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import { type Fighter, attackMult, effectiveCover, generateCandidates } from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { expectedDamage } from '../src/tuning.js';
import type { CombatUnit, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';

/**
 * Щит союзнику — правка механики прикрытия: щит кроет только смежного, и
 * чужое прикрытие живёт, лишь пока щитоносец жив и рядом. Уведённый толчком
 * подопечный или ушедший/павший защитник гасят его в момент удара; своё
 * прикрытие (прикрыться/глухая защита) от разлуки не зависит.
 */

function fighter(id: string, side: Side, pos: Pos, over: Partial<CombatUnit> = {}, rules: Rule[] = []): Fighter {
  return {
    id,
    name: id,
    side,
    maxHp: 40,
    hp: 40,
    atk: 7,
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

const r = (rule: Omit<Rule, 'scope'>): Rule => ({ ...rule, scope: 'self' });
const atkNearest = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 2, source: 'бей ближайшего' });

const spec = (over: Partial<UnitSpec> & Pick<UnitSpec, 'id' | 'side' | 'spawn'>): UnitSpec => ({
  name: over.id,
  maxHp: 600,
  atk: 7,
  range: 1,
  speed: 5,
  move: 0,
  lenses: ['plain'],
  rules: [],
  ...over,
});

const attacksIn = (events: readonly BattleEvent[]): Extract<BattleEvent, { t: 'attack' }>[] =>
  events.filter((e): e is Extract<BattleEvent, { t: 'attack' }> => e.t === 'attack');

describe('щит союзнику требует смежности', () => {
  it('кандидат есть только на смежного союзника', () => {
    const self = fighter('g', 'party', { x: 5, y: 5 });
    const near = fighter('near', 'party', { x: 6, y: 5 });
    const far = fighter('far', 'party', { x: 9, y: 5 });
    const foe = fighter('e', 'foe', { x: 12, y: 5 });
    const cands = generateCandidates(self, [self, near, far, foe]);
    expect(cands.some((c) => c.action === 'shieldAlly' && c.targetId === 'near')).toBe(true);
    expect(cands.some((c) => c.action === 'shieldAlly' && c.targetId === 'far')).toBe(false);
  });

  it('поверх живого чужого прикрытия того же уровня не предлагается; поверх мёртвого — снова да', () => {
    const self = fighter('g', 'party', { x: 5, y: 5 });
    const near = fighter('near', 'party', { x: 6, y: 5 });
    const g2 = fighter('g2', 'party', { x: 6, y: 6 });
    const foe = fighter('e', 'foe', { x: 12, y: 5 });
    near.guardedBy = { id: 'g2', level: 0.25 };
    const shieldNear = (c: { action: string; targetId?: string }): boolean =>
      c.action === 'shieldAlly' && c.targetId === 'near';
    expect(generateCandidates(self, [self, near, g2, foe]).some(shieldNear)).toBe(false);
    g2.alive = false; // защитник пал — его прикрытие уже не действует
    expect(generateCandidates(self, [self, near, g2, foe]).some(shieldNear)).toBe(true);
  });

  it('в бою дальний подопечный щита не получает', () => {
    // наседка с move 0 не дотягивается до подопечного через полполя: раньше
    // щит прилетал телепортом, теперь события «прикрыл союзника» нет вовсе
    const res = runBattle(11, [
      spec({ id: 'tank', side: 'party', spawn: { x: 2, y: 8 }, speed: 9, lenses: ['guardian'] }),
      spec({ id: 'ward', side: 'party', spawn: { x: 10, y: 8 }, maxHp: 100, speed: 6, rules: [atkNearest] }),
      spec({ id: 'foe1', side: 'foe', spawn: { x: 11, y: 8 }, atk: 12, speed: 7, rules: [atkNearest] }),
    ]);
    expect(res.events.some((e) => e.t === 'cover' && e.ally !== undefined)).toBe(false);
  });
});

describe('чужое прикрытие живёт, пока защитник жив и смежен', () => {
  const scene = (): { ward: Fighter; tank: Fighter } => {
    const ward = fighter('ward', 'party', { x: 5, y: 5 });
    const tank = fighter('tank', 'party', { x: 6, y: 5 });
    ward.guardedBy = { id: 'tank', level: 0.4 };
    return { ward, tank };
  };

  it('смежный живой защитник — уровень щита; своё прикрытие берётся максимумом', () => {
    const { ward, tank } = scene();
    expect(effectiveCover(ward, [ward, tank])).toBe(0.4);
    ward.coverLevel = 0.67; // глухая защита сильнее щита
    expect(effectiveCover(ward, [ward, tank])).toBe(0.67);
  });

  it('защитник отошёл — чужое гаснет, своё остаётся', () => {
    const { ward, tank } = scene();
    tank.pos = { x: 8, y: 5 };
    expect(effectiveCover(ward, [ward, tank])).toBe(0);
    ward.coverLevel = 0.25;
    expect(effectiveCover(ward, [ward, tank])).toBe(0.25);
  });

  it('павший защитник не кроет', () => {
    const { ward, tank } = scene();
    tank.alive = false;
    expect(effectiveCover(ward, [ward, tank])).toBe(0);
  });
});

describe('в бою: толчок уводит подопечного из-под щита', () => {
  // сцена: наседка-щитоносец (−40%) кроет смежного подопечного; враг-толкач
  // может увести подопечного на два шага от щита, ударник бьёт следом.
  // Сравнение через границы броска (0.85–1.15): укрытый удар не может
  // дотянуться до минимума чистого — сцены не требуют выравнивания rng
  // чистый угол «поляны» (сид 11): камни (7,5)/(5,10)/(10,12) в стороне.
  // Толчок с (6,2) уводит подопечного (5,3) → (4,4): от щитоносца (4,2) это
  // уже дистанция 2; ударник (5,4) смежен с обеими позициями подопечного
  const scene = (pusherRules: Rule[]): UnitSpec[] => [
    spec({
      id: 'tank', side: 'party', spawn: { x: 4, y: 2 }, speed: 9, lenses: ['guardian'],
      passives: { shieldwall: { cover: 0.4 } },
    }),
    spec({ id: 'ward', side: 'party', spawn: { x: 5, y: 3 }, maxHp: 100, speed: 6, rules: [atkNearest] }),
    spec({ id: 'pusher', side: 'foe', spawn: { x: 6, y: 2 }, atk: 5, speed: 8, rules: pusherRules }),
    spec({ id: 'striker', side: 'foe', spawn: { x: 5, y: 4 }, atk: 40, speed: 7, rules: [atkNearest] }),
  ];
  const strikerHit = (events: readonly BattleEvent[]): Extract<BattleEvent, { t: 'attack' }> =>
    attacksIn(events).find((e) => e.unit === 'striker' && e.target === 'ward')!;
  const E = (action: Extract<BattleEvent, { t: 'attack' }>['action']): number =>
    expectedDamage(40 * attackMult(action));

  it('подопечный у плеча: удар режется щитом −40%', () => {
    const res = runBattle(11, scene([]));
    expect(res.terrain.name).toBe('поляна');
    expect(res.events.some((e) => e.t === 'cover' && e.unit === 'tank' && e.ally === 'ward' && e.level === 0.4)).toBe(true);
    const hit = strikerHit(res.events);
    expect(hit.dmg).toBeLessThanOrEqual(Math.round(E(hit.action) * 1.15 * 0.6) + 1);
  });

  it('увели толчком — щит спал, удар проходит в полную силу', () => {
    const shove = r({ when: { kind: 'always' }, then: { kind: 'shove' }, weight: 5, source: 'толкай' });
    const res = runBattle(11, scene([shove]));
    expect(res.events.some((e) => e.t === 'cover' && e.unit === 'tank' && e.ally === 'ward' && e.level === 0.4)).toBe(true);
    expect(res.events.some((e) => e.t === 'shove' && e.target === 'ward')).toBe(true);
    const hit = strikerHit(res.events);
    expect(hit.dmg).toBeGreaterThanOrEqual(Math.round(E(hit.action) * 0.85) - 1);
  });
});
