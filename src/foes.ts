import type { Rule } from './ir.js';
import type { UnitSpec } from './battle.js';

/** Фабрики врагов. Новый враг = новый набор правил, не новый арт. */

const rule = (r: Omit<Rule, 'scope'>): Rule => ({ ...r, scope: 'self' });

export function grunt(n: number): UnitSpec {
  return {
    id: `grunt${n}`,
    name: `Рубака ${n}`,
    side: 'foe',
    maxHp: 18,
    atk: 5,
    range: 1,
    speed: 4,
    move: 3,
    character: 'plain',
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
    maxHp: 28,
    atk: 7,
    range: 1,
    speed: 5,
    move: 3,
    tags: ['leader'],
    character: 'plain',
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
    maxHp: 14,
    atk: 5,
    range: 4,
    speed: 5,
    move: 2,
    character: 'plain',
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
    maxHp: 34,
    atk: 7,
    range: 1,
    speed: 5,
    move: 3,
    tags: ['leader'],
    character: 'fanatic',
    rules: [
      rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 2, source: 'вождь: добивать раненых' }),
    ],
  };
}
