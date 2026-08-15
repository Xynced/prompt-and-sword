import type { BattleResult } from './battle.js';
import type { PhraseDraft } from './constructor.js';
import { type ConceptId, CONCEPTS } from './vocab.js';
import { LENS_RU } from './lens.js';
import { PARTY_SPAWNS, defaultPhrasesFor, heroArchetype } from './heroes.js';
import { type MapNode, type RunState, MAX_SLOTS, playFight, setPhrases } from './run.js';
import { scenarioForNode } from './objectives.js';
import type { LensId } from './types.js';

/**
 * Debug-режим: собрать конкретный бой руками — сценарий × состав партии ×
 * характеры — и сыграть его либо в UI, либо headless (тесты, CLI).
 *
 * Устройство: debug не заводит второй путь к бою. Он собирает обычный
 * `RunState` из одного узла нужного вида — а дальше работает та же машинерия
 * забега (`foesForNode`, `arenaForNode`, `scenarioForNode`, `playFight`).
 * Поэтому отладочный бой побайтово тот же, что тот же бой в забеге: сравнивать
 * тест с игрой имеет смысл.
 */

/** Бой каталога: имя + координаты узла, из которых забег выводит состав, арену и задачу. */
export interface DebugBattle {
  id: string;
  /** Русское имя для селекта. */
  label: string;
  /** Чем этот бой отличается — паттерн состава или задача сценария. */
  note: string;
  node: Pick<MapNode, 'kind' | 'layer' | 'slot'>;
}

/**
 * Все бои, которые порождает забег: слой/слот выбраны так, чтобы покрыть каждый
 * состав `foesForNode` и каждый сценарий `scenarioForNode` по разу.
 */
export const DEBUG_BATTLES: readonly DebugBattle[] = [
  { id: 'lesson', label: 'Урок', note: 'вожак со свитой; поражение переигрывается', node: { kind: 'lesson', layer: 0, slot: 0 } },
  { id: 'swarm', label: 'Масса', note: '9 крыс: тел больше, чем ходов', node: { kind: 'fight', layer: 1, slot: 0 } },
  { id: 'behead', label: 'Обезглавить', note: 'сценарий: победа в момент смерти Вожака', node: { kind: 'fight', layer: 1, slot: 1 } },
  { id: 'camp', label: 'Разбитый лагерь', note: 'сценарий: герои раскиданы, стая между ними', node: { kind: 'fight', layer: 3, slot: 0 } },
  { id: 'slingers', label: 'Задира и застрельщики', note: 'крикун уводит удары от строя пращников', node: { kind: 'fight', layer: 3, slot: 1 } },
  { id: 'healer', label: 'Ближники и лекарь', note: 'добивание вязнет в костоправе', node: { kind: 'fight', layer: 5, slot: 0 } },
  { id: 'waves', label: 'Загонная охота', note: 'сценарий: волна подкрепления на 5-м раунде', node: { kind: 'fight', layer: 5, slot: 1 } },
  { id: 'elite-smart', label: 'Умная элита', note: 'солдаты и сержант: порядок целей решает', node: { kind: 'elite', layer: 3, slot: 0 } },
  { id: 'duel', label: 'Дуэль', note: 'дуэлянт: вызов принимают всем строем', node: { kind: 'elite', layer: 3, slot: 1 } },
  { id: 'ritual', label: 'Сорвать ритуал', note: 'сценарий: дедлайн вместо ничьей на измор', node: { kind: 'elite', layer: 5, slot: 0 } },
  { id: 'troll', label: 'Таймер-тролль', note: 'зарастает быстрее вялого урона', node: { kind: 'elite', layer: 5, slot: 1 } },
  { id: 'boss', label: 'Босс', note: 'вождь орды, шаман и охотник', node: { kind: 'boss', layer: 7, slot: 0 } },
  // волна 2 плана objectives — виртуальные узлы (слои 2/4 боёв не порождают):
  // сценарии живут здесь и в тестах, раскладка по забегу — следующий шаг плана
  { id: 'redoubt', label: 'Оборона рубежа', note: 'сценарий: волны рвутся в зону у своего края', node: { kind: 'fight', layer: 2, slot: 0 } },
  { id: 'convoy', label: 'Защита обоза', note: 'сценарий: волки рвут неподвижный обоз', node: { kind: 'fight', layer: 2, slot: 1 } },
  { id: 'vigil', label: 'Свой ритуал', note: 'сценарий: чтец занят — сберечь до конца чтения', node: { kind: 'fight', layer: 2, slot: 2 } },
  { id: 'dawn', label: 'До рассвета', note: 'сценарий: выстоять против волн до таймера', node: { kind: 'fight', layer: 2, slot: 3 } },
  { id: 'sabotage', label: 'Диверсия', note: 'сценарий: разбить тотем за строем охраны', node: { kind: 'fight', layer: 2, slot: 4 } },
  { id: 'breakout', label: 'Прорыв', note: 'сценарий: увести двоих за дальний край сквозь заслон', node: { kind: 'fight', layer: 4, slot: 0 } },
  { id: 'rearguard', label: 'Отход с боем', note: 'сценарий: из полукольца к своему краю', node: { kind: 'fight', layer: 4, slot: 1 } },
  { id: 'escort', label: 'Эскорт', note: 'сценарий: старейшина сам бредёт к перевалу', node: { kind: 'fight', layer: 4, slot: 2 } },
  { id: 'relic', label: 'Трофей', note: 'сценарий: поднять реликвию и унести за свой край', node: { kind: 'fight', layer: 4, slot: 3 } },
  { id: 'chase', label: 'Погоня', note: 'сценарий: перехватить гонца до кромки поля', node: { kind: 'fight', layer: 4, slot: 4 } },
];

