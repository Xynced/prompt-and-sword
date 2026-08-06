import type { Rule } from './ir.js';
import type { Pos } from './types.js';
import type { UnitSpec } from './battle.js';
import { describeActive, describeAoe, describePassives, describeWeapons } from './cards.js';
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
    if (s.weapons?.length) lines.push(`оружие: ${describeWeapons(s.weapons)}`);
    else if (s.aoe) lines.push(`оружие: ${describeAoe(s.aoe)}`);
    if (s.active) lines.push(`актив: ${describeActive(s.active)}`);
    if (s.passives) lines.push(`пассив: ${describePassives(s.passives)}`);
    return { name: s.name, lines };
  });
}

export function grunt(n: number): UnitSpec {
  return {
    id: `grunt${n}`,
    name: `Рубака ${n}`,
    side: 'foe',
    maxHp: 36,
    weapons: [{ name: 'ржавый тесак', dmg: 5, range: 1 }],
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
    weapons: [{ name: 'зазубренный топор', dmg: 7, range: 1 }],
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
    weapons: [{ name: 'короткий лук', dmg: 5, range: 4 }],
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
    weapons: [{ name: 'топор вождя', dmg: 7, range: 1 }],
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
    // носитель АОЕ: залп 3×3 — первая причина держать интервал; ритуал 5×5
    // с перезарядкой 3 — телеграфированный, из него выходят или прикрываются
    weapons: [{
      name: 'посох духов',
      dmg: 4,
      range: 4,
      aoe: { blast: { range: 4, mult: 0.75 }, ritual: { range: 4, mult: 1.2, cooldown: 3 } },
    }],
    speed: 5,
    move: 1,
    lenses: ['plain'],
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
    weapons: [{ name: 'шипастый цеп', dmg: 8, range: 1 }],
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
    weapons: [{ name: 'костяной лук', dmg: 6, range: 5 }],
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

// ---- План врагов: паттерны боёв (по мотивам pf2e) ----

/**
 * Масса: крыса-переросток (Giant Rat) — дешёвое тело стаи. Умирает от
 * полного удара с добором, но тел больше, чем у партии ходов; спавнятся
 * кучей у восточного края (явные точки — стая приходит толпой).
 */
const RAT_SPAWNS: readonly Pos[] = [
  { x: 15, y: 7 },
  { x: 16, y: 8 },
  { x: 15, y: 9 },
  { x: 16, y: 10 },
  { x: 15, y: 11 },
  { x: 16, y: 6 },
  { x: 16, y: 12 },
  { x: 17, y: 7 },
  { x: 17, y: 9 },
  { x: 17, y: 11 },
];

export function rat(n: number): UnitSpec {
  return {
    id: `rat${n}`,
    name: `Крыса ${n}`,
    side: 'foe',
    maxHp: 10,
    weapons: [{ name: 'зубы', dmg: 4, range: 1 }],
    speed: 7,
    move: 3,
    // фанатик: голодная стая не знает страха — без линзы хилое тело под
    // обстрелом уходит в глухую оборону, и масса черепашится вместо накатывания
    lenses: ['fanatic'],
    spawn: { ...RAT_SPAWNS[(n - 1) % RAT_SPAWNS.length]! },
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1.5, source: 'крыса: вцепиться в ближайшего' }),
    ],
  };
}

/**
 * Застрельщики: кобольд-пращник (Kobold Warrior) — держит дистанцию, бьёт
 * камнем раненых; нож — на случай, когда прижали (кандидаты по каждому
 * оружию выбирают сами). Кайт игрока против него превращается в
 * перестрелку, контр — накатить и додавить. Линза труса срезана по замеру:
 * бегун при hp<30% наматывал круги по периметру и 3–8% боёв уходили в
 * ничью 30 раундов — а ничья в забеге равна поражению (рычаг из решения
 * пользователя: снять линзу; вернуть труса сможет механика «сбежал с поля»).
 */
export function slinger(n: number): UnitSpec {
  return {
    id: `slinger${n}`,
    name: `Пращник ${n}`,
    side: 'foe',
    maxHp: 16,
    weapons: [
      { name: 'праща', dmg: 5, range: 4 },
      { name: 'кривой нож', dmg: 3, range: 1 },
    ],
    speed: 6,
    move: 2,
    lenses: ['plain'],
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'standoff' }, weight: 1.2, source: 'пращник: держать дистанцию' }),
      rule({ when: { kind: 'always' }, then: { kind: 'behindCover' }, weight: 1.0, source: 'пращник: стрелять из-за камней' }),
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 1.5, source: 'пращник: камнем по раненым' }),
    ],
  };
}

/**
 * Стая: волк (Wolf) — травля флангами: укус со стороны больнее (sneak,
 * канал Тессы), Knockdown из pf2e читается толчком «сбить с ног».
 */
const WOLF_SPAWNS: readonly Pos[] = [
  { x: 15, y: 6 },
  { x: 15, y: 9 },
  { x: 15, y: 12 },
  { x: 16, y: 8 },
];

export function wolf(n: number): UnitSpec {
  return {
    id: `wolf${n}`,
    name: `Волк ${n}`,
    side: 'foe',
    maxHp: 32,
    weapons: [{ name: 'клыки', dmg: 5, range: 1 }],
    speed: 7,
    move: 3,
    lenses: ['plain'],
    passives: { sneak: { flankMult: 2.0 } },
    spawn: { ...WOLF_SPAWNS[(n - 1) % WOLF_SPAWNS.length]! },
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'flank' }, weight: 1.3, source: 'волк: обойти со стороны' }),
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 1.8, source: 'волк: резать слабых' }),
      rule({ when: { kind: 'always' }, then: { kind: 'shove' }, weight: 0.8, source: 'волк: сбить с ног' }),
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
    // dmg 9: с пулом героев и способностями (партия сильнее фиксированной
    // тройки фазы 5) наив на 52/8 добрался до ~46% — босс переставал быть
    // задачей на контр-формулировку; здесь наив ~35%.
    // Ритуал «дыхание орды»: рейд-механика финала — замах виден за ход, из
    // зоны выходят, медленные прикрываются; перезарядка 3 задаёт ритм боя.
    // mult 2.0: телеграфированный удар обязан быть страшным — при 1.2 босс
    // менял треть своих ходов на щекотку и мягчел (замер шага 5 плана АОЕ)
    weapons: [{
      name: 'обсидиановый топор',
      dmg: 9,
      range: 1,
      aoe: { ritual: { range: 4, mult: 2.0, cooldown: 3 } },
    }],
    speed: 6,
    move: 2,
    tags: ['leader'],
    lenses: ['fanatic'],
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
