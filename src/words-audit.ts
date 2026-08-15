import { type UnitSpec, runBattle } from './battle.js';
import { type PhraseDraft, type SelectorDraft, compilePhrase } from './constructor.js';
import { CONCEPTS, type ConceptId } from './vocab.js';
import { type HeroArchetype, PARTY_SPAWNS, heroArchetype } from './heroes.js';
import {
  archer,
  berserker,
  bonesetter,
  duelist,
  grunt,
  hunter,
  ogre,
  packLeader,
  pyro,
  raider,
  rat,
  sergeant,
  shaman,
  slinger,
  soldier,
  thug,
  troll,
  warlord,
  wolf,
} from './foes.js';
import type { ArenaTag } from './terrain.js';

/**
 * Аудит слов (план words): каждое открываемое слово превращается в тестовые
 * фразы и прогоняется по фиксированным сидам на разных партиях и разных боях
 * забега — с ним и без него. Полезность слова = дельта winrate против базового
 * билда. Два базовых билда: «наивный» (все бьют ближайшего — дефолт старта)
 * и «кайт» (дистанция + ближайший — мета бота после урока). Слова-гейты
 * активов и АОЕ меряются только на партиях с носителем.
 *
 * Это инструмент анализа, не игровой код: словарные гейты обходятся
 * (компиляция с полным словарём).
 */

// ---- Партии: покрывают все 16 героев и всех носителей активов/АОЕ ----

interface AuditParty {
  name: string;
  /** id архетипов; первый — передовой (слот 0 расстановки). */
  heroes: [string, string, string];
}

export const AUDIT_PARTIES: AuditParty[] = [
  { name: 'щит-лук-кинжалы', heroes: ['grom', 'dart', 'tessa'] },
  { name: 'ярость-жезл-жрица', heroes: ['ulv', 'lia', 'iva'] },
  { name: 'глыба-тень-шквал', heroes: ['skala', 'mara', 'yuna'] },
  { name: 'благовест-полымя-трюк', heroes: ['radim', 'vesta', 'lisa'] },
  { name: 'кара-копьё-мастер', heroes: ['zarya', 'zhalo', 'yar'] },
  { name: 'росчерк-жрица-спина', heroes: ['ryk', 'iva', 'tessa'] },
];

// ---- Бои: реальные составы узлов забега (run.ts foesForNode) ----

interface AuditBattle {
  label: string;
  arena: ArenaTag;
  foes: () => UnitSpec[];
}

export const AUDIT_BATTLES: AuditBattle[] = [
  { label: 'урок', arena: 'early', foes: () => [packLeader(), grunt(1), grunt(2), archer(1)] },
  { label: 'крысы×9', arena: 'early', foes: () => Array.from({ length: 9 }, (_, i) => rat(i + 1)) },
  { label: 'вожак+берсерк', arena: 'early', foes: () => [packLeader(), berserker(1), archer(1)] },
  { label: 'волки×3', arena: 'late', foes: () => [wolf(1), wolf(2), wolf(3)] },
  { label: 'пращники×4', arena: 'late', foes: () => [slinger(1), slinger(2), slinger(3), slinger(4)] },
  { label: 'рейдеры+лекарь', arena: 'late', foes: () => [raider(1), raider(2), bonesetter('raider1')] },
  { label: 'засада', arena: 'late', foes: () => [thug(), wolf(1), wolf(2)] },
  { label: 'дуэль', arena: 'elite', foes: () => [duelist(), soldier(1, 'soldier2'), soldier(2, 'soldier1')] },
  { label: 'сержант', arena: 'elite', foes: () => [soldier(1, 'soldier2'), soldier(2, 'soldier1'), sergeant()] },
  { label: 'огр+кастеры', arena: 'elite', foes: () => [ogre(), pyro(1), slinger(1)] },
  { label: 'тролль', arena: 'elite', foes: () => [troll(), slinger(1), slinger(2)] },
  { label: 'босс', arena: 'boss', foes: () => [warlord(), shaman('warlord'), hunter(1)] },
  // жёсткое стрелковое давление: без него слова укрытия/линии огня упираются
  // в потолок (пращники×4 выигрываются на 100% любым билдом)
  { label: 'расстрел', arena: 'late', foes: () => [archer(1), archer(2), slinger(1), slinger(2), pyro(1)] },
];

// ---- Варианты фраз на слово ----

interface PartyCtx {
  frontId: string;
  /** Самый хрупкий из непередовых — кого защищать/лечить. */
  squishyId: string;
  names: Record<string, string>;
}

/** Гейт носителя: вариант меряется только на партиях, где слову есть чем работать. */
type Carrier = 'rage' | 'heal' | 'blastline' | 'ritual';

interface AuditEntry {
  /** Слово под аудитом; null — именованное комбо (несколько слов разом). */
  word: ConceptId | null;
  label: string;
  /** Слова-компаньоны комбо (для отчёта). */
  extra?: ConceptId[];
  carrier?: Carrier;
  /** Пометить первого врага боя (метка игрока перед боем). */
  markFoe?: boolean;
  /** Фразы героя в этом варианте; пусто — герой не участвует. */
  drafts: (hero: HeroArchetype, ctx: PartyCtx) => PhraseDraft[];
}

