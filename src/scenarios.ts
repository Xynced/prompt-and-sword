import type { Rule } from './ir.js';
import type { UnitSpec } from './battle.js';
import { grunt, packLeader } from './foes.js';

/**
 * Сценарий Ворот A: одни и те же 3 героя и 4 врага, 5 наборов принципов партии.
 * Герои: Гром (воин-фанатик), Дарт (стрелок-буквалист), Лия (маг-трус).
 */

const rule = (r: Omit<Rule, 'scope'>): Rule => ({ ...r, scope: 'self' });

function hero(
  id: string,
  name: string,
  lenses: UnitSpec['lenses'],
  stats: Pick<UnitSpec, 'maxHp' | 'atk' | 'range' | 'speed' | 'move' | 'spawn'>,
  rules: Rule[],
): UnitSpec {
  return { id, name, side: 'party', lenses, rules, ...stats };
}

export const HERO_STATS = {
  grom: { maxHp: 80, atk: 8, range: 1, speed: 5, move: 2, spawn: { x: 2, y: 8 } },
  dart: { maxHp: 48, atk: 6, range: 5, speed: 6, move: 2, spawn: { x: 1, y: 4 } },
  lia: { maxHp: 40, atk: 8, range: 4, speed: 4, move: 1, spawn: { x: 1, y: 13 } },
} as const;

const GROM = HERO_STATS.grom;
const DART = HERO_STATS.dart;
const LIA = HERO_STATS.lia;

export function makeFoes(): UnitSpec[] {
  return [packLeader(), grunt(1), grunt(2), grunt(3)];
}

export interface IrSet {
  name: string;
  desc: string;
  party: UnitSpec[];
}

export function makeIrSets(): IrSet[] {
  return [
    {
      name: 'rush',
      desc: 'Раш: все атакуют ближайшего, бьют отчаянно',
      party: [
        hero('grom', 'Гром', ['fanatic'], GROM, [
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 2, source: 'бей ближайшего' }),
          rule({ when: { kind: 'always' }, then: { kind: 'strikeDesperate' }, weight: 1.5, source: 'бей отчаянно' }),
        ]),
        hero('dart', 'Дарт', ['literalist'], DART, [
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 2, source: 'бей ближайшего' }),
          rule({ when: { kind: 'always' }, then: { kind: 'strikeDesperate' }, weight: 1.5, source: 'бей отчаянно' }),
        ]),
        hero('lia', 'Лия', ['coward'], LIA, [
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 2, source: 'бей ближайшего' }),
          rule({ when: { kind: 'always' }, then: { kind: 'strikeDesperate' }, weight: 1.5, source: 'бей отчаянно' }),
        ]),
      ],
    },
    {
      name: 'focus-leader',
      desc: 'Фокус: все валят вожака',
      party: [
        hero('grom', 'Гром', ['fanatic'], GROM, [
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'leader' }, weight: 2, source: 'фокусь вожака' }),
        ]),
        hero('dart', 'Дарт', ['literalist'], DART, [
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'leader' }, weight: 2, source: 'фокусь вожака' }),
        ]),
        hero('lia', 'Лия', ['coward'], LIA, [
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'leader' }, weight: 2, source: 'фокусь вожака' }),
        ]),
      ],
    },
    {
      name: 'turtle',
      desc: 'Черепаха: держать позиции, бить наверняка кто подойдёт',
      party: [
        hero('grom', 'Гром', ['fanatic'], GROM, [
          rule({ when: { kind: 'always' }, then: { kind: 'holdPosition' }, weight: 2, source: 'держи позицию' }),
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1, source: 'бей кто подойдёт' }),
          rule({ when: { kind: 'always' }, then: { kind: 'strikeHard' }, weight: 1.5, source: 'бей наверняка' }),
        ]),
        hero('dart', 'Дарт', ['literalist'], DART, [
          rule({ when: { kind: 'always' }, then: { kind: 'holdPosition' }, weight: 2, source: 'держи позицию' }),
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1, source: 'бей кто подойдёт' }),
          rule({ when: { kind: 'always' }, then: { kind: 'strikeHard' }, weight: 1.5, source: 'бей наверняка' }),
        ]),
        hero('lia', 'Лия', ['coward'], LIA, [
          rule({ when: { kind: 'always' }, then: { kind: 'holdPosition' }, weight: 2, source: 'держи позицию' }),
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1, source: 'бей кто подойдёт' }),
          rule({ when: { kind: 'always' }, then: { kind: 'strikeHard' }, weight: 1.5, source: 'бей наверняка' }),
        ]),
      ],
    },
    {
      name: 'guard-mage',
      desc: 'Защита мага: Гром прикрывает Лию, Дарт снимает раненых',
      party: [
        hero('grom', 'Гром', ['fanatic'], GROM, [
          rule({ when: { kind: 'always' }, then: { kind: 'protect', ally: 'lia' }, weight: 2, source: 'прикрывай Лию' }),
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1, source: 'отгоняй ближайшего' }),
        ]),
        hero('dart', 'Дарт', ['literalist'], DART, [
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 2, source: 'снимай раненых' }),
        ]),
        hero('lia', 'Лия', ['coward'], LIA, [
          rule({ when: { kind: 'hpBelow', who: 'self', frac: 0.5 }, then: { kind: 'retreat' }, weight: 2, source: 'ранена — отходи' }),
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 1.5, source: 'жги ближайшего' }),
        ]),
      ],
    },
    {
      name: 'kite',
      desc: 'Кайт: стрелки держат дистанцию, Гром — заслон у строя',
      party: [
        hero('grom', 'Гром', ['fanatic'], GROM, [
          rule({ when: { kind: 'always' }, then: { kind: 'holdPosition' }, weight: 1.5, source: 'держи строй' }),
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 2, source: 'бей кто подойдёт' }),
        ]),
        hero('dart', 'Дарт', ['literalist'], DART, [
          rule({ when: { kind: 'always' }, then: { kind: 'standoff' }, weight: 1.5, source: 'держи дистанцию' }),
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 2, source: 'стреляй в ближайшего' }),
        ]),
        hero('lia', 'Лия', ['coward'], LIA, [
          rule({ when: { kind: 'always' }, then: { kind: 'standoff' }, weight: 1.5, source: 'держи дистанцию' }),
          rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 2, source: 'жги, кто ближе' }),
        ]),
      ],
    },
  ];
}

/** Набор для теста дивергенции: rush, но Гром переключён на вожака (ровно одно правило). */
export function makeRushVariant(): IrSet {
  const v = makeIrSets()[0]!;
  const grom = v.party[0]!;
  grom.rules = grom.rules.map((r) =>
    r.then.kind === 'attack'
      ? rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'leader' }, weight: 2, source: 'бей вожака' })
      : r,
  );
  return { ...v, name: 'rush-variant', desc: 'Раш, но Гром фокусит вожака' };
}
