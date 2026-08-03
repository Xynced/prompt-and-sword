import { type BattleResult, type UnitSpec, runBattle } from './battle.js';
import { type PhraseDraft, compilePhrase } from './constructor.js';
import { type ConceptId, STARTING_VOCAB, UNLOCKABLE } from './vocab.js';
import { type Rule } from './ir.js';
import { HERO_STATS } from './scenarios.js';
import { archer, grunt, packLeader, warChief } from './foes.js';
import { mulberry32, shuffle } from './rng.js';
import type { CharacterId, Pos } from './types.js';

/**
 * Мини-забег фазы 2: 5 боёв, скрипторий между ними, 3 героя, пермасмерть.
 * Всё детерминировано сидом забега.
 */

export interface HeroState {
  id: string;
  name: string;
  character: CharacterId;
  stats: { maxHp: number; atk: number; range: number; speed: number; move: number; spawn: Pos };
  alive: boolean;
  slots: number;
  phrases: PhraseDraft[];
}

export type RunNode = { kind: 'fight'; index: number } | { kind: 'scriptorium' };

export interface ScriptoriumOffer {
  concepts: ConceptId[];
  /** Герой, которому можно докупить слот (если есть кому). */
  slotHero?: string;
}

export interface RunState {
  runSeed: number;
  nodeIndex: number;
  vocab: ConceptId[];
  heroes: HeroState[];
  status: 'ongoing' | 'won' | 'lost';
  log: string[];
}

/** 5 боёв, скрипторий после каждого кроме последнего. */
export const NODES: RunNode[] = [
  { kind: 'fight', index: 0 },
  { kind: 'scriptorium' },
  { kind: 'fight', index: 1 },
  { kind: 'scriptorium' },
  { kind: 'fight', index: 2 },
  { kind: 'scriptorium' },
  { kind: 'fight', index: 3 },
  { kind: 'scriptorium' },
  { kind: 'fight', index: 4 },
];

export const START_SLOTS = 2;
export const MAX_SLOTS = 4;

export function foesForFight(index: number): UnitSpec[] {
  switch (index) {
    case 0:
      return [grunt(1), grunt(2)];
    case 1:
      return [grunt(1), grunt(2), grunt(3)];
    case 2:
      return [packLeader(), grunt(1), grunt(2)];
    case 3:
      return [packLeader(), grunt(1), archer(1)];
    default:
      return [warChief(), grunt(1), grunt(2), archer(1)];
  }
}

const p = (draft: PhraseDraft): PhraseDraft => draft;