const w2 = (draft: Omit<PhraseDraft, 'weight'>): PhraseDraft => ({ ...draft, weight: 2 });
const always = { id: 'always' } as const;
const forRoles =
  (roles: HeroArchetype['role'][], mk: (hero: HeroArchetype, ctx: PartyCtx) => PhraseDraft[]) =>
  (hero: HeroArchetype, ctx: PartyCtx): PhraseDraft[] =>
    roles.includes(hero.role) ? mk(hero, ctx) : [];
const everyone =
  (mk: (hero: HeroArchetype, ctx: PartyCtx) => PhraseDraft[]) =>
  (hero: HeroArchetype, ctx: PartyCtx): PhraseDraft[] =>
    mk(hero, ctx);

const atk = (target: SelectorDraft): PhraseDraft =>
  w2({ condition: always, preference: { id: 'act.attack', target } });

export const AUDIT_ENTRIES: AuditEntry[] = [
  // — условия (само по себе условие немо́ — меряем в паре с действием) —
  {
    word: 'cond.outnumbered',
    label: 'врагов больше → отступать',
    drafts: everyone(() => [w2({ condition: { id: 'cond.outnumbered' }, preference: { id: 'act.retreat' } })]),
  },
  {
    word: 'cond.outnumbered',
    label: 'врагов больше → глухая оборона (передовой)',
    extra: ['act.brace'],
    drafts: forRoles(['front'], () => [w2({ condition: { id: 'cond.outnumbered' }, preference: { id: 'act.brace' } })]),
  },
  {
    word: 'cond.allyInDanger',
    label: 'хрупкий в опасности → защищать его (передовой)',
    extra: ['act.protect'],
    drafts: forRoles(['front'], (_h, ctx) => [
      w2({ condition: { id: 'cond.allyInDanger', ally: ctx.squishyId }, preference: { id: 'act.protect', ally: ctx.squishyId } }),
    ]),
  },
  {
    word: 'cond.battleDrags',
    label: 'бой затянулся → бить отчаянно',
    extra: ['act.strikeDesperate'],
    drafts: everyone(() => [w2({ condition: { id: 'cond.battleDrags' }, preference: { id: 'act.strikeDesperate' } })]),
  },
  {
    word: 'cond.battleDrags',
    label: 'бой затянулся → бить наверняка',
    extra: ['act.strikeHard'],
    drafts: everyone(() => [w2({ condition: { id: 'cond.battleDrags' }, preference: { id: 'act.strikeHard' } })]),
  },
  {
    word: 'cond.initiativeEdge',
    label: 'мы быстрее → размен',
    extra: ['act.trade'],
    drafts: everyone(() => [w2({ condition: { id: 'cond.initiativeEdge' }, preference: { id: 'act.trade' } })]),
  },
  {
    word: 'cond.initiativeEdge',
    label: 'мы быстрее → держать дистанцию',
    extra: ['act.standoff'],
    drafts: everyone(() => [w2({ condition: { id: 'cond.initiativeEdge' }, preference: { id: 'act.standoff' } })]),
  },
  {
    word: 'cond.allyFallen',
    label: 'наши пали → отступать',
    drafts: everyone(() => [w2({ condition: { id: 'cond.allyFallen' }, preference: { id: 'act.retreat' } })]),
  },
  {
    word: 'cond.allyFallen',
    label: 'наши пали → бить отчаянно',
    extra: ['act.strikeDesperate'],
    drafts: everyone(() => [w2({ condition: { id: 'cond.allyFallen' }, preference: { id: 'act.strikeDesperate' } })]),
  },
  {
    word: 'cond.surrounded',
    label: 'окружили → глухая оборона',
    extra: ['act.brace'],
    drafts: everyone(() => [w2({ condition: { id: 'cond.surrounded' }, preference: { id: 'act.brace' } })]),
  },
  {
    word: 'cond.surrounded',
    label: 'окружили → отступать',
    drafts: everyone(() => [w2({ condition: { id: 'cond.surrounded' }, preference: { id: 'act.retreat' } })]),
  },
  {
    word: 'cond.underCharge',
    label: 'накатывают → замахиваться ритуалом',
    extra: ['act.castRitual'],
    carrier: 'ritual',
    drafts: everyone(() => [w2({ condition: { id: 'cond.underCharge' }, preference: { id: 'act.castRitual' } })]),
  },
  {
    word: 'cond.underCharge',
    label: 'накатывают → держать интервал',
    extra: ['space.spread'],
    drafts: everyone(() => [w2({ condition: { id: 'cond.underCharge' }, preference: { id: 'space.spread' } })]),
  },
  {
    word: 'cond.underCharge',
    label: 'накатывают → глухая оборона (передовой)',
    extra: ['act.brace'],
    drafts: forRoles(['front'], () => [w2({ condition: { id: 'cond.underCharge' }, preference: { id: 'act.brace' } })]),
  },
  // — селекторы (в паре с «атаковать») —
  { word: 'sel.leader', label: 'атаковать вожака', drafts: everyone(() => [atk('sel.leader')]) },
  { word: 'sel.mostDangerous', label: 'атаковать самого опасного', drafts: everyone(() => [atk('sel.mostDangerous')]) },
  { word: 'sel.attacker', label: 'атаковать обидчика', drafts: everyone(() => [atk('sel.attacker')]) },
  { word: 'sel.marked', label: 'атаковать помеченного (метка на первом враге)', markFoe: true, drafts: everyone(() => [atk('sel.marked')]) },
  { word: 'sel.shooter', label: 'атаковать стрелка', drafts: everyone(() => [atk('sel.shooter')]) },
  { word: 'sel.farthest', label: 'атаковать самого дальнего', drafts: everyone(() => [atk('sel.farthest')]) },
  // — действия —
  {
    word: 'act.protect',
    label: 'защищать хрупкого (передовой)',
    drafts: forRoles(['front'], (_h, ctx) => [w2({ condition: always, preference: { id: 'act.protect', ally: ctx.squishyId } })]),
  },
  { word: 'act.bait', label: 'изображать приманку (передовой)', drafts: forRoles(['front'], () => [w2({ condition: always, preference: { id: 'act.bait' } })]) },
  { word: 'act.trade', label: 'идти на размен', drafts: everyone(() => [w2({ condition: always, preference: { id: 'act.trade' } })]) },
  {
    word: 'act.coverRetreat',
    label: 'прикрывать отход (передовой)',
    drafts: forRoles(['front'], () => [w2({ condition: always, preference: { id: 'act.coverRetreat' } })]),
  },
  { word: 'act.standoff', label: 'держать дистанцию', drafts: everyone(() => [w2({ condition: always, preference: { id: 'act.standoff' } })]) },
  { word: 'act.brace', label: 'глухая оборона (передовой)', drafts: forRoles(['front'], () => [w2({ condition: always, preference: { id: 'act.brace' } })]) },
  { word: 'act.strikeOften', label: 'бить часто', drafts: everyone(() => [w2({ condition: always, preference: { id: 'act.strikeOften' } })]) },
  {
    word: 'act.strikeOften',
    label: 'бить часто (кому оружие велит)',
    drafts: (h) =>
      h.weapons.some((w) => (w.affinity?.weakAttack ?? 0) > 0 || (w.weakMult ?? 0) > 0.5)
        ? [w2({ condition: always, preference: { id: 'act.strikeOften' } })]
        : [],
  },
  { word: 'act.strikeHard', label: 'бить наверняка', drafts: everyone(() => [w2({ condition: always, preference: { id: 'act.strikeHard' } })]) },
  {
    word: 'act.strikeHard',
    label: 'бить наверняка (кому оружие велит)',
    drafts: (h) =>
      h.weapons.some((w) => (w.affinity?.attack ?? 0) > 0 || (w.affinity?.weakAttack ?? 0) < 0)
        ? [w2({ condition: always, preference: { id: 'act.strikeHard' } })]
        : [],
  },
  { word: 'act.strikeDesperate', label: 'бить отчаянно', drafts: everyone(() => [w2({ condition: always, preference: { id: 'act.strikeDesperate' } })]) },
  { word: 'act.shove', label: 'толкать', drafts: everyone(() => [w2({ condition: always, preference: { id: 'act.shove' } })]) },
  { word: 'act.barrage', label: 'накрыть скопление', carrier: 'blastline', drafts: everyone(() => [w2({ condition: always, preference: { id: 'act.barrage' } })]) },
  {
    word: 'act.preempt',
    label: 'ритуал + бить на упреждение',
    extra: ['act.castRitual'],
    carrier: 'ritual',
    drafts: everyone(() => [
      w2({ condition: always, preference: { id: 'act.castRitual' } }),
      w2({ condition: always, preference: { id: 'act.preempt' } }),
    ]),
  },
  { word: 'act.castRitual', label: 'замахиваться ритуалом', carrier: 'ritual', drafts: everyone(() => [w2({ condition: always, preference: { id: 'act.castRitual' } })]) },
  { word: 'act.rage', label: 'впасть в ярость (сразу)', carrier: 'rage', drafts: everyone(() => [w2({ condition: always, preference: { id: 'act.rage' } })]) },
  { word: 'act.heal', label: 'лечить раненых', carrier: 'heal', drafts: everyone(() => [w2({ condition: always, preference: { id: 'act.heal' } })]) },
  // — пространство —
  {
    word: 'space.nearTo',
    label: 'задним держаться рядом с передовым',
    drafts: forRoles(['ranged', 'melee'], (_h, ctx) => [
      w2({ condition: always, preference: { id: 'space.nearTo', ref: { ally: ctx.frontId } } }),
    ]),
  },
  {
    word: 'space.behind',
    label: 'задним держаться позади передового',
    drafts: forRoles(['ranged', 'melee'], (_h, ctx) => [
      w2({ condition: always, preference: { id: 'space.behind', ref: { ally: ctx.frontId } } }),
    ]),
  },
  { word: 'space.flank', label: 'заходить во фланг (ближники)', drafts: forRoles(['melee'], () => [w2({ condition: always, preference: { id: 'space.flank' } })]) },
  { word: 'space.lineOfFire', label: 'вне линии огня (стрелки)', drafts: forRoles(['ranged'], () => [w2({ condition: always, preference: { id: 'space.lineOfFire' } })]) },
  { word: 'space.chokepoint', label: 'узкое место (передовой)', drafts: forRoles(['front'], () => [w2({ condition: always, preference: { id: 'space.chokepoint' } })]) },
  {
    word: 'space.awayFrom',
    label: 'стрелкам держаться подальше от ближайшего',
    drafts: forRoles(['ranged'], () => [
      w2({ condition: always, preference: { id: 'space.awayFrom', ref: { enemy: 'sel.nearest' } } }),
    ]),
  },
  { word: 'space.highGround', label: 'держать высоту (стрелки)', drafts: forRoles(['ranged'], () => [w2({ condition: always, preference: { id: 'space.highGround' } })]) },
  { word: 'space.behindCover', label: 'за укрытием (стрелки)', drafts: forRoles(['ranged'], () => [w2({ condition: always, preference: { id: 'space.behindCover' } })]) },
  { word: 'space.spread', label: 'держать интервал', drafts: everyone(() => [w2({ condition: always, preference: { id: 'space.spread' } })]) },
  { word: 'space.avoidHazard', label: 'обходить опасное', drafts: everyone(() => [w2({ condition: always, preference: { id: 'space.avoidHazard' } })]) },
  // — именованные комбо (несколько слов разом) —
  {
    word: null,
    label: 'комбо: фланг + бить часто (ближники)',
    extra: ['space.flank', 'act.strikeOften'],
    drafts: forRoles(['melee'], () => [
      w2({ condition: always, preference: { id: 'space.flank' } }),
      w2({ condition: always, preference: { id: 'act.strikeOften' } }),
    ]),
  },
  {
    word: null,
    label: 'комбо: высота + бить наверняка (стрелки)',
    extra: ['space.highGround', 'act.strikeHard'],
    drafts: forRoles(['ranged'], () => [
      w2({ condition: always, preference: { id: 'space.highGround' } }),
      w2({ condition: always, preference: { id: 'act.strikeHard' } }),
    ]),
  },
  {
    word: null,
    label: 'комбо: укрытие + дистанция (стрелки)',
    extra: ['space.behindCover', 'act.standoff'],
    drafts: forRoles(['ranged'], () => [
      w2({ condition: always, preference: { id: 'space.behindCover' } }),
      w2({ condition: always, preference: { id: 'act.standoff' } }),
    ]),
  },
  {
    word: null,
    label: 'комбо: приманка (передовой) + фланг (ближники)',
    extra: ['act.bait', 'space.flank'],
    drafts: (h, _ctx) =>
      h.role === 'front'
        ? [w2({ condition: always, preference: { id: 'act.bait' } })]
        : h.role === 'melee'
          ? [w2({ condition: always, preference: { id: 'space.flank' } })]
          : [],
  },
  {
    word: null,
    label: 'комбо: интервал + обходить опасное',
    extra: ['space.spread', 'space.avoidHazard'],
    drafts: everyone(() => [
      w2({ condition: always, preference: { id: 'space.spread' } }),
      w2({ condition: always, preference: { id: 'space.avoidHazard' } }),
    ]),
  },
  // — переработка мёртвого пласта: расширенные пары условий —
  {
    word: 'cond.battleDrags',
    label: 'бой затянулся → размен',
    extra: ['act.trade'],
    drafts: everyone(() => [w2({ condition: { id: 'cond.battleDrags' }, preference: { id: 'act.trade' } })]),
  },
  {
    word: 'cond.battleDrags',
    label: 'бой затянулся → лечить',
    extra: ['act.heal'],
    carrier: 'heal',
    drafts: everyone(() => [w2({ condition: { id: 'cond.battleDrags' }, preference: { id: 'act.heal' } })]),
  },
  {
    word: 'cond.allyFallen',
    label: 'наши пали → атаковать обидчика',
    extra: ['sel.attacker'],
    drafts: everyone(() => [
      w2({ condition: { id: 'cond.allyFallen' }, preference: { id: 'act.attack', target: 'sel.attacker' } }),
    ]),
  },
  {
    word: 'cond.allyFallen',
    label: 'наши пали → глухая оборона (передовой)',
    extra: ['act.brace'],
    drafts: forRoles(['front'], () => [
      w2({ condition: { id: 'cond.allyFallen' }, preference: { id: 'act.brace' } }),
    ]),
  },
  {
    word: 'cond.initiativeEdge',
    label: 'мы быстрее → бить отчаянно',
    extra: ['act.strikeDesperate'],
    drafts: everyone(() => [
      w2({ condition: { id: 'cond.initiativeEdge' }, preference: { id: 'act.strikeDesperate' } }),
    ]),
  },
  {
    word: 'act.strikeDesperate',
    label: 'hp ниже 35% → бить отчаянно',
    drafts: everyone(() => [
      w2({ condition: { id: 'cond.hpBelow', who: 'self', frac: 0.35 }, preference: { id: 'act.strikeDesperate' } }),
    ]),
  },
  // — внимание (план teamwork): слова меняют ЧУЖОЙ выбор цели —
  {
    word: 'act.taunt',
    label: 'вызывать на себя (передовой)',
    drafts: forRoles(['front'], () => [w2({ condition: always, preference: { id: 'act.taunt' } })]),
  },
  {
    word: 'act.lure',
    label: 'уводить врагов от хрупкого (передовой)',
    drafts: forRoles(['front'], (_h, ctx) => [
      w2({ condition: always, preference: { id: 'act.lure', ally: ctx.squishyId } }),
    ]),
  },
  {
    word: 'act.taunt',
    label: 'комбо: вызывать на себя + уводить от хрупкого (передовой)',
    extra: ['act.lure'],
    drafts: forRoles(['front'], (_h, ctx) => [
      w2({ condition: always, preference: { id: 'act.taunt' } }),
      w2({ condition: always, preference: { id: 'act.lure', ally: ctx.squishyId } }),
    ]),
  },
  // — совместные действия (план teamwork, вторая волна): роли, условия про
  //   своих и три действия, у которых смысл есть только рядом с товарищем —
  {
    word: 'sel.allyWounded',
    label: 'прикрывать раненого — роль вместо имени (передовой)',
    extra: ['act.protect'],
    drafts: forRoles(['front'], () => [
      w2({ condition: always, preference: { id: 'act.protect', ally: { role: 'wounded' } } }),
    ]),
  },
  {
    word: 'act.screen',
    label: 'у врага стрелки → заслонять хрупкого (передовой)',
    extra: ['cond.enemyShooters'],
    drafts: forRoles(['front'], (_h, ctx) => [
      w2({ condition: { id: 'cond.enemyShooters' }, preference: { id: 'act.screen', ally: ctx.squishyId } }),
    ]),
  },
  {
    word: 'act.regroup',
    label: 'смыкать строй (все)',
    drafts: everyone(() => [w2({ condition: always, preference: { id: 'act.regroup' } })]),
  },
  {
    word: 'act.swap',
    label: 'хрупкий в опасности → меняться с ним местами (передовой)',
    extra: ['cond.allyInDanger'],
    drafts: forRoles(['front'], (_h, ctx) => [
      w2({ condition: { id: 'cond.allyInDanger', ally: ctx.squishyId }, preference: { id: 'act.swap', ally: ctx.squishyId } }),
    ]),
  },
  {
    word: 'cond.allyTaunting',
    label: 'комбо: передовой вызывает — остальные во фланг',
    extra: ['act.taunt', 'space.flank'],
    drafts: (hero) =>
      hero.role === 'front'
        ? [w2({ condition: always, preference: { id: 'act.taunt' } })]
        : [w2({ condition: { id: 'cond.allyTaunting' }, preference: { id: 'space.flank' } })],
  },
  {
    word: 'cond.allySurrounded',
    label: 'нашего обступили → бить обидчика наших',
    extra: ['sel.tormentor'],
    drafts: everyone(() => [
      w2({ condition: { id: 'cond.allySurrounded' }, preference: { id: 'act.attack', target: 'sel.tormentor' } }),
    ]),
  },
  // — слова рельефа: пользоваться местностью, а не только не страдать от неё —
  {
    word: 'space.roughEdge',
    label: 'стеречь кромку (стрелки)',
    drafts: forRoles(['ranged'], () => [w2({ condition: always, preference: { id: 'space.roughEdge' } })]),
  },
  {
    word: 'space.outflank',
    label: 'обходить из-за спин (ближники)',
    drafts: forRoles(['melee'], () => [w2({ condition: always, preference: { id: 'space.outflank' } })]),
  },
  {
    word: null,
    label: 'комбо: обход из-за спин + фланг (ближники)',
    extra: ['space.outflank', 'space.flank'],
    drafts: forRoles(['melee'], () => [
      w2({ condition: always, preference: { id: 'space.outflank' } }),
      w2({ condition: always, preference: { id: 'space.flank' } }),
    ]),
  },
  // — третья волна teamwork: канал метки, позиция относительно своих, разбор
  //   толпы по одному, роли заклинателя/лекаря, «мы растянулись» —
  {
    word: 'act.mark',
    label: 'метить цель без читателей (передовой)',
    drafts: forRoles(['front'], () => [w2({ condition: always, preference: { id: 'act.mark' } })]),
  },
  {
    word: 'act.mark',
    label: 'комбо: передовой метит — остальные бьют помеченного',
    extra: ['sel.marked'],
    drafts: (hero) =>
      hero.role === 'front'
        ? [w2({ condition: always, preference: { id: 'act.mark' } })]
        : [w2({ condition: always, preference: { id: 'act.attack', target: 'sel.marked' } })],
  },
  {
    word: 'space.fallback',
    label: 'hp ниже 40% → отходить за спины (все)',
    extra: ['cond.hpBelow'],
    drafts: everyone(() => [
      w2({ condition: { id: 'cond.hpBelow', who: 'self', frac: 0.4 }, preference: { id: 'space.fallback' } }),
    ]),
  },
  {
    word: 'space.clearLine',
    label: 'не застить своим (ближники)',
    drafts: forRoles(['front', 'melee'], () => [w2({ condition: always, preference: { id: 'space.clearLine' } })]),
  },
  {
    word: 'act.pin',
    label: 'связывать боем (ближники)',
    drafts: forRoles(['front', 'melee'], () => [w2({ condition: always, preference: { id: 'act.pin' } })]),
  },
  {
    word: 'sel.allyCaster',
    label: 'защищать нашего заклинателя (передовой)',
    extra: ['act.protect'],
    drafts: forRoles(['front'], () => [
      w2({ condition: always, preference: { id: 'act.protect', ally: { role: 'caster' } } }),
    ]),
  },
  {
    word: 'sel.allyHealer',
    label: 'защищать нашего лекаря (передовой)',
    extra: ['act.protect'],
    drafts: forRoles(['front'], () => [
      w2({ condition: always, preference: { id: 'act.protect', ally: { role: 'healer' } } }),
    ]),
  },
  {
    word: 'cond.spreadThin',
    label: 'мы растянулись → смыкать строй (все)',
    extra: ['act.regroup'],
    drafts: everyone(() => [
      w2({ condition: { id: 'cond.spreadThin' }, preference: { id: 'act.regroup' } }),
    ]),
  },
  // ---- четвёртая партия слов: «чтение боя» ----
  {
    word: 'cond.lull',
    label: 'затишье → лечить (носитель исцеления)',
    extra: ['act.heal'],
    carrier: 'heal',
    drafts: everyone(() => [w2({ condition: { id: 'cond.lull' }, preference: { id: 'act.heal' } })]),
  },
  {
    word: 'cond.lull',
    label: 'затишье → смыкать строй (все)',
    extra: ['act.regroup'],
    drafts: everyone(() => [w2({ condition: { id: 'cond.lull' }, preference: { id: 'act.regroup' } })]),
  },
  {
    word: 'cond.onHighGround',
    label: 'высота + на высоте → бить наверняка (стрелки)',
    extra: ['space.highGround', 'act.strikeHard'],
    drafts: forRoles(['ranged'], () => [
      w2({ condition: always, preference: { id: 'space.highGround' } }),
      w2({ condition: { id: 'cond.onHighGround' }, preference: { id: 'act.strikeHard' } }),
    ]),
  },
  {
    word: 'cond.cornered',
    label: 'прижали → бить отчаянно (все)',
    extra: ['act.strikeDesperate'],
    drafts: everyone(() => [
      w2({ condition: { id: 'cond.cornered' }, preference: { id: 'act.strikeDesperate' } }),
    ]),
  },
  {
    word: 'cond.cornered',
    label: 'прижали → глухая оборона (все)',
    extra: ['act.brace'],
    drafts: everyone(() => [w2({ condition: { id: 'cond.cornered' }, preference: { id: 'act.brace' } })]),
  },
  {
    word: 'cond.inFormation',
    label: 'строй сомкнут → размен (ближники)',
    extra: ['act.trade'],
    drafts: forRoles(['front', 'melee'], () => [
      w2({ condition: { id: 'cond.inFormation' }, preference: { id: 'act.trade' } }),
    ]),
  },
  {
    word: 'cond.inFormation',
    label: 'комбо: смыкать строй + строй сомкнут → размен (ближники)',
    extra: ['act.regroup', 'act.trade'],
    drafts: forRoles(['front', 'melee'], () => [
      w2({ condition: always, preference: { id: 'act.regroup' } }),
      w2({ condition: { id: 'cond.inFormation' }, preference: { id: 'act.trade' } }),
    ]),
  },
  // в составах аудита крикунов нет — селектор читается как «ближайший»;
  // ценность слова меряется смоуком узла задиры (test/words-reading.test.ts)
  { word: 'sel.heckler', label: 'бить крикуна (все)', drafts: everyone(() => [atk('sel.heckler')]) },
  { word: 'sel.unengaged', label: 'стрелкам — бить свободного', drafts: forRoles(['ranged'], () => [atk('sel.unengaged')]) },
  {
    word: 'sel.unengaged',
    label: 'комбо: ближники связывают, стрелки бьют свободного',
    extra: ['act.pin'],
    drafts: (hero) =>
      hero.role === 'ranged'
        ? [atk('sel.unengaged')]
        : [w2({ condition: always, preference: { id: 'act.pin' } })],
  },
  // план damage-types: слова о защитах. «Уязвимый» и «бронированный» —
  // про выбор цели, «оружие не берёт» — гейт смены цели
  { word: 'sel.vulnerable', label: 'бить уязвимого (все)', drafts: everyone(() => [atk('sel.vulnerable')]) },
  { word: 'sel.armored', label: 'бить бронированного (все)', drafts: everyone(() => [atk('sel.armored')]) },
  {
    word: 'cond.weaponFails',
    label: 'комбо: оружие не берёт → бить уязвимого',
    extra: ['sel.vulnerable'],
    drafts: everyone(() => [
      w2({ condition: { id: 'cond.weaponFails' }, preference: { id: 'act.attack', target: 'sel.vulnerable' } }),
      { condition: always, preference: { id: 'act.attack', target: 'sel.nearest' } },
    ]),
  },
];

