import { describe, expect, it } from 'vitest';
import { applyLens } from '../src/lens.js';
import { type Fighter, attackMult, effectiveGuard, generateCandidates, shieldsFrom } from '../src/scoring.js';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { BRACE_AC, COVER_AC, expectedDamage } from '../src/tuning.js';
import type { CombatUnit, Pos, Side } from '../src/types.js';
import type { Rule } from '../src/ir.js';
import { dist } from '../src/grid.js';

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
    guard: 0,
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
    near.guardedBy = { id: 'g2', bonus: COVER_AC };
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
    ward.guardedBy = { id: 'tank', bonus: 3 };
    return { ward, tank };
  };

  it('смежный живой защитник — бонус щита; своя оборона берётся максимумом', () => {
    const { ward, tank } = scene();
    expect(effectiveGuard(ward, [ward, tank])).toBe(3);
    ward.guard = BRACE_AC; // глухая защита сильнее щита
    expect(effectiveGuard(ward, [ward, tank])).toBe(BRACE_AC);
  });

  it('защитник отошёл — чужое гаснет, своё остаётся', () => {
    const { ward, tank } = scene();
    tank.pos = { x: 8, y: 5 };
    expect(effectiveGuard(ward, [ward, tank])).toBe(0);
    ward.guard = COVER_AC;
    expect(effectiveGuard(ward, [ward, tank])).toBe(COVER_AC);
  });

  it('павший защитник не кроет', () => {
    const { ward, tank } = scene();
    tank.alive = false;
    expect(effectiveGuard(ward, [ward, tank])).toBe(0);
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
      passives: { shieldwall: { ac: 3 } },
    }),
    spec({ id: 'ward', side: 'party', spawn: { x: 5, y: 3 }, maxHp: 100, speed: 6, rules: [atkNearest] }),
    spec({ id: 'pusher', side: 'foe', spawn: { x: 6, y: 2 }, atk: 5, speed: 8, rules: pusherRules }),
    spec({ id: 'striker', side: 'foe', spawn: { x: 5, y: 4 }, atk: 40, speed: 7, rules: [atkNearest] }),
  ];
  const strikerHit = (events: readonly BattleEvent[]): Extract<BattleEvent, { t: 'attack' }> =>
    attacksIn(events).find((e) => e.unit === 'striker' && e.target === 'ward' && e.outcome !== 'miss')!;
  const E = (action: Extract<BattleEvent, { t: 'attack' }>['action']): number =>
    expectedDamage(40 * attackMult(action));

  it('подопечный у плеча: щит идёт в КБ, а прошедший удар несёт полную силу', () => {
    const res = runBattle(11, scene([]));
    expect(res.terrain.name).toBe('поляна');
    expect(res.events.some((e) => e.t === 'cover' && e.unit === 'tank' && e.ally === 'ward' && e.bonus === 3)).toBe(true);
    const hit = strikerHit(res.events);
    // щит больше не режет урон (план armor): он поднимает КБ подопечного,
    // поэтому дошедший удар бьёт в полную силу — плата взимается промахами
    const swing = hit.outcome === 'crit' ? 2 : 1;
    expect(hit.dmg).toBeGreaterThanOrEqual(Math.round(E(hit.action) * swing) - 1);
  });

  it('увели толчком — щит спал: подопечный без чужого прикрытия', () => {
    const shove = r({ when: { kind: 'always' }, then: { kind: 'shove' }, weight: 5, source: 'толкай' });
    const res = runBattle(11, scene([shove]));
    expect(res.events.some((e) => e.t === 'cover' && e.unit === 'tank' && e.ally === 'ward' && e.bonus === 3)).toBe(true);
    expect(res.events.some((e) => e.t === 'shove' && e.target === 'ward')).toBe(true);
    const ward = res.units.find((u) => u.id === 'ward')!;
    const tank = res.units.find((u) => u.id === 'tank')!;
    if (dist(ward.pos, tank.pos) > 1) expect(effectiveGuard(ward, res.units)).toBe(0);
  });

  it('смоук: под щитом по подопечному промахиваются чаще', () => {
    // цена щита теперь в бросках, а не в уроне: сравниваем долю промахов
    // ударника по подопечному со щитоносцем-наседкой и без него.
    // Щитоносец стоит МЕЖДУ ударником и подопечным: прикрытие направленное
    // (глобальный багфикс защиты), из-за спины подопечного щита нет. Оттого он
    // смежен и с ударником — «ближайшего» между ними не выбрать, поэтому
    // ударник бьёт по опасному (у подопечного atk 7, у щитоносца 1)
    const atkDangerous = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'mostDangerous' }, weight: 2, source: 'бей опасного' });
    const missShare = (guarded: boolean): number => {
      let swings = 0;
      let misses = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const res = runBattle(seed * 101, [
          // без щита — тот же щитоносец, но за полем: подопечный дерётся сам
          spec({
            id: 'tank', side: 'party', spawn: guarded ? { x: 4, y: 3 } : { x: 1, y: 12 }, speed: 9, atk: 1,
            lenses: ['guardian'], passives: { shieldwall: { ac: 3 } },
          }),
          spec({ id: 'ward', side: 'party', spawn: { x: 5, y: 3 }, maxHp: 400, speed: 6, rules: [atkNearest] }),
          spec({ id: 'striker', side: 'foe', spawn: { x: 5, y: 4 }, maxHp: 400, atk: 8, speed: 7, rules: [atkDangerous] }),
        ]);
        for (const e of attacksIn(res.events)) {
          if (e.unit !== 'striker' || e.target !== 'ward') continue;
          swings++;
          if (e.outcome === 'miss') misses++;
        }
      }
      expect(swings).toBeGreaterThan(50);
      return misses / swings;
    };
    expect(missShare(true)).toBeGreaterThan(missShare(false) + 0.05);
  });
});

