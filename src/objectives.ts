import type { BattleSetup, UnitSpec } from './battle.js';
import { archer, berserker, grunt, hunter, ogre, packLeader, rat, ritualist, slinger, soldier, thug, wolf } from './foes.js';
import type { Rule } from './ir.js';
import type { MapNode } from './run.js';
import type { Pos } from './types.js';

/**
 * План objectives: задачи боя — не только «перебей всех». Сценарий узла =
 * задача боя (Objective/волны/зона/трофей battle.ts) + при нужде свой состав
 * врагов, NPC на стороне партии и фикс-спавны героев. Раскладка статичная
 * (слой/слот — прецедент foes); задача на узле видна всегда — честная часть
 * разведки, скрыт только состав.
 */
export interface NodeScenario {
  id:
    | 'behead'
    | 'camp'
    | 'ritual'
    | 'waves'
    | 'redoubt'
    | 'convoy'
    | 'vigil'
    | 'dawn'
    | 'sabotage'
    | 'breakout'
    | 'rearguard'
    | 'escort'
    | 'relic'
    | 'chase';
  /** Заголовок панели задачи. */
  title: string;
  /** Условие победы/поражения словами игрока — для панели узла и боя. */
  brief: string;
  setup: BattleSetup;
  /** Фикс-спавны героев по слотам партии — расстановка узла не в руках игрока. */
  heroSpawns?: Pos[];
  /** Состав врагов сценария (замена состава foesForNode). */
  foes?: () => UnitSpec[];
  /** NPC и объекты на стороне партии: обоз, чтец, старейшина. */
  allies?: () => UnitSpec[];
}

const rule = (r: Omit<Rule, 'scope'>): Rule => ({ ...r, scope: 'self' });

/** Правило врагам сценария: рваться в зону задачи (тот же holdLine, что у слова игрока). */
const invade = (source: string): Rule =>
  rule({ when: { kind: 'always' }, then: { kind: 'holdLine' }, weight: 1.4, source });

/** Правило врагам сценария: бить подопечного задачи (внутренний селектор ward). */
const huntWard = (source: string): Rule =>
  rule({ when: { kind: 'always' }, then: { kind: 'attack', target: 'ward' }, weight: 2, source });

/** Добавить врагу правила сценария поверх его собственных (сценарные — первыми). */
const drilled = (spec: UnitSpec, ...extra: Rule[]): UnitSpec => ({
  ...spec,
  rules: [...extra, ...spec.rules],
});

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

// ---- Волна 2: зоны, подопечные, трофей ----

/** Раунды удержания рубежа. */
export const REDOUBT_ROUNDS = 8;
/** Раунды чтения своего ритуала. */
export const VIGIL_ROUNDS = 8;
/** Раунд рассвета — конец бесконечных волн. */
export const DAWN_ROUNDS = 10;

/** Зона у своего края (рубеж, выход отхода). */
const HOME_EDGE = { x1: 0, y1: 0, x2: 1, y2: 17 };
/** Зона у вражеского края (прорыв, перевал эскорта, край гонца). */
const FAR_EDGE = { x1: 16, y1: 0, x2: 17, y2: 17 };

/**
 * №1 Оборона рубежа: волны рвутся в зону у своего края — враг, оставшийся в
 * ней в конце раунда без единого нашего, закрепился. Замер (20 сидов): наив,
 * ушедший навстречу, пропускает бегуна за спину — 11/20; «держать рубеж» —
 * 20/20 (враги сами приходят под мечи на зоне).
 */
const redoubt = (): NodeScenario => ({
  id: 'redoubt',
  title: 'Оборона рубежа',
  brief: `Удержи рубеж у своего края ${REDOUBT_ROUNDS} раундов: враг, оставшийся на нём в конце раунда без единого из вас, закрепится — и это поражение. Перебить всех тоже победа.`,
  setup: {
    objective: { kind: 'holdZone', rounds: REDOUBT_ROUNDS },
    zone: { x1: 0, y1: 6, x2: 2, y2: 11 },
    waves: [
      { round: 3, specs: [drilled(wolf(3), invade('волк: прорваться к обозам')), drilled(wolf(4), invade('волк: прорваться к обозам'))] },
      { round: 6, specs: [drilled(thug(), invade('душегуб: вырезать тылы'))] },
    ],
  },
  foes: () => [
    drilled(grunt(1), invade('рубака: прорваться к обозам')),
    drilled(grunt(2), invade('рубака: прорваться к обозам')),
    drilled(wolf(1), invade('волк: прорваться к обозам')),
  ],
});