// ---- Сборка спеков и прогон ----

const ALL_CONCEPTS = Object.keys(CONCEPTS) as ConceptId[];

type BaseKind = 'naive' | 'kite';

const BASE_DRAFTS: Record<BaseKind, PhraseDraft[]> = {
  naive: [{ condition: always, preference: { id: 'act.attack', target: 'sel.nearest' } }],
  kite: [
    w2({ condition: always, preference: { id: 'act.standoff' } }),
    w2({ condition: always, preference: { id: 'act.attack', target: 'sel.nearest' } }),
  ],
};

function partyCtx(party: AuditParty): PartyCtx {
  const heroes = party.heroes.map(heroArchetype);
  const back = heroes.slice(1);
  const squishy = back.reduce((a, b) => (b.stats.maxHp < a.stats.maxHp ? b : a));
  return {
    frontId: heroes[0]!.id,
    squishyId: squishy.id,
    names: Object.fromEntries(heroes.map((h) => [h.id, h.name])),
  };
}

function heroSpec(arch: HeroArchetype, slot: number, drafts: PhraseDraft[], ctx: PartyCtx): UnitSpec {
  const rules = drafts.map((d) => {
    const r = compilePhrase(d, ALL_CONCEPTS, ctx.names);
    if (!r.ok) throw new Error(`Аудит: фраза не скомпилировалась (${r.missing.join(', ')})`);
    return r.rule;
  });
  return {
    id: arch.id,
    name: arch.name,
    side: 'party',
    lenses: [],
    rules: [...rules, ...arch.innate],
    maxHp: arch.stats.maxHp,
    speed: arch.stats.speed,
    move: arch.stats.move,
    weapons: arch.weapons,
    ...(arch.active ? { active: arch.active } : {}),
    ...(arch.passives ? { passives: arch.passives } : {}),
    ...(arch.defenses ? { defenses: arch.defenses } : {}),
    spawn: { ...PARTY_SPAWNS[slot]! },
  };
}