/**
 * Направленность прикрытия (глобальный багфикс защиты): тело закрывает от того,
 * к кому повёрнуто. Формально — защитник не дальше от бьющего, чем прикрытый;
 * в ближнем бою это ровно «защитник смежен и с врагом тоже».
 */
describe('чужой щит направленный', () => {
  it('кроет от врага со своей стороны и не кроет от зашедшего за спину', () => {
    const ward = fighter('ward', 'party', { x: 5, y: 5 });
    const tank = fighter('tank', 'party', { x: 4, y: 5 });
    ward.guardedBy = { id: 'tank', bonus: COVER_AC };
    const units = [ward, tank];
    // враг заходит со стороны щитоносца — щит в деле
    expect(effectiveGuard(ward, units, { x: 3, y: 5 })).toBe(COVER_AC);
    // враг встал вплотную с другой стороны: щитоносец от него дальше самого
    // подопечного, закрывать нечем
    expect(effectiveGuard(ward, units, { x: 6, y: 5 })).toBe(0);
    // клетку бьющего не назвали (общая оценка угрозы, а не конкретный удар) —
    // щит считается как был, иначе скоринг перестал бы видеть его вовсе
    expect(effectiveGuard(ward, units)).toBe(COVER_AC);
  });

  it('в ближнем бою правило читается как «защитник смежен и с врагом»', () => {
    const ward = { x: 5, y: 5 };
    const tank = { x: 4, y: 5 };
    // враг вплотную к подопечному: щит держит ровно те клетки, что смежны и щиту
    expect(shieldsFrom(tank, ward, { x: 4, y: 4 })).toBe(true);
    expect(shieldsFrom(tank, ward, { x: 5, y: 4 })).toBe(true);
    expect(shieldsFrom(tank, ward, { x: 6, y: 6 })).toBe(false);
    // стрелку хватает и того, что щитоносец не за спиной
    expect(shieldsFrom(tank, ward, { x: 1, y: 5 })).toBe(true);
    expect(shieldsFrom(tank, ward, { x: 9, y: 5 })).toBe(false);
  });

  it('своя оборона стороной не ограничена — направлен только чужой щит', () => {
    const me = fighter('me', 'party', { x: 5, y: 5 }, { guard: BRACE_AC, guardFrom: 'fullCover' });
    expect(effectiveGuard(me, [me], { x: 6, y: 5 })).toBe(BRACE_AC);
    expect(effectiveGuard(me, [me], { x: 4, y: 5 })).toBe(BRACE_AC);
  });
});
