import type { Rule } from './ir.js';
import type { UnitSpec } from './battle.js';
import { describeAoe } from './cards.js';
import { applyLens } from './lens.js';

/** Фабрики врагов. Новый враг = новый набор правил, не новый арт. */

const rule = (r: Omit<Rule, 'scope'>): Rule => ({ ...r, scope: 'self' });

/**
 * Разведка: видимые принципы врагов (после линзы характера — то, как враг
 * БУДЕТ себя вести) + площадное оружие носителя АОЕ. Показывается перед боем
 * у элиток и босса: бой становится задачей на контр-формулировку.
 */
export function foeIntel(specs: readonly UnitSpec[]): { name: string; lines: string[] }[] {
  return specs.map((s) => {
    const lines = applyLens(s.lenses, s.rules).rules.map((r) => r.source);
    if (s.aoe) lines.push(`оружие: ${describeAoe(s.aoe)}`);
    return { name: s.name, lines };
  });
}

export function grunt(n: number): UnitSpec {
  return {
    id: `grunt${n}`,
    name: `Рубака ${n}`,
    side: 'foe',
    maxHp: 36,
    atk: 5,
    range: 1,
    speed: 4,
    move: 2,
    lenses: ['plain'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1.5, source: 'рубить ближайшего' }),
    ],
  };
}

export function packLeader(): UnitSpec {
  return {
    id: 'boss',
    name: 'Вожак',
    side: 'foe',
    maxHp: 56,
    atk: 7,
    range: 1,
    speed: 5,
    move: 2,
    tags: ['leader'],
    lenses: ['plain'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 2, source: 'вожак: добивать раненых' }),
    ],
  };
}

export function archer(n: number): UnitSpec {
  return {
    id: `archer${n}`,
    name: `Лучник ${n}`,
    side: 'foe',
    maxHp: 28,
    atk: 5,
    range: 4,
    speed: 5,
    move: 1,
    lenses: ['plain'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 2, source: 'лучник: бить раненых' }),
      rule({ when: { kind: 'always' }, then: { kind: 'retreat' }, weight: 0.8, source: 'лучник: держать дистанцию' }),
    ],
  };
}

export function warChief(): UnitSpec {
  return {
    id: 'chief',
    name: 'Вождь',
    side: 'foe',
    maxHp: 68,
    atk: 7,
    range: 1,
    speed: 5,
    move: 2,
    tags: ['leader'],
    lenses: ['fanatic'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 2, source: 'вождь: добивать раненых' }),
    ],
  };
}

// ---- Поздние враги (фаза 4): играют новыми концептами того же IR ----

/** Шаман держится за спиной вожака (behindId — id юнита-щита в том же бою). */
export function shaman(behindId: string): UnitSpec {
  return {
    id: 'shaman',
    name: 'Шаман',
    side: 'foe',
    maxHp: 32,
    atk: 4,
    range: 4,
    speed: 5,
    move: 1,
    lenses: ['plain'],
    // носитель АОЕ: залп 3×3 — первая причина держать интервал; ритуал 5×5
    // с перезарядкой 3 — телеграфированный, из него выходят или прикрываются
    aoe: { blast: { range: 4, mult: 0.75 }, ritual: { range: 4, mult: 1.2, cooldown: 3 } },
    rules: [
      rule({
        when: { kind: 'always' },
        then: { kind: 'behind', ref: { type: 'ally', id: behindId } },
        weight: 1.5,
        source: 'шаман: держаться за спинами',
      }),
      rule({ when: { kind: 'always' }, then: { kind: 'barrage' }, weight: 1.5, source: 'шаман: накрыть скопление' }),
    ],
  };
}

export function berserker(n: number): UnitSpec {
  return {
    id: `berserk${n}`,
    name: `Берсерк ${n}`,
    side: 'foe',
    maxHp: 44,
    atk: 8,
    range: 1,
    speed: 6,
    move: 3,
    lenses: ['fanatic'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'trade' }, weight: 2, source: 'берсерк: размен всегда выгоден' }),
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1.5, source: 'берсерк: рвать ближайшего' }),
    ],
  };
}

export function hunter(n: number): UnitSpec {
  return {
    id: `hunter${n}`,
    name: `Охотник ${n}`,
    side: 'foe',
    maxHp: 30,
    atk: 6,
    range: 5,
    speed: 6,
    move: 2,
    lenses: ['plain'],
    rules: [
      rule({
        when: { kind: 'always' },
        then: { kind: 'attack', target: 'mostDangerous' },
        weight: 2,
        source: 'охотник: снимать самых опасных',
      }),
      rule({ when: { kind: 'always' }, then: { kind: 'avoidLineOfFire' }, weight: 1.2, source: 'охотник: не лезть под выстрел' }),
    ],
  };
}

/** Финальный босс забега. Ходит со свитой (шаман за спиной, охотник в тылу). */
export function warlord(): UnitSpec {
  return {
    id: 'warlord',
    name: 'Вождь орды',
    side: 'foe',
    // 132 (было 120): ритуал съедает треть его ходов, а фанатик жжёт и свою
    // свиту — без компенсации узел босса мягчел с 43 до ~55% (план АОЕ, шаг 8)
    maxHp: 132,
    // hp 60 / atk 9: с пулом героев и способностями (партия сильнее
    // фиксированной тройки фазы 5) наив на 52/8 добрался до ~46% —
    // босс переставал быть задачей на контр-формулировку; здесь наив ~35%
    atk: 9,
    range: 1,
    speed: 6,
    move: 2,
    tags: ['leader'],
    lenses: ['fanatic'],
    // ритуал «дыхание орды»: рейд-механика финала — замах виден за ход, из
    // зоны выходят, медленные прикрываются; перезарядка 3 задаёт ритм боя.
    // mult 2.0: телеграфированный удар обязан быть страшным — при 1.2 босс
    // менял треть своих ходов на щекотку и мягчел (замер шага 5)
    aoe: { ritual: { range: 4, mult: 2.0, cooldown: 3 } },
    rules: [
      rule({
        when: { kind: 'always' },
        then: { kind: 'attack', target: 'mostDangerous' },
        weight: 2,
        source: 'вождь орды: ломать самых опасных',
      }),
      rule({ when: { kind: 'always' }, then: { kind: 'trade' }, weight: 1.5, source: 'вождь орды: крови не жалеть' }),
      // вес 1.0 (не 1.5): при 1.5 вождь менял на замахи треть ходов и мягчел —
      // дыхание должно накрывать настоящие скопления, а не заменять топор
      rule({ when: { kind: 'always' }, then: { kind: 'barrage' }, weight: 1.0, source: 'вождь орды: дыхание орды' }),
      // упреждение: партия научилась выходить из зоны — вождь целит туда,
      // куда выходят (шаг 5 плана АОЕ, лечит «босс помягчел» из шага 3)
      rule({ when: { kind: 'always' }, then: { kind: 'preempt' }, weight: 1.0, source: 'вождь орды: бить на упреждение' }),
    ],
  };
}
