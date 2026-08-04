import { type BattleResult, type UnitSpec, runBattle } from './battle.js';
import { type PhraseDraft, compilePhrase } from './constructor.js';
import { CORE_WORDS, type ConceptId, DEEP_WORDS, STARTING_VOCAB, UNLOCKABLE } from './vocab.js';
import { type Rule } from './ir.js';
import { PARTY_SPAWNS, defaultPhrasesFor, heroArchetype, pickParty } from './heroes.js';
import { archer, berserker, grunt, hunter, packLeader, shaman, warChief, warlord } from './foes.js';
import { type Rng, mulberry32, shuffle } from './rng.js';
import { LENS_POOL, rollLenses } from './lens.js';
import type { LensId, Pos } from './types.js';

/**
 * Забег фазы 4: ветвящаяся карта из 15 узлов (à la Slay the Spire),
 * HP переносится между боями, пермасмерть, события, привал, босс.
 * Всё детерминировано сидом забега.
 *
 * Первый узел — урок: поражение не кончает забег, а предлагает переписать
 * приказ и переиграть с теми же костями (онбординг ядра игры).
 */

export interface HeroState {
  id: string;
  /** id архетипа из HERO_POOL — статы и способность; равен id героя. */
  archetypeId: string;
  name: string;
  /** 1–3 случайные линзы характера — выпадают при генерации забега. */
  lenses: LensId[];
  stats: { maxHp: number; atk: number; range: number; speed: number; move: number; spawn: Pos };
  alive: boolean;
  /** Текущее hp — переносится между боями; лечится на привале и перевязкой после победы. */
  hp: number;
  slots: number;
  phrases: PhraseDraft[];
}

export type NodeKind = 'lesson' | 'fight' | 'elite' | 'event' | 'rest' | 'scriptorium' | 'boss';

export interface MapNode {
  id: number;
  layer: number;
  /** Позиция внутри слоя (для отрисовки и состава боя). */
  slot: number;
  kind: NodeKind;
  /** id узлов следующего слоя, в которые можно пойти. */
  next: number[];
}

export interface RunState {
  runSeed: number;
  map: MapNode[];
  /** Текущий узел карты. */
  at: number;
  /** Узел пройден — можно выбирать следующий из map[at].next. */
  resolved: boolean;
  vocab: ConceptId[];
  heroes: HeroState[];
  /**
   * Метка фокус-огня: id врага текущего боевого узла, выбранный игроком до боя.
   * Правила «атаковать: помеченный» целятся в него. Живёт до ухода с узла —
   * спарринг «те же кости» играет с той же меткой.
   */
  marked: string | null;
  /** Трофей за победу в бою: выбор из закрытых концептов; null — забран/нет. */
  pendingReward: ConceptId[] | null;
  status: 'ongoing' | 'won' | 'lost';
  log: string[];
}

export const START_SLOTS = 2;
export const MAX_SLOTS = 4;

/**
 * Перевязка после победы: доля maxHp. Поднята с 0.25, когда ранние бои
 * перестали быть бесплатными: без этого истощение слоёв 1–3 копится в лавину
 * (партия входит в слой 3 на ~55% hp и кривая проваливается).
 */
const PATCH_UP = 0.5;
/** Привал: доля недостающего hp. */
const REST_HEAL = 0.6;
/** Наёмник приходит потрёпанным. */
const MERC_HP = 0.6;

// ---- Генерация карты ----

/** Слои карты; порядок узлов внутри слоя тасуется сидом. */
const LAYER_KINDS: NodeKind[][] = [
  ['lesson'],
  ['fight', 'fight'],
  ['scriptorium', 'event'],
  ['fight', 'elite', 'fight'],
  // привал в середине (по симу фазы 5 бóльшая часть смертей — слой 5),
  // событие перед боссом — шанс нанять наёмника на финал; привал там был бы
  // мёртвым выбором: в бой с боссом партия и так входит отдохнувшей
  ['rest', 'scriptorium'],
  ['elite', 'fight'],
  ['event', 'scriptorium'],
  ['boss'],
];