function hasCarrier(party: AuditParty, carrier: Carrier | undefined): boolean {
  if (!carrier) return true;
  return party.heroes.some((id) => {
    const a = heroArchetype(id);
    switch (carrier) {
      case 'rage':
        return a.active?.rage !== undefined;
      case 'heal':
        return a.active?.heal !== undefined;
      case 'blastline':
        return a.weapons.some((w) => w.aoe?.blast !== undefined || w.aoe?.line !== undefined);
      case 'ritual':
        return a.weapons.some((w) => w.aoe?.ritual !== undefined);
    }
  });
}

interface CellStat {
  n: number;
  wins: number;
  /** Сумма доли hp живой партии в конце боя (мёртвые = 0). */
  hpSum: number;
}

function runCell(
  party: AuditParty,
  ctx: PartyCtx,
  battle: AuditBattle,
  seeds: readonly number[],
  drafts: (hero: HeroArchetype, ctx: PartyCtx) => PhraseDraft[],
  markFoe: boolean,
): CellStat {
  const stat: CellStat = { n: 0, wins: 0, hpSum: 0 };
  for (const seed of seeds) {
    const heroes = party.heroes.map((id, slot) => heroSpec(heroArchetype(id), slot, drafts(heroArchetype(id), ctx), ctx));
    const foes = battle.foes();
    if (markFoe && foes[0]) foes[0] = { ...foes[0], tags: [...(foes[0].tags ?? []), 'marked'] };
    const r = runBattle(seed, [...heroes, ...foes], battle.arena);
    stat.n++;
    if (r.winner === 'party') stat.wins++;
    let hp = 0;
    let max = 0;
    for (const u of r.units) {
      if (u.side !== 'party') continue;
      max += u.maxHp;
      if (u.alive) hp += u.hp;
    }
    stat.hpSum += max > 0 ? hp / max : 0;
  }
  return stat;
}