/**
 * №2 Защита обоза: неподвижный объект с hp посреди поля (отбился от колонны);
 * волки идут рвать именно его, пращник стреляет по защитникам. Замер
 * (20 сидов): наив 1/20 — волки обгоняют героев и рвут обоз, «прикрывать
 * подопечного» у двоих — 20/20.
 */
const convoy = (): NodeScenario => ({
  id: 'convoy',
  title: 'Защита обоза',
  brief: 'Обоз отбился от колонны и застрял посреди поля; волки идут рвать именно его. Перебей всех, пока обоз цел, — его гибель кончает бой поражением.',
  setup: { objective: { kind: 'protect', wardId: 'cart' } },
  allies: () => [
    {
      id: 'cart',
      name: 'Обоз',
      side: 'party',
      maxHp: 60,
      atk: 0,
      range: 1,
      speed: 0,
      move: 0,
      lenses: ['plain'],
      rules: [],
      inert: true,
      spawn: { x: 7, y: 8 },
    },
  ],
  foes: () => [
    drilled(wolf(1), huntWard('волк: рвать обоз')),
    drilled(wolf(2), huntWard('волк: рвать обоз')),
    drilled(wolf(3), huntWard('волк: рвать обоз')),
    slinger(1),
  ],
});

/**
 * №3 Свой ритуал: чтец занят чтением и выключен из боя — доживёт до раунда
 * VIGIL_ROUNDS, и обряд свершён. Победа по таймеру, смерть чтеца — поражение.
 * Замер (20 сидов): наив 0/20 — охота прорывается к чтецу за спинами
 * дерущихся; «прикрывать подопечного» у двоих — 20/20.
 */
const vigil = (): NodeScenario => ({
  id: 'vigil',
  title: 'Свой ритуал',
  brief: `Чтец читает обряд и в бою не участвует. Доживёт до конца раунда ${VIGIL_ROUNDS} — победа; его смерть — поражение. Врагов можно не бить вовсе.`,
  setup: {
    objective: { kind: 'protect', wardId: 'chanter', rounds: VIGIL_ROUNDS },
    waves: [{ round: 4, specs: [drilled(wolf(3), huntWard('волк: загрызть чтеца'))] }],
  },
  allies: () => [
    {
      id: 'chanter',
      name: 'Чтец',
      side: 'party',
      maxHp: 30,
      atk: 0,
      range: 1,
      speed: 0,
      move: 0,
      lenses: ['plain'],
      rules: [],
      inert: true,
      spawn: { x: 1, y: 8 },
    },
  ],
  foes: () => [
    drilled(grunt(1), huntWard('рубака: зарубить чтеца')),
    drilled(wolf(1), huntWard('волк: загрызть чтеца')),
    drilled(wolf(2), huntWard('волк: загрызть чтеца')),
  ],
});

/**
 * №4 Выстоять до рассвета: победа по таймеру против волн — убийства не цель,
 * экономика hp и позиции решают. Композиция survive + волны, 0 новой
 * машинерии. Замер (20 сидов): наив тонет в волнах — 7/20 при 2.6 смертях;
 * «сомкнуть строй» + «окружили → глухая оборона» — 20/20 при 0.9.
 */
const dawn = (): NodeScenario => ({
  id: 'dawn',
  title: 'До рассвета',
  brief: `Волны идут одна за другой до рассвета — конца раунда ${DAWN_ROUNDS}. Дожить всем составом и есть победа; перебить всех не выйдет, беречь силы важнее.`,
  setup: {
    objective: { kind: 'survive', rounds: DAWN_ROUNDS },
    waves: [
      { round: 3, specs: [rat(1), rat(2), rat(3)] },
      { round: 6, specs: [wolf(3), wolf(4)] },
      { round: 9, specs: [thug()] },
    ],
  },
  foes: () => [grunt(1), grunt(2), wolf(1), wolf(2)],
});

/**
 * №13 Диверсия: вражий тотем — неподвижный объект с hp за строем охраны.
 * Победа в момент его разрушения; охрану можно не трогать. Замер (20 сидов):
 * наив выигрывает резнёй за ~16 раундов; фокус на тотем (метка + «бить
 * помеченного») — вдвое быстрее (~8), прецедент «обезглавить»: наив платит
 * временем и ранами, не винрейтом.
 */