/** Рёбра слоя wa → wb: каждый узел ведёт в 1–2 узла, все узлы достижимы. */
function edgeSlots(wa: number, wb: number, ai: number): number[] {
  if (wb === 1) return [0];
  const base = Math.round((ai * (wb - 1)) / Math.max(wa - 1, 1));
  const out = [base];
  if (base + 1 < wb) out.push(base + 1);
  else if (base - 1 >= 0) out.push(base - 1);
  return out.sort((a, b) => a - b);
}

export function generateMap(runSeed: number): MapNode[] {
  const rng = mulberry32(runSeed * 271 + 13);
  const layers = LAYER_KINDS.map((kinds) => shuffle(kinds, rng));
  const map: MapNode[] = [];
  const layerStart: number[] = [];
  let id = 0;
  for (const [layer, kinds] of layers.entries()) {
    layerStart.push(id);
    for (const [slot, kind] of kinds.entries()) {
      map.push({ id: id++, layer, slot, kind, next: [] });
    }
  }
  for (const node of map) {
    const nextKinds = layers[node.layer + 1];
    if (!nextKinds) continue;
    const wa = layers[node.layer]!.length;
    node.next = edgeSlots(wa, nextKinds.length, node.slot).map(
      (s) => layerStart[node.layer + 1]! + s,
    );
  }
  return map;
}

// ---- Состав врагов по узлам ----

export function foesForNode(node: MapNode): UnitSpec[] {
  switch (node.kind) {
    case 'lesson':
      // урок учит петле «перепиши и переиграй»: дефолт «все бьют ближайшего»
      // должен проигрывать примерно каждый второй бой, а кайт-переформулировка
      // (онбординг даёт слово «держать дистанцию») — переворачивать большинство
      // поражений; переигрывается бесплатно, стеной быть не должен
      return [packLeader(), grunt(1), grunt(2), archer(1)];
    case 'fight':
      if (node.layer <= 1)
        return node.slot === 0
          ? [berserker(1), grunt(1), grunt(2), archer(1)]
          : [packLeader(), berserker(1), archer(1)];
      if (node.layer <= 3)
        return node.slot === 0
          ? [grunt(1), grunt(2), archer(1)]
          : [grunt(1), grunt(2), grunt(3)];
      return [berserker(1), grunt(1), grunt(2), archer(1)];
    case 'elite':
      return node.layer <= 3
        ? [grunt(1), grunt(2), shaman('grunt1')]
        : [warChief(), shaman('chief'), archer(1)];
    case 'boss':
      // подобрано симом: 4-й враг делает бой нерешаемым (экономика действий);
      // охотник вместо берсерка — свита достаёт и кайтящих стрелков (после
      // появления «держать дистанцию» чисто ближняя свита проседала до ~46%)
      return [warlord(), shaman('warlord'), hunter(1)];
    default:
      throw new Error(`Узел ${node.kind} — не бой`);
  }
}

/** Узлы, где перед боем видны принципы врагов (разведка). */
export function intelVisible(node: MapNode): boolean {
  return node.kind === 'elite' || node.kind === 'boss' || node.kind === 'lesson';
}

/**
 * Боевые спеки врагов текущего узла с применённой меткой. Единая точка для
 * playFight и UI: бой на экране и бой в забеге обязаны быть одним боем.
 */
export function foeSpecs(state: RunState): UnitSpec[] {
  return foesForNode(currentNode(state)).map((f) =>
    f.id === state.marked ? { ...f, tags: [...(f.tags ?? []), 'marked'] } : f,
  );
}

/** Пометить врага текущего боевого узла (null — снять метку). */
export function setMark(state: RunState, foeId: string | null): SetPhrasesResult {
  const node = currentNode(state);
  if (!FIGHT_KINDS.includes(node.kind) || state.resolved) {
    return { ok: false, error: 'Метка ставится перед боем' };
  }
  if (foeId !== null && !foesForNode(node).some((f) => f.id === foeId)) {
    return { ok: false, error: `На этом поле нет врага ${foeId}` };
  }
  state.marked = foeId;
  return { ok: true };
}