/** Стартовые принципы — осмысленный, но не оптимальный дефолт. */
function defaultPhrases(heroId: string): PhraseDraft[] {
  switch (heroId) {
    case 'grom':
      return [
        p({ condition: { id: 'always' }, preference: { id: 'act.protect', ally: 'lia' } }),
        p({ condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.nearest' } }),
      ];
    case 'dart':
      return [p({ condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.weakest' } })];
    default:
      return [
        p({
          condition: { id: 'cond.hpBelow', who: 'self', frac: 0.5 },
          preference: { id: 'act.retreat' },
        }),
        p({ condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.nearest' } }),
      ];
  }
}

export function startRun(runSeed: number): RunState {
  const heroes: HeroState[] = (
    [
      ['grom', 'Гром', 'fanatic'],
      ['dart', 'Дарт', 'literalist'],
      ['lia', 'Лия', 'coward'],
    ] as const
  ).map(([id, name, character]) => ({
    id,
    name,
    character,
    stats: { ...HERO_STATS[id], spawn: { ...HERO_STATS[id].spawn } },
    alive: true,
    slots: START_SLOTS,
    phrases: defaultPhrases(id),
  }));
  return {
    runSeed,
    nodeIndex: 0,
    vocab: STARTING_VOCAB.slice(),
    heroes,
    status: 'ongoing',
    log: [],
  };
}

export function currentNode(state: RunState): RunNode | undefined {
  return NODES[state.nodeIndex];
}

export function heroNames(state: RunState): Record<string, string> {
  return Object.fromEntries(state.heroes.map((h) => [h.id, h.name]));
}

/** Компиляция всех фраз героя; ошибки невозможны, если setPhrases валидировал. */
function compileHero(state: RunState, hero: HeroState): Rule[] {
  const names = heroNames(state);
  return hero.phrases.map((d) => {
    const r = compilePhrase(d, state.vocab, names);
    if (!r.ok) throw new Error(`Фраза героя ${hero.id} использует закрытые концепты: ${r.missing.join(', ')}`);
    return r.rule;
  });
}

export function heroSpecs(state: RunState): UnitSpec[] {
  return state.heroes
    .filter((h) => h.alive)
    .map((h) => ({
      id: h.id,
      name: h.name,
      side: 'party' as const,
      character: h.character,
      rules: compileHero(state, h),
      ...h.stats,
    }));
}

export type SetPhrasesResult = { ok: true } | { ok: false; error: string };

export function setPhrases(state: RunState, heroId: string, drafts: PhraseDraft[]): SetPhrasesResult {
  const hero = state.heroes.find((h) => h.id === heroId);
  if (!hero) return { ok: false, error: `Нет героя ${heroId}` };
  if (!hero.alive) return { ok: false, error: `${hero.name} мёртв` };
  if (drafts.length > hero.slots) {
    return { ok: false, error: `У ${hero.name} только ${hero.slots} слота(ов)` };
  }
  const names = heroNames(state);
  for (const d of drafts) {
    const r = compilePhrase(d, state.vocab, names);
    if (!r.ok) return { ok: false, error: `Закрытые концепты: ${r.missing.join(', ')}` };
  }
  hero.phrases = drafts.map((d) => ({ ...d }));
  return { ok: true };
}

export function battleSeed(state: RunState): number {
  return state.runSeed * 101 + state.nodeIndex;
}

/** Сыграть текущий боевой узел. Пермасмерть; выжившие лечатся между боями. */
export function playFight(state: RunState): BattleResult {
  const node = currentNode(state);
  if (state.status !== 'ongoing' || node?.kind !== 'fight') {
    throw new Error('Сейчас не боевой узел');
  }
  const result = runBattle(battleSeed(state), [...heroSpecs(state), ...foesForFight(node.index)]);

  for (const u of result.units) {
    if (u.side !== 'party' || u.alive) continue;
    const hero = state.heroes.find((h) => h.id === u.id)!;
    hero.alive = false;
    state.log.push(`✝ ${hero.name} погибает в бою ${node.index + 1}`);
  }

  if (result.winner !== 'party') {
    state.status = 'lost';
    state.log.push(`Забег окончен: поражение в бою ${node.index + 1}`);
  } else if (state.nodeIndex === NODES.length - 1) {
    state.status = 'won';
    state.log.push('Забег пройден!');
  } else {
    state.nodeIndex++;
    state.log.push(`Бой ${node.index + 1} выигран за ${result.rounds} раундов`);
  }
  return result;
}

/** Предложение скриптория: 2 закрытых концепта + слот (детерминировано сидом). */
export function scriptoriumOffer(state: RunState): ScriptoriumOffer {
  if (currentNode(state)?.kind !== 'scriptorium') throw new Error('Сейчас не скрипторий');
  const rng = mulberry32(state.runSeed * 997 + state.nodeIndex);
  const locked = UNLOCKABLE.filter((c) => !state.vocab.includes(c));
  const concepts = shuffle(locked, rng).slice(0, 2);
  const slotHero = state.heroes.find((h) => h.alive && h.slots < MAX_SLOTS)?.id;
  return { concepts, ...(slotHero ? { slotHero } : {}) };
}

export type ScriptoriumChoice =
  | { kind: 'concept'; id: ConceptId }
  | { kind: 'slot'; heroId: string }
  | { kind: 'skip' };

export function chooseInScriptorium(state: RunState, choice: ScriptoriumChoice): SetPhrasesResult {
  const offer = scriptoriumOffer(state);
  if (choice.kind === 'skip') {
    state.log.push('Скрипторий пропущен');
  } else if (choice.kind === 'concept') {
    if (!offer.concepts.includes(choice.id)) return { ok: false, error: 'Такого предложения нет' };
    state.vocab.push(choice.id);
    state.log.push(`Открыт концепт: ${choice.id}`);
  } else {
    if (offer.slotHero !== choice.heroId) return { ok: false, error: 'Слот этому герою не предлагался' };
    const hero = state.heroes.find((h) => h.id === choice.heroId)!;
    hero.slots++;
    state.log.push(`${hero.name}: +1 слот принципа (${hero.slots})`);
  }
  state.nodeIndex++;
  return { ok: true };
}