const sabotage = (): NodeScenario => ({
  id: 'sabotage',
  title: 'Диверсия',
  brief: 'Разбей Тотем войны у вражеского края — победа в момент его разрушения, охрану можно не трогать. Тотем не дерётся, но охрана дерётся за него.',
  setup: { objective: { kind: 'killTarget', targetId: 'totem' } },
  foes: () => [
    {
      id: 'totem',
      name: 'Тотем войны',
      side: 'foe',
      maxHp: 70,
      atk: 0,
      range: 1,
      speed: 0,
      move: 0,
      lenses: ['plain'],
      rules: [],
      inert: true,
      spawn: { x: 16, y: 8 },
    },
    soldier(1, 'soldier2'),
    soldier(2, 'soldier1'),
    slinger(1),
  ],
});

/**
 * №5 Прорыв: двое из троих должны уйти с поля через дальний край сквозь
 * заслон из огров. Замер (20 сидов): наив вязнет в ограх — 3/20 при трёх
 * смертях; чистое «уходить к выходу» весом «очень важно» — 20/20 за 3 раунда
 * без потерь. Слово с довеском «бей ближайшего» равного веса глушится тягой
 * атаки (герой останавливается драться с огром) — прорыв требует решимости.
 */
const breakout = (): NodeScenario => ({
  id: 'breakout',
  title: 'Прорыв',
  brief: 'Уведи хотя бы двоих за дальний край поля — шагнувший в зону выхода уходит с поля и в бой не вернётся. Огров можно и перебить, но они для того и поставлены, чтобы это было дорого.',
  setup: { objective: { kind: 'reachZone', count: 2 }, zone: { ...FAR_EDGE } },
  foes: () => [
    { ...ogre(), spawn: { x: 9, y: 6 } },
    { ...ogre(), id: 'ogre2', name: 'Огр 2', spawn: { x: 9, y: 10 } },
    { ...slinger(1), spawn: { x: 12, y: 8 } },
  ],
});

/**
 * №6 Отход с боем: старт посреди поля, погоня прибывает волнами с востока,
 * выход — свой край. Замер (20 сидов): наив принимает бой и тонет в волнах —
 * 0/20; «уходить к выходу» (даже с атакующим довеском — рубаки медленные, бой
 * не завязывается) — 20/20 за 3–4 раунда почти без потерь.
 */
const rearguard = (): NodeScenario => ({
  id: 'rearguard',
  title: 'Отход с боем',
  brief: 'Вас настигли в чистом поле, и погоня прибывает волна за волной. Отведи хотя бы двоих к своему краю — шагнувший в зону выхода уходит с поля; стоять насмерть некому и незачем.',
  setup: {
    objective: { kind: 'reachZone', count: 2 },
    zone: { ...HOME_EDGE },
    waves: [
      { round: 3, specs: [grunt(4), grunt(5)] },
      { round: 6, specs: [{ ...thug(), spawn: { x: 17, y: 8 } }] },
      { round: 9, specs: [wolf(1), wolf(2)] },
    ],
  },
  heroSpawns: [
    { x: 8, y: 7 },
    { x: 9, y: 9 },
    { x: 8, y: 11 },
  ],
  foes: () => [
    { ...grunt(1), spawn: { x: 14, y: 7 } },
    { ...grunt(2), spawn: { x: 15, y: 10 } },
    { ...grunt(3), spawn: { x: 14, y: 12 } },
  ],
});

/**
 * №12 Эскорт: старейшина сам бредёт к перевалу со своими (глупыми)
 * принципами — темп чужой, охота вражья. Замер (20 сидов): наив 11/20 —
 * охота срывает старика на полпути; «вызывать на себя» у танка при его теле
 * перекупает внимание волков — 20/20 без потерь. Второе слово, меняющее
 * ЧУЖОЙ выбор цели, находит здесь свой сценарий.
 */
const escortScenario = (): NodeScenario => ({
  id: 'escort',
  title: 'Эскорт',
  brief: 'Старейшина сам бредёт к перевалу у дальнего края — медленно и не слушая советов. Доведи живым: его смерть — поражение, его шаг в зону перевала — победа.',
  setup: { objective: { kind: 'escort', wardId: 'elder' }, zone: { ...FAR_EDGE } },
  allies: () => [
    {
      id: 'elder',
      name: 'Старейшина',
      side: 'party',
      maxHp: 26,
      atk: 2,
      range: 1,
      speed: 3,
      move: 1,
      lenses: ['plain'],
      spawn: { x: 1, y: 8 },
      rules: [
        rule({ when: { kind: 'always' }, then: { kind: 'evacuate' }, weight: 2.5, source: 'старейшина: идти к перевалу' }),
      ],
    },
  ],
  foes: () => [
    drilled(wolf(1), huntWard('волк: чуять старика')),
    drilled(wolf(2), huntWard('волк: чуять старика')),
    drilled(hunter(1), huntWard('охотник: снять старика')),
  ],
});