// ---- Старт и доступ ----

export function startRun(runSeed: number): RunState {
  const partyRng = mulberry32(runSeed * 577 + 11);
  const lensRng = mulberry32(runSeed * 353 + 29);
  const party = pickParty(partyRng);
  const heroes: HeroState[] = party.map((arch, slot) => ({
    id: arch.id,
    archetypeId: arch.id,
    name: arch.name,
    lenses: rollLenses(lensRng),
    stats: { ...arch.stats, spawn: { ...PARTY_SPAWNS[slot]! } },
    alive: true,
    hp: arch.stats.maxHp,
    slots: START_SLOTS,
    phrases: defaultPhrasesFor(arch, party),
  }));
  return {
    runSeed,
    map: generateMap(runSeed),
    at: 0,
    resolved: false,
    vocab: STARTING_VOCAB.slice(),
    heroes,
    marked: null,
    pendingReward: null,
    status: 'ongoing',
    log: [],
  };
}

export function currentNode(state: RunState): MapNode {
  return state.map[state.at]!;
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
      lenses: h.lenses,
      // приказы + врождённая способность архетипа; линзы искажают и её
      rules: [...compileHero(state, h), ...heroArchetype(h.archetypeId).innate],
      hp: h.hp,
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

// ---- Прохождение узлов ----

export function battleSeed(state: RunState): number {
  return state.runSeed * 101 + state.at;
}

/**
 * Пара закрытых концептов на выбор: одно простое слово + одно глубокое
 * (если пул пуст — добираем из другого). Детерминировано rng.
 */
function conceptPair(state: RunState, rng: Rng): ConceptId[] {
  const locked = (pool: readonly ConceptId[]): ConceptId[] =>
    shuffle(pool.filter((c) => !state.vocab.includes(c)), rng);
  const core = locked(CORE_WORDS);
  const deep = locked(DEEP_WORDS);
  const out: ConceptId[] = [];
  out.push(...[core[0] ?? deep[1], deep[0] ?? core[1]].filter((c): c is ConceptId => c !== undefined));
  return out;
}

const FIGHT_KINDS: NodeKind[] = ['lesson', 'fight', 'elite', 'boss'];

/**
 * Сыграть боевой узел. Пермасмерть; hp переносится (после победы — перевязка).
 * Урок (первый узел) на поражение не кончает забег: переписывай приказ и
 * переигрывай с теми же костями, сколько нужно.
 */
export function playFight(state: RunState): BattleResult {
  const node = currentNode(state);
  if (state.status !== 'ongoing' || state.resolved || !FIGHT_KINDS.includes(node.kind)) {
    throw new Error('Сейчас не боевой узел');
  }
  if (node.kind === 'boss' && state.heroes.some((h) => h.alive && h.hp < h.stats.maxHp)) {
    // канун битвы: босс — задача на контр-формулировку, а не проверка запаса hp
    // (по симу фазы 5 недолеченная партия проигрывает любым билдом);
    // истощение забега остаётся в потерях — погибших канун не воскрешает
    for (const h of state.heroes) {
      if (h.alive) h.hp = h.stats.maxHp;
    }
    state.log.push('Канун битвы: лагерь и перевязка — в бой со свежими силами');
  }
  const result = runBattle(battleSeed(state), [...heroSpecs(state), ...foeSpecs(state)]);

  if (result.winner !== 'party') {
    if (node.kind === 'lesson') {
      // онбординг даёт слово для контр-формулировки: кайт-переписывание
      // (kiteRewrite) выражается только концептом «держать дистанцию»
      if (!state.vocab.includes('act.standoff')) {
        state.vocab.push('act.standoff');
        state.log.push('Урок: поражение. В дневник вписано новое слово — «держать дистанцию».');
      }
      state.log.push('Урок: поражение. Перепиши приказ и переиграй с теми же костями.');
    } else {
      state.status = 'lost';
      state.log.push(`Забег окончен: поражение (узел ${state.at})`);
    }
    return result;
  }

  if (node.kind === 'lesson') {
    // урок — пролог без последствий: раны и потери не переносятся в забег
    state.resolved = true;
    state.pendingReward = fightReward(state);
    state.log.push('Урок пройден — раны перевязаны, забег начинается');
    return result;
  }

  for (const u of result.units) {
    if (u.side !== 'party') continue;
    const hero = state.heroes.find((h) => h.id === u.id)!;
    if (!u.alive) {
      hero.alive = false;
      hero.hp = 0;
      state.log.push(`✝ ${hero.name} погибает (узел ${state.at})`);
    } else {
      hero.hp = Math.min(u.hp + Math.ceil(hero.stats.maxHp * PATCH_UP), hero.stats.maxHp);
    }
  }
  state.resolved = true;
  if (node.kind === 'boss') {
    state.status = 'won';
    state.log.push('Вождь орды пал. Забег пройден!');
  } else {
    state.pendingReward = fightReward(state);
    state.log.push(`Узел ${state.at}: победа за ${result.rounds} раундов`);
  }
  return result;
}

// ---- Трофей боя ----

/** Трофей за победу: пара закрытых слов на выбор; null — открывать нечего. */
function fightReward(state: RunState): ConceptId[] | null {
  const rng = mulberry32(state.runSeed * 449 + state.at * 31 + 7);
  const pair = conceptPair(state, rng);
  return pair.length > 0 ? pair : null;
}

export type RewardChoice = { kind: 'concept'; id: ConceptId } | { kind: 'skip' };

/** Забрать (или отвергнуть) трофей боя. Пока трофей не решён, дальше не уйти. */
export function claimReward(state: RunState, choice: RewardChoice): SetPhrasesResult {
  if (!state.pendingReward) return { ok: false, error: 'Трофея нет' };
  if (choice.kind === 'concept') {
    if (!state.pendingReward.includes(choice.id)) return { ok: false, error: 'Такого трофея нет' };
    state.vocab.push(choice.id);
    state.log.push(`Трофей: открыт концепт ${choice.id}`);
  } else {
    state.log.push('Трофей оставлен на поле');
  }
  state.pendingReward = null;
  return { ok: true };
}

/** Переход по ребру карты после пройденного узла. */
export type AdvanceResult = { ok: true } | { ok: false; error: string };

export function advance(state: RunState, toId: number): AdvanceResult {
  if (state.status !== 'ongoing') return { ok: false, error: 'Забег окончен' };
  if (!state.resolved) return { ok: false, error: 'Текущий узел ещё не пройден' };
  if (state.pendingReward) return { ok: false, error: 'Сначала реши судьбу трофея' };
  if (!currentNode(state).next.includes(toId)) return { ok: false, error: 'Туда дороги нет' };
  state.at = toId;
  state.resolved = false;
  state.marked = null; // новый узел — новые враги, метка не переносится
  return { ok: true };
}

// ---- Скрипторий ----

export interface ScriptoriumOffer {
  concepts: ConceptId[];
  /** Герой, которому можно докупить слот (если есть кому). */
  slotHero?: string;
}

/** Предложение скриптория: простое + глубокое слово, плюс слот (детерминировано сидом). */
export function scriptoriumOffer(state: RunState): ScriptoriumOffer {
  if (currentNode(state).kind !== 'scriptorium') throw new Error('Сейчас не скрипторий');
  const rng = mulberry32(state.runSeed * 997 + state.at);
  const concepts = conceptPair(state, rng);
  const slotHero = state.heroes.find((h) => h.alive && h.slots < MAX_SLOTS)?.id;
  return { concepts, ...(slotHero ? { slotHero } : {}) };
}

export type ScriptoriumChoice =
  | { kind: 'concept'; id: ConceptId }
  | { kind: 'slot'; heroId: string }
  | { kind: 'skip' };

export function chooseInScriptorium(state: RunState, choice: ScriptoriumChoice): SetPhrasesResult {
  const offer = scriptoriumOffer(state);
  if (state.resolved) return { ok: false, error: 'Узел уже пройден' };
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
  state.resolved = true;
  return { ok: true };
}

// ---- Привал ----

export function rest(state: RunState): SetPhrasesResult {
  if (currentNode(state).kind !== 'rest') return { ok: false, error: 'Сейчас не привал' };
  if (state.resolved) return { ok: false, error: 'Узел уже пройден' };
  for (const h of state.heroes) {
    if (!h.alive) continue;
    h.hp = Math.min(h.hp + Math.ceil((h.stats.maxHp - h.hp) * REST_HEAL), h.stats.maxHp);
  }
  state.resolved = true;
  state.log.push('Привал: раны перевязаны');
  return { ok: true };
}

// ---- События ----

const MERC_NAMES = ['Крад', 'Вельма', 'Осса', 'Бор'];

/** Одинаковый ли набор линз (порядок не важен — наёмник обязан читать иначе). */
function sameLenses(a: readonly LensId[], b: readonly LensId[]): boolean {
  return [...a].sort().join() === [...b].sort().join();
}

export interface EventOffer {
  /** Базовое предложение узла (детерминировано сидом). */
  kind: 'bookseller' | 'cache';
  /** Книжник: концепт задаром. */
  concept?: ConceptId;
  /** Тайник: +1 слот герою. */
  slotHero?: string;
  /** Наёмник у костра — только если есть погибший герой. */
  mercenary?: { heroId: string; name: string; lenses: LensId[] };
}

export function eventOffer(state: RunState): EventOffer {
  if (currentNode(state).kind !== 'event') throw new Error('Сейчас не событие');
  const rng = mulberry32(state.runSeed * 613 + state.at);
  const locked = shuffle(
    UNLOCKABLE.filter((c) => !state.vocab.includes(c)),
    rng,
  );
  const slotHero = state.heroes.find((h) => h.alive && h.slots < MAX_SLOTS)?.id;
  const kind: EventOffer['kind'] = locked.length > 0 && (rng() < 0.5 || !slotHero) ? 'bookseller' : 'cache';
  const offer: EventOffer = { kind };
  if (kind === 'bookseller' && locked[0]) offer.concept = locked[0];
  if (kind === 'cache' && slotHero) offer.slotHero = slotHero;

  const dead = state.heroes.find((h) => !h.alive);
  if (dead) {
    const name = MERC_NAMES[Math.floor(rng() * MERC_NAMES.length)]!;
    const lenses = rollLenses(rng);
    if (sameLenses(lenses, dead.lenses)) {
      // тот же набор — подменяем первую линзу, чтобы принципы точно читались иначе
      lenses[0] = LENS_POOL.find((l) => !lenses.includes(l))!;
    }
    offer.mercenary = { heroId: dead.id, name, lenses };
  }
  return offer;
}

export type EventChoice = { kind: 'take' } | { kind: 'hire' } | { kind: 'skip' };

export function chooseInEvent(state: RunState, choice: EventChoice): SetPhrasesResult {
  const offer = eventOffer(state);
  if (state.resolved) return { ok: false, error: 'Узел уже пройден' };
  if (choice.kind === 'skip') {
    state.log.push('Событие пропущено');
  } else if (choice.kind === 'take') {
    if (offer.concept) {
      state.vocab.push(offer.concept);
      state.log.push(`Книжник: открыт концепт ${offer.concept}`);
    } else if (offer.slotHero) {
      const hero = state.heroes.find((h) => h.id === offer.slotHero)!;
      hero.slots++;
      state.log.push(`Тайник: ${hero.name} +1 слот (${hero.slots})`);
    } else {
      return { ok: false, error: 'Брать нечего' };
    }
  } else {
    if (!offer.mercenary) return { ok: false, error: 'Наёмника нет' };
    const hero = state.heroes.find((h) => h.id === offer.mercenary!.heroId)!;
    hero.alive = true;
    hero.name = offer.mercenary.name;
    hero.lenses = offer.mercenary.lenses;
    hero.hp = Math.ceil(hero.stats.maxHp * MERC_HP);
    state.log.push(
      `${hero.name} [${hero.lenses.join('+')}] встаёт в строй — прежние принципы он прочтёт по-своему`,
    );
  }
  state.resolved = true;
  return { ok: true };
}