export interface AuditCell {
  party: string;
  battle: string;
  base: BaseKind;
  n: number;
  baseWr: number;
  wr: number;
  baseHp: number;
  hp: number;
}

export interface AuditRow {
  word: ConceptId | null;
  label: string;
  extra: ConceptId[];
  carrier?: Carrier;
  parties: string[];
  cells: AuditCell[];
}

export interface WordsAuditOptions {
  seedCount?: number;
  /** Диапазон записей [from, to) — для параллельных шардов прогона. */
  from?: number;
  to?: number;
  /** Прогресс на entry — для длинных прогонов. */
  onEntry?: (label: string, i: number, total: number) => void;
}

export function wordsAudit(opts: WordsAuditOptions = {}): AuditRow[] {
  const seeds = Array.from({ length: opts.seedCount ?? 10 }, (_, i) => i + 1);
  const entries = AUDIT_ENTRIES.slice(opts.from ?? 0, opts.to ?? AUDIT_ENTRIES.length);
  // кэш базовых прогонов: base|party|battle
  const baseCache = new Map<string, CellStat>();
  const baseStat = (base: BaseKind, party: AuditParty, ctx: PartyCtx, battle: AuditBattle): CellStat => {
    const key = `${base}|${party.name}|${battle.label}`;
    let s = baseCache.get(key);
    if (!s) {
      s = runCell(party, ctx, battle, seeds, () => BASE_DRAFTS[base].map((d) => ({ ...d })), false);
      baseCache.set(key, s);
    }
    return s;
  };

  const rows: AuditRow[] = [];
  for (const [i, entry] of entries.entries()) {
    opts.onEntry?.(entry.label, i + 1, entries.length);
    const parties = AUDIT_PARTIES.filter((p) => hasCarrier(p, entry.carrier));
    const row: AuditRow = {
      word: entry.word,
      label: entry.label,
      extra: entry.extra ?? [],
      ...(entry.carrier ? { carrier: entry.carrier } : {}),
      parties: [],
      cells: [],
    };
    for (const party of parties) {
      const ctx = partyCtx(party);
      // вариант неприменим к составу (нет нужной роли) — пропускаем партию
      if (!party.heroes.some((id) => entry.drafts(heroArchetype(id), ctx).length > 0)) continue;
      row.parties.push(party.name);
      for (const base of ['naive', 'kite'] as const) {
        for (const battle of AUDIT_BATTLES) {
          const b = baseStat(base, party, ctx, battle);
          const s = runCell(
            party,
            ctx,
            battle,
            seeds,
            (h, c) => [...BASE_DRAFTS[base].map((d) => ({ ...d })), ...entry.drafts(h, c)],
            entry.markFoe ?? false,
          );
          row.cells.push({
            party: party.name,
            battle: battle.label,
            base,
            n: s.n,
            baseWr: b.wins / b.n,
            wr: s.wins / s.n,
            baseHp: b.hpSum / b.n,
            hp: s.hpSum / s.n,
          });
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

// ---- Отчёт ----

interface RowSummary {
  word: ConceptId | null;
  label: string;
  parties: number;
  dNaive: number;
  dKite: number;
  dHpNaive: number;
  dHpKite: number;
  best: { battle: string; d: number };
  worst: { battle: string; d: number };
}

export function summarize(row: AuditRow): RowSummary {
  const mean = (xs: number[]): number => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const byBase = (base: BaseKind): AuditCell[] => row.cells.filter((c) => c.base === base);
  const dNaive = mean(byBase('naive').map((c) => c.wr - c.baseWr));
  const dKite = mean(byBase('kite').map((c) => c.wr - c.baseWr));
  const dHpNaive = mean(byBase('naive').map((c) => c.hp - c.baseHp));
  const dHpKite = mean(byBase('kite').map((c) => c.hp - c.baseHp));
  // по боям: средняя дельта winrate по партиям и обоим базовым билдам
  const battles = new Map<string, number[]>();
  for (const c of row.cells) {
    const list = battles.get(c.battle) ?? [];
    list.push(c.wr - c.baseWr);
    battles.set(c.battle, list);
  }
  let best = { battle: '—', d: -Infinity };
  let worst = { battle: '—', d: Infinity };
  for (const [battle, ds] of battles) {
    const d = mean(ds);
    if (d > best.d) best = { battle, d };
    if (d < worst.d) worst = { battle, d };
  }
  return { word: row.word, label: row.label, parties: row.parties.length, dNaive, dKite, dHpNaive, dHpKite, best, worst };
}

export function printAudit(rows: AuditRow[]): void {
  const pp = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}`.padStart(4);
  console.log('слово / вариант                                        партий  Δнаив  Δкайт  Δhp(н) Δhp(к)  лучший бой        худший бой');
  for (const row of rows) {
    const s = summarize(row);
    const name = (row.word ? `${row.word}: ` : '') + row.label;
    console.log(
      `${name.slice(0, 52).padEnd(52)}  ${String(s.parties).padStart(4)}  ${pp(s.dNaive)}%  ${pp(s.dKite)}%  ${pp(s.dHpNaive)}%  ${pp(s.dHpKite)}%  ${(s.best.battle + ' ' + pp(s.best.d) + '%').padEnd(16)}  ${s.worst.battle} ${pp(s.worst.d)}%`,
    );
  }
}