/**
 * №15 Трофей: реликвия лежит в центре под охраной. Поднять (закончить шаг на
 * её клетке) и унести к своему краю; смерть носильщика роняет ношу на месте.
 * Замер (20 сидов): наив перемалывает охрану 14/20 за ~15 раундов; «нести
 * трофей» у крепкого бойца — 19/20 за ~11: доставка кончает бой, не дожидаясь
 * резни. Носильщик решает: слово у хрупкого мага проигрывает наиву.
 */
const relic = (): NodeScenario => ({
  id: 'relic',
  title: 'Трофей',
  brief: 'Реликвия лежит в сердце поля под охраной. Подними её (закончи шаг на её клетке) и унеси за свой край — павший носильщик роняет ношу там, где упал.',
  setup: { objective: { kind: 'carry' }, zone: { ...HOME_EDGE }, prize: { x: 9, y: 9 } },
  foes: () => [
    { ...thug(), spawn: { x: 11, y: 9 } },
    { ...wolf(1), spawn: { x: 10, y: 7 } },
    { ...wolf(2), spawn: { x: 10, y: 11 } },
    { ...slinger(1), spawn: { x: 13, y: 9 } },
  ],
});

/**
 * №10 Погоня: гонец с вестью бежит к дальнему краю, волки настигают партию с
 * тыла. Замер (20 сидов): наив рубит бросившихся волков — гонец уходит,
 * 2/20; «атаковать прорывающегося» — 15/20: геометрия перехвата вместо драки.
 */
const chase = (): NodeScenario => ({
  id: 'chase',
  title: 'Погоня',
  brief: 'Гонец уже бежит с вестью к дальнему краю, волки прикрывают его бегство. Срази его до кромки поля — добежит, и тревога поднята: поражение.',
  setup: { objective: { kind: 'intercept', targetId: 'courier' }, zone: { ...FAR_EDGE } },
  foes: () => [
    {
      id: 'courier',
      name: 'Гонец',
      side: 'foe',
      maxHp: 16,
      weapons: [{ name: 'кривой нож', dmg: 3, range: 1 }],
      speed: 8,
      move: 1,
      lenses: ['plain'],
      spawn: { x: 3, y: 8 },
      rules: [
        rule({ when: { kind: 'always' }, then: { kind: 'evacuate' }, weight: 3, source: 'гонец: унести весть за край' }),
      ],
    },
    { ...wolf(1), spawn: { x: 15, y: 5 } },
    { ...wolf(2), spawn: { x: 15, y: 11 } },
  ],
});

/**
 * Сценарий узла карты: волна 1 — на местах, чьи прежние составы сценарий
 * переосмысляет; волна 2 (слои 2 и 4) — виртуальные узлы: карта забега боёв
 * там не порождает, сценарии живут в каталоге debug и тестах, а раскладка по
 * забегу — следующий шаг плана (ротация задач по узлам требует балансового
 * перемера). Узлы без сценария играют «перебей всех» как раньше.
 */
export function scenarioForNode(node: Pick<MapNode, 'kind' | 'layer' | 'slot'>): NodeScenario | null {
  if (node.kind === 'fight' && node.layer === 1 && node.slot === 1) return behead();
  if (node.kind === 'fight' && node.layer === 3 && node.slot === 0) return camp();
  if (node.kind === 'elite' && node.layer === 5 && node.slot === 0) return disruptRitual();
  if (node.kind === 'fight' && node.layer === 5 && node.slot === 1) return huntWaves();
  if (node.kind === 'fight' && node.layer === 2) {
    switch (node.slot) {
      case 0: return redoubt();
      case 1: return convoy();
      case 2: return vigil();
      case 3: return dawn();
      case 4: return sabotage();
    }
  }
  if (node.kind === 'fight' && node.layer === 4) {
    switch (node.slot) {
      case 0: return breakout();
      case 1: return rearguard();
      case 2: return escortScenario();
      case 3: return relic();
      case 4: return chase();
    }
  }
  return null;
}