/** Герой отладочной партии: архетип, характер и (необязательно) свои приказы. */
export interface DebugHero {
  /** id из HERO_POOL. */
  archetypeId: string;
  /** Любые линзы в любом числе; пусто — без характера. */
  lenses: LensId[];
  /** Приказы; по умолчанию наивный дефолт архетипа. */
  phrases?: PhraseDraft[];
}

export interface DebugSetup {
  /** id из DEBUG_BATTLES. */
  battle: string;
  /** 1–3 героя без повторов; слот определяет точку спавна. */
  party: DebugHero[];
  /** Сид забега (сид боя = seed × 101); по умолчанию 1. */
  seed?: number;
  /** Словарь; по умолчанию открыт весь — в отладке слова не зарабатывают. */
  vocab?: ConceptId[];
  /** Метка фокус-огня: id врага. */
  marked?: string | null;
  /** Нерв (план nerve): амплитуда разброса весов решения; 0/отсутствие — выключен. */
  nerve?: number;
}

export const MAX_DEBUG_PARTY = PARTY_SPAWNS.length;

export function debugBattleById(id: string): DebugBattle {
  const b = DEBUG_BATTLES.find((x) => x.id === id);
  if (!b) throw new Error(`Неизвестный бой отладки: ${id}`);
  return b;
}

/** Задача боя словами игрока, если у узла есть сценарий. */
export function debugBrief(id: string): string | null {
  const node = debugBattleById(id).node;
  return scenarioForNode(node)?.brief ?? null;
}

/**
 * Собрать забег из одного узла под выбранный бой. Дальше это обычный RunState:
 * UI играет его как узел карты, тесты и CLI гоняют через playFight.
 */
export function debugRun(setup: DebugSetup): RunState {
  const battle = debugBattleById(setup.battle);
  if (setup.party.length < 1 || setup.party.length > MAX_DEBUG_PARTY) {
    throw new Error(`В партии от 1 до ${MAX_DEBUG_PARTY} героев, задано ${setup.party.length}`);
  }
  const ids = setup.party.map((h) => h.archetypeId);
  if (new Set(ids).size !== ids.length) throw new Error('Герой не может стоять в двух слотах');
  for (const h of setup.party) {
    for (const l of h.lenses) {
      if (!(l in LENS_RU)) throw new Error(`Неизвестная линза: ${l}`);
    }
  }
  const archetypes = ids.map(heroArchetype);
  const node: MapNode = { id: 0, ...battle.node, next: [] };
  const state: RunState = {
    runSeed: setup.seed ?? 1,
    map: [node],
    at: 0,
    resolved: false,
    vocab: setup.vocab ? [...setup.vocab] : (Object.keys(CONCEPTS) as ConceptId[]),
    heroes: archetypes.map((arch, slot) => ({
      id: arch.id,
      archetypeId: arch.id,
      name: arch.name,
      lenses: [...setup.party[slot]!.lenses],
      stats: { ...arch.stats, spawn: { ...PARTY_SPAWNS[slot]! } },
      alive: true,
      hp: arch.stats.maxHp,
      // слотов сразу максимум: отладка не отыгрывает прогрессию, как и со словарём
      slots: MAX_SLOTS,
      phrases: [],
    })),
    marked: setup.marked ?? null,
    ...(setup.nerve ? { nerve: setup.nerve } : {}),
    deploy: {},
    pendingReward: null,
    status: 'ongoing',
    log: [],
  };
  setup.party.forEach((h, slot) => {
    const arch = archetypes[slot]!;
    const r = setPhrases(state, arch.id, h.phrases ?? defaultPhrasesFor(arch, archetypes));
    if (!r.ok) throw new Error(`Приказы ${arch.name}: ${r.error}`);
  });
  return state;
}

/** Сыграть собранный бой headless — та же точка входа, что у забега. */
export function debugBattle(setup: DebugSetup): BattleResult {
  return playFight(debugRun(setup));
}
