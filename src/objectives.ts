import type { BattleSetup, UnitSpec } from './battle.js';
import { archer, berserker, grunt, ogre, packLeader, ritualist, slinger, thug, wolf } from './foes.js';
import type { MapNode } from './run.js';
import type { Pos } from './types.js';

/**
 * План objectives: задачи боя — не только «перебей всех». Сценарий узла =
 * задача боя (Objective/волны battle.ts) + при нужде свой состав врагов и
 * фикс-спавны героев. Раскладка статичная (слой/слот — прецедент foes);
 * задача на узле видна всегда — честная часть разведки, скрыт только состав.
 */
export interface NodeScenario {
  id: 'behead' | 'camp' | 'ritual' | 'waves';
  /** Заголовок панели задачи. */
  title: string;
  /** Условие победы/поражения словами игрока — для панели узла и боя. */
  brief: string;
  setup: BattleSetup;
  /** Фикс-спавны героев по слотам партии — расстановка узла не в руках игрока. */
  heroSpawns?: Pos[];
  /** Состав врагов сценария (замена состава foesForNode). */
  foes?: () => UnitSpec[];
}

/** Раунд, к началу которого ритуалист дочитает (сценарий «сорвать ритуал»). */
export const RITUAL_DEADLINE = 9;
/** Раунд выхода второй волны загонной охоты. */
export const AMBUSH_WAVE_ROUND = 5;

/**
 * №9 Обезглавить (слой 1): свита толще обычного узла — перебить всех дороже,
 * чем срубить вожака; победа в момент его смерти.
 */
const behead = (): NodeScenario => ({
  id: 'behead',
  title: 'Обезглавить',
  brief: 'Срази Вожака — победа в момент его смерти; свиту можно не трогать.',
  setup: { objective: { kind: 'killTarget', targetId: 'boss' } },
  foes: () => [packLeader(), berserker(1), grunt(1), archer(1)],
});

/** №8 Разбитый лагерь (слой 3): героев раскидало по полю, стая — между ними. */
const camp = (): NodeScenario => ({
  id: 'camp',
  title: 'Разбитый лагерь',
  brief: 'Ночная тревога: герои раскиданы по полю, расстановка не в ваших руках. Перебей стаю.',
  setup: {},
  heroSpawns: [
    { x: 2, y: 2 },
    { x: 2, y: 15 },
    { x: 8, y: 8 },
  ],
});

/** №17 Сорвать ритуал (элитка слоя 5): дедлайн вместо ничьей на измор. */
const disruptRitual = (): NodeScenario => ({
  id: 'ritual',
  title: 'Сорвать ритуал',
  brief: `Ритуалист дочитает погибель к раунду ${RITUAL_DEADLINE}, если доживёт. Срази его раньше; огра можно не трогать.`,
  setup: { objective: { kind: 'killBefore', targetId: 'ritualist', round: RITUAL_DEADLINE } },
  foes: () => [ogre(), ritualist('ogre'), slinger(1)],
});

/**
 * №19 Волны (слой 5): засада растянута во времени — волки только загоняют,
 * убойная волна подходит следом. Замер: наив побеждает, но хоронит мага в
 * каждом бою (охота на слабых добивает раненую к приходу волны); связка
 * защиты «прикрывай N» + «держись за спиной» опускает смерти к нулю —
 * задача бьёт пермасмертью, не винрейтом. Тыловой спавн волны отброшен:
 * двоих загонщиков со спины не контрит ни одна формулировка (перехват
 * ловит один удар за раунд).
 */
const huntWaves = (): NodeScenario => ({
  id: 'waves',
  title: 'Загонная охота',
  brief: `Волки — только загонщики: на раунде ${AMBUSH_WAVE_ROUND} подойдут Душегуб с волком и добьют раненых. Перебей всех — и реши, за чьей спиной пережить их приход.`,
  setup: {
    waves: [
      {
        round: AMBUSH_WAVE_ROUND,
        specs: [
          { ...thug(), spawn: { x: 17, y: 8 } },
          { ...wolf(3), spawn: { x: 17, y: 11 } },
        ],
      },
    ],
  },
  foes: () => [wolf(1), wolf(2)],
});

/**
 * Сценарий узла карты (волна 1): слой/слот выбраны по местам, чьи прежние
 * составы сценарий и переосмысляет (вожак со свитой, волки, танк+кастеры,
 * засада). Узлы без сценария играют «перебей всех» как раньше.
 */
export function scenarioForNode(node: Pick<MapNode, 'kind' | 'layer' | 'slot'>): NodeScenario | null {
  if (node.kind === 'fight' && node.layer === 1 && node.slot === 1) return behead();
  if (node.kind === 'fight' && node.layer === 3 && node.slot === 0) return camp();
  if (node.kind === 'elite' && node.layer === 5 && node.slot === 0) return disruptRitual();
  if (node.kind === 'fight' && node.layer === 5 && node.slot === 1) return huntWaves();
  return null;
}
