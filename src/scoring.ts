import {
  type Preference,
  type Rule,
  type Selector,
  alliesOf,
  describePreference,
  enemiesOf,
  evalCondition,
  resolveAlly,
  resolvePosRef,
  resolveSelector,
} from './ir.js';
import { type CompiledBehavior, biasFor } from './lens.js';
import { type NerveSpec, nervePressure, nerveRoll } from './nerve.js';
import {
  type EntryCost,
  GRID_H,
  GRID_W,
  dist,
  distanceField,
  hasLoS,
  hasTerrainCover,
  inBounds,
  isFlanking,
  posEq,
  posInZone,
  posKey,
  reachableTiles,
  zoneAnchor,
  zoneDist,
} from './grid.js';
import type { HazardKind, Tile } from './terrain.js';
import type {
  ActionKind,
  CombatUnit,
  DamageType,
  Pos,
  SaveKind,
  WeaponMove,
  WeaponSpec,
  Zone,
} from './types.js';
import {
  ACTION_BIAS_WEIGHT,
  NERVE_FOCUS_CALM,
  APPEAL_FLOOR,
  WEAPON_AFFINITY_BONUS,
  AP_PER_TURN,
  AP_VALUE,
  COVER,
  DETOUR_APPEAL,
  DETOUR_APPEAL_MIN,
  DETOUR_FREE,
  FULL_COVER,
  BAIT_COVER,
  HARD_PIERCE,
  HAZARD_DMG,
  HIGH_GROUND_DMG,
  INTERCEPT_APPEAL,
  OFTEN_STANCE_BONUS,
  QUARRY_BIAS,
  RIPOSTE_DMG,
  SELFLESS_ATK_MULT,
  SELFLESS_VULN_MULT,
  TAUNT_PULL,
  TERRAIN_COVER,
  WEAK_ATK_MULT,
  ZONE_BIAS,
  DEFAULT_AC,
  DEFAULT_ATK_BONUS,
  DEFAULT_SAVE,
  applyDefenses,
  expectedAttackMult,
  expectedDamage,
  expectedSaveMult,
} from './tuning.js';

export interface Fighter extends CombatUnit {
  compiled: CompiledBehavior;
}

export type { ActionKind };

/** Цена действия в очках хода. `wait` бесплатен и завершает ход. */
export const AP_COST: Record<ActionKind, number> = {
  move: 1,
  carefulStep: 1,
  weakAttack: 1,
  // за 2 AP толчок конкурировал бы с полным ударом и был бы мёртв вне шипов;
  // за 1 AP «сдвинуть и добить» — нормальный ход
  shove: 1,
  cover: 1,
  // войти в ярость — короткий рык, а не замах: дорогая часть — размен
  // «получаю больнее до конца боя», а не очки хода
  rage: 1,
  // финт — короткий обман, а не удар: дешёвый сетап под удары своих
  feint: 1,
  // обмен местами — договорённость, а не перенос: цену платит только
  // затевающий, ход подопечного не тратится. За 2 AP приём не окупался бы
  // никогда — вытащить своего стоило бы партии дороже, чем принять удар
  swap: 1,
  aoeBlast: 2,
  aoeLine: 2,
  attack: 2,
  selflessAttack: 2,
  shieldAlly: 2,
  wall: 2,
  heal: 2,
  bless: 2,
  fullCover: 3,
  // замах — весь ход: зона объявлена, бьёт в начале следующего хода кастера
  aoeRitual: 3,
  wait: 0,
};

/**
 * Цена действия для конкретного юнита. Отклонения от констант:
 * - осторожный шаг медленному (`move: 1`) стоит 2 AP — он не может за ход и
 *   осторожно зайти на шипы, и нормально ударить;
 * - глухая защита бастиону (пассив «незыблемость») — 2 AP: его «сегодня не
 *   воюю» дешевле, чем у всех.
 */
export function apCostFor(action: ActionKind, u: CombatUnit): number {
  if (action === 'carefulStep' && u.move <= 1) return 2;
  if (action === 'fullCover' && u.passives?.steadfast) return 2;
  return AP_COST[action];
}

/** Множитель урона по виду атаки; 0 — действие не атака (залп — не атака: бьёт площадь, не цель). */
const ATTACK_MULT: Record<ActionKind, number> = {
  weakAttack: WEAK_ATK_MULT,
  attack: 1,
  selflessAttack: SELFLESS_ATK_MULT,
  move: 0,
  carefulStep: 0,
  shove: 0,
  aoeBlast: 0,
  aoeLine: 0,
  aoeRitual: 0,
  rage: 0,
  wall: 0,
  heal: 0,
  bless: 0,
  feint: 0,
  swap: 0,
  cover: 0,
  fullCover: 0,
  shieldAlly: 0,
  wait: 0,
};

/** Доля снятого входящего урона по виду действия; 0 — действие не прикрывает. */
const COVER_LEVEL: Record<ActionKind, number> = {
  cover: COVER,
  fullCover: FULL_COVER,
  shieldAlly: COVER,
  move: 0,
  carefulStep: 0,
  weakAttack: 0,
  attack: 0,
  selflessAttack: 0,
  shove: 0,
  aoeBlast: 0,
  aoeLine: 0,
  aoeRitual: 0,
  rage: 0,
  // стена кроет группу — своя ветка исполнения, генерическая не нужна
  wall: 0,
  heal: 0,
  bless: 0,
  feint: 0,
  swap: 0,
  wait: 0,
};

/**
 * Оружия юнита: явный список — или неявное оружие из atk/range («голые»
 * юниты тестов и сценариев Ворот A). Кандидат атаки несёт индекс оружия
 * (`Candidate.weapon`) — урон и дальность атака считает по своему оружию,
 * а производные atk/range юнита (максимумы) остаются мерой угрозы.
 */
export function weaponsOf(u: CombatUnit): WeaponSpec[] {
  return u.weapons && u.weapons.length > 0
    ? u.weapons
    : [{ name: '', dmg: u.atk, range: u.range, aoe: u.aoe }];
}

/**
 * Приёмы оружия (план weapon-moves): явный кит — или дефолт-тройка
 * «тычок/удар/размен» с общими числами манер. Дефолт кэшируется по объекту
 * оружия и в точности повторяет прежнюю универсальную тройку — поведение
 * юнитов без кита не сдвигается ни на волос.
 */
const DEFAULT_MOVES = new WeakMap<WeaponSpec, WeaponMove[]>();
export function movesOf(w: WeaponSpec): WeaponMove[] {
  if (w.moves && w.moves.length > 0) return w.moves;
  let d = DEFAULT_MOVES.get(w);
  if (!d) {
    d = [
      { id: 'jab', name: 'тычок', slot: 'weakAttack', mult: w.weakMult ?? WEAK_ATK_MULT },
      { id: 'strike', name: 'удар', slot: 'attack', mult: 1 },
      { id: 'allin', name: 'размен', slot: 'selflessAttack', mult: SELFLESS_ATK_MULT, expose: true },
    ];
    DEFAULT_MOVES.set(w, d);
  }
  return d;
}

/** КБ цели (план damage-types): против него бросается атака. */
export const acOf = (u: CombatUnit): number => u.defenses?.ac ?? DEFAULT_AC;

/** Спасбросок юнита нужного вида. */
export const saveOf = (u: CombatUnit, kind: SaveKind): number => u.defenses?.[kind] ?? DEFAULT_SAVE;

/** Бонус атаки оружия. */
export const attackBonusOf = (w: WeaponSpec): number => w.atkBonus ?? DEFAULT_ATK_BONUS;

/**
 * Каким спасброском отбиваются от урона этого типа: яд — Стойкостью, разум —
 * Волей, всё остальное (взрывы, полосы, зоны) — Реакцией.
 */
export const saveKindFor = (t?: DamageType): SaveKind =>
  t === 'poison' ? 'fort' : t === 'mental' ? 'will' : 'ref';

/**
 * Тип урона удара (план damage-types): приём перебивает оружие. Общая для
 * скоринга и боя — оценка и исполнение обязаны говорить об одном типе.
 */
export function dmgTypeOf(weapon: WeaponSpec, move: WeaponMove): DamageType | undefined {
  return move.dmgType ?? weapon.dmgType;
}

/** Клетка, куда толчок сдвигает цель: ровно на 1 строго от толкающего. */
export function shoveDest(pusher: Pos, target: Pos): Pos {
  return {
    x: target.x + Math.sign(target.x - pusher.x),
    y: target.y + Math.sign(target.y - pusher.y),
  };
}

/** Радиус залпа: 3×3 вокруг центра (Чебышёв). */
export const AOE_BLAST_RADIUS = 1;

/** Радиус ритуала: 5×5 вокруг центра (Чебышёв). */
export const AOE_RITUAL_RADIUS = 2;

/** Радиус зоны по виду каста. */
export const aoeRadius = (a: ActionKind): number => (a === 'aoeRitual' ? AOE_RITUAL_RADIUS : AOE_BLAST_RADIUS);

/** Глубина точки в зоне ритуала: 1 в центре, ~0.33 у края. */
export const ritualDepth = (p: Pos, center: Pos): number =>
  (AOE_RITUAL_RADIUS + 1 - dist(p, center)) / (AOE_RITUAL_RADIUS + 1);

/**
 * Клетки линии («волны клинка»): от from в направлении dir (единичный вектор,
 * 8 направлений), длиной len. Камень и край поля обрывают взмах; тела — нет.
 */
export function lineCells(from: Pos, dir: Pos, len: number, blocked: (p: Pos) => boolean): Pos[] {
  const out: Pos[] = [];
  for (let i = 1; i <= len; i++) {
    const p = { x: from.x + dir.x * i, y: from.y + dir.y * i };
    if (!inBounds(p) || blocked(p)) break;
    out.push(p);
  }
  return out;
}

/**
 * Жертвы каста-кандидата: для залпа и ритуала — зона вокруг центра `at`, для
 * линии `at` — смежная клетка-направление, жертвы на клетках взмаха.
 */
export function castVictims<T extends CombatUnit>(
  action: ActionKind,
  at: Pos,
  self: CombatUnit,
  units: readonly T[],
  blocked: (p: Pos) => boolean,
): T[] {
  if (action === 'aoeLine') {
    const dir = { x: Math.sign(at.x - self.pos.x), y: Math.sign(at.y - self.pos.y) };
    const cells = lineCells(self.pos, dir, self.aoe?.line?.len ?? 0, blocked);
    return units.filter((u) => u.alive && cells.some((c) => posEq(c, u.pos)));
  }
  return aoeVictims(at, units, aoeRadius(action));
}

/**
 * Готов ли ритуал юнита в этом раунде: нет висящей зоны, перезарядка прошла,
 * лимит применений на бой не выбран.
 */
export function ritualReady(u: CombatUnit, round: number): boolean {
  const ritual = u.aoe?.ritual;
  if (!ritual || u.pendingRitual) return false;
  if (ritual.cooldown && u.lastRitualRound !== undefined && round - u.lastRitualRound < ritual.cooldown) return false;
  if (ritual.usesPerBattle !== undefined && (u.ritualUses ?? 0) >= ritual.usesPerBattle) return false;
  return true;
}

/** Готов ли залп: лимит применений на бой не выбран. */
export function blastReady(u: CombatUnit): boolean {
  const blast = u.aoe?.blast;
  if (!blast) return false;
  return blast.usesPerBattle === undefined || (u.blastUses ?? 0) < blast.usesPerBattle;
}

/** Готова ли ярость: есть актив и юнит ещё не в ней (она до конца боя). */
export function rageReady(u: CombatUnit): boolean {
  return !!u.active?.rage && !u.raged;
}

/** Готова ли стена: есть актив и лимит на бой не выбран. */
export function wallReady(u: CombatUnit): boolean {
  const wall = u.active?.wall;
  return !!wall && (u.wallUses ?? 0) < wall.usesPerBattle;
}

/** Готово ли исцеление: есть актив и лимит на бой не выбран. */
export function healReady(u: CombatUnit): boolean {
  const heal = u.active?.heal;
  return !!heal && (u.healUses ?? 0) < heal.usesPerBattle;
}

/** Готово ли благословение: есть актив и лимит на бой не выбран. */
export function blessReady(u: CombatUnit): boolean {
  const bless = u.active?.bless;
  return !!bless && (u.blessUses ?? 0) < bless.usesPerBattle;
}

/** Множитель урона атак благословлённого — до конца боя, как ярость. */
export const blessMult = (u: CombatUnit): number => u.blessedMult ?? 1;

/**
 * Множитель урона атаки из тени (пассив Мары): действует, пока из клетки
 * from юнита не держит на прицеле ни один вражеский стрелок (дальность + LoS
 * сквозь камни и тела — та же геометрия, что у слова «вне линии огня»).
 */
export function shadowMult(
  self: CombatUnit,
  from: Pos,
  units: readonly CombatUnit[],
  blocked: (p: Pos) => boolean,
): number {
  const mult = self.passives?.shadow?.mult;
  if (!mult) return 1;
  const spotted = units.some(
    (e) =>
      e.alive &&
      e.side !== self.side &&
      e.range > 1 &&
      dist(e.pos, from) <= e.range &&
      hasLoS(e.pos, from, (p) =>
        blocked(p) || units.some((u) => u.alive && u !== self && u !== e && posEq(u.pos, p)),
      ),
  );
  return spotted ? 1 : mult;
}

/**
 * Множитель кары (пассив Зари): атаки ×mult по врагу, чей удар последним
 * получил кто-то из живых союзников (канал lastAttackerId — тот же, что у
 * селектора «кто атаковал меня»).
 */
export function retributionMult(self: CombatUnit, target: CombatUnit, units: readonly CombatUnit[]): number {
  const mult = self.passives?.retribution?.mult;
  if (!mult) return 1;
  const guilty = units.some(
    (a) => a.alive && a.side === self.side && a.lastAttackerId === target.id,
  );
  return guilty ? mult : 1;
}

/** Множитель своего урона от ярости (атаки оружием; касты не трогает). */
export const rageDmgMult = (u: CombatUnit): number => (u.raged ? u.active?.rage?.dmgMult ?? 1 : 1);

/** Множитель входящего урона по яростному — применяется везде, как exposed. */
export const rageVulnMult = (u: CombatUnit): number => (u.raged ? u.active?.rage?.vulnMult ?? 1 : 1);

/** Живые юниты обеих сторон в зоне — friendly fire включён для всех. */
export function aoeVictims<T extends CombatUnit>(
  center: Pos,
  units: readonly T[],
  radius: number = AOE_BLAST_RADIUS,
): T[] {
  return units.filter((u) => u.alive && dist(u.pos, center) <= radius);
}

/**
 * Действующее прикрытие цели: своё действие плюс выданное союзником — второе
 * живо, только пока защитник жив и смежен с прикрытым. Проверка в момент
 * чтения (как у перехвата): уведённый толчком подопечный или ушедший/павший
 * щитоносец гасят чужое прикрытие сами собой, своё остаётся.
 */
export function effectiveCover(target: CombatUnit, units: readonly CombatUnit[]): number {
  // стойка приманки (план words): готов нырнуть — плавающее прикрытие
  const own = Math.max(target.coverLevel, target.stance?.bait ? BAIT_COVER : 0);
  const g = target.guardedBy;
  if (!g) return own;
  const protector = units.find((u) => u.id === g.id);
  const held = protector !== undefined && protector.alive && dist(protector.pos, target.pos) <= 1;
  return Math.max(own, held ? g.level : 0);
}

/** Стойки манер юнита из сработавших правил решения (план words + teamwork). */
export function stanceOf(
  fired: readonly Rule[],
): { often: boolean; hard: boolean; bait: boolean; taunt: boolean; mark: boolean } {
  return {
    often: fired.some((r) => r.then.kind === 'strikeOften'),
    hard: fired.some((r) => r.then.kind === 'strikeHard'),
    bait: fired.some((r) => r.then.kind === 'bait'),
    // Стойка метки (третья волна teamwork): пока горит «метить цель», мои
    // удары вешают метку всей стороне — тот же тег и то же снятие прежней,
    // что у пассивки охотника; читает её канал sel.marked
    mark: fired.some((r) => r.then.kind === 'mark'),
    // Стойка провокации (план teamwork): держится до следующего решения, как
    // приманка, — внимание уведено и на чужих ходах. Ставит её ТОЛЬКО «вызывать
    // на себя»: когда стойку ставил и «уводить от X», второе слово поглощало
    // первое (аудит: комбо не сильнее слов по отдельности) и «вызывать»
    // становилось лишним трофеем. Теперь слова ортогональны — вызов забирает
    // внимание, увод двигает того, кто его забрал
    taunt: fired.some((r) => r.then.kind === 'taunt'),
  };
}

type Stance = ReturnType<typeof stanceOf>;

/** Множитель приёма с учётом стойки: «часто» бьёт быстрым темпом крепче. */
export function stanceAttackMult(move: WeaponMove, stance?: Stance | CombatUnit['stance']): number {
  const bonus = stance?.often && move.slot === 'weakAttack' ? OFTEN_STANCE_BONUS : 0;
  return move.mult + bonus;
}

/**
 * Митигация цели с учётом приёма и стойки бьющего: пирс стойки «наверняка»
 * (полный темп) и врождённый пирс приёма не складываются — берётся сильнейший.
 */
export function stanceMitigation(mitigation: number, move: WeaponMove, stance?: Stance | CombatUnit['stance']): number {
  const kept = Math.min(stance?.hard && move.slot === 'attack' ? HARD_PIERCE : 1, move.pierce ?? 1);
  return mitigation * kept;
}

/**
 * Расчётливый удар — не напарывается на рипост глухой обороны: стойка
 * «наверняка» на полном темпе, либо sure/pierce самого приёма.
 */
export function isSureStrike(move: WeaponMove, stance?: Stance | CombatUnit['stance']): boolean {
  return move.sure === true || move.pierce !== undefined || (stance?.hard === true && move.slot === 'attack');
}

/**
 * Урон площадного каста по цели: фиксированный, строго без rng (прецедент
 * шипов — новый вызов rng() сдвинул бы последовательность боя и переписал
 * фикстуры; и одно число в логе у всех накрытых читается лучше). Каменное
 * укрытие от взрыва не спасает (это не выстрел), прикрытие от действий и
 * открытость — работают.
 */
export function aoeDamage(
  caster: CombatUnit,
  mult: number,
  target: CombatUnit,
  units: readonly CombatUnit[] = [target],
  dmgType?: DamageType,
  /**
   * Доля урона по спасброску цели (план damage-types): бой передаёт брошенную
   * (0 / ½ / 1 / 2), скоринг молчит и получает ожидание по всем 20 граням.
   */
  saveMult: number = expectedSaveMult(saveOf(target, saveKindFor(dmgType))),
): number {
  const base =
    expectedDamage(caster.atk) *
    mult *
    (1 - effectiveCover(target, units)) *
    (target.exposed ? SELFLESS_VULN_MULT : 1) *
    rageVulnMult(target) *
    saveMult;
  // увернулся начисто — ноль, а не общий пол «минимум 1»
  return applyDefenses(saveMult === 0 ? 0 : Math.max(1, Math.round(base)), dmgType, target.defenses).dmg;
}

/**
 * Проекция позиции юнита на ход вперёд: спуск по полю дистанций к его
 * ближайшей цели на два шага движения (третье очко — на удар), остановка на
 * своей дальности. Детерминированная, без rng: используется манерой
 * «бить на упреждение» — целить ритуал туда, куда враг придёт к залпу.
 */
export function predictedPos(u: Fighter, units: readonly Fighter[], ctx: ScoreCtx): Pos {
  const target = resolveSelector('nearest', u, units);
  if (!target) return u.pos;
  let cur = u.pos;
  for (let i = 0; i < u.move * 2; i++) {
    if (dist(cur, target.pos) <= u.range) break;
    let best = cur;
    let bestD = ctx.distTo(target.pos, cur);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const n = { x: cur.x + dx, y: cur.y + dy };
        if (!inBounds(n) || ctx.blocked(n)) continue;
        const d = ctx.distTo(target.pos, n);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
    }
    if (posEq(best, cur)) break;
    cur = best;
  }
  return cur;
}

/**
 * Суммарный урон висящих зон замаха по юниту, стоящему в p. Считаются зоны
 * ОБЕИХ сторон — friendly fire, своя зона жжёт и своих (и самого кастера).
 * Это канал опасности для уклонения: юниты выходят из зон инстинктом, без
 * отдельного кода — тот же приём, что с шипами.
 */
export function zoneDangerAt(p: Pos, units: readonly CombatUnit[], target: CombatUnit): number {
  let dmg = 0;
  for (const u of units) {
    if (!u.alive || !u.pendingRitual || !u.aoe?.ritual) continue;
    if (dist(u.pendingRitual.at, p) <= AOE_RITUAL_RADIUS) dmg += aoeDamage(u, u.aoe.ritual.mult, target, units);
  }
  return dmg;
}

/** Перемещения: у обоих `to` — новая клетка; осторожный шаг не будит опасность. */
export const isMovement = (a: ActionKind): boolean => a === 'move' || a === 'carefulStep';

export const attackMult = (a: ActionKind): number => ATTACK_MULT[a];

/** Множитель вида атаки для конкретного оружия: кулаки Юны бьют слабым ударом крепче общего. */
export const attackMultFor = (a: ActionKind, w: WeaponSpec): number =>
  a === 'weakAttack' ? w.weakMult ?? WEAK_ATK_MULT : ATTACK_MULT[a];
export const isAttack = (a: ActionKind): boolean => ATTACK_MULT[a] > 0;
export const coverLevelOf = (a: ActionKind): number => COVER_LEVEL[a];

/**
 * Доля хода, которую съедает действие, в единицах обычного удара.
 * Премии правил за атаку умножаются на неё: решение принимается по одному
 * действию за раз, и без нормировки правило платило бы за каждый удар
 * отдельно — тогда выгоднее всего было бы спамить самый дешёвый удар.
 * С нормировкой правило платит за потраченный ход, а выбирать между слабым,
 * обычным и отчаянным ударом остаётся урону и риску.
 */
/**
 * Цена действия кандидата: у приёма кита может быть своя («серия» — весь ход,
 * 3 AP); прочее — apCostFor. Доля от полного удара — candApShare: премии
 * правил за атаку платят за потраченный ход и обязаны видеть цену приёма.
 */
export function candApCost(cand: Candidate, self: CombatUnit): number {
  if (cand.move !== undefined && isAttack(cand.action)) {
    const ap = candMove(self, cand).ap;
    if (ap !== undefined) return ap;
  }
  return apCostFor(cand.action, self);
}
const candApShare = (cand: Candidate, self: CombatUnit): number =>
  candApCost(cand, self) / AP_COST.attack;

export interface Candidate {
  /** Клетка после действия; у всего, кроме шага, — текущая клетка юнита. */
  to: Pos;
  action: ActionKind;
  /** Цель атаки — или прикрываемый союзник для `shieldAlly`. */
  targetId?: string;
  /** Центр зоны площадного каста (`aoeBlast`). */
  at?: Pos;
  /** Индекс оружия атаки в `weaponsOf` — у мастера трёх оружий их несколько. */
  weapon?: number;
  /** Индекс приёма в `movesOf` — только у оружия с явным китом (план weapon-moves). */
  move?: number;
}

export interface Factor {
  label: string;
  value: number;
}

export interface Decision {
  chosen: Candidate;
  score: number;
  /** Топ-3 фактора решения — основа посмертного разбора. */
  factors: Factor[];
  candidateCount: number;
  /** Сколько сработавших правил были условными (when ≠ always) — для метрик. */
  condRules: number;
  /** Сколько правил сработало всего; 0 — решение целиком достроено инстинктами (план линз). */
  firedCount: number;
  /** Стойки манер решения (план words + teamwork) — бой вешает их на юнита до следующего решения. */
  stance: { often: boolean; hard: boolean; bait: boolean; taunt: boolean; mark: boolean };
}

const MAX_DIST = Math.max(GRID_W, GRID_H) - 1;

/** Клетка отрезана террейном от цели — считаем её сколь угодно далёкой. */
const UNREACHABLE = GRID_W * GRID_H;

const NO_TERRAIN = (): boolean => false;
const FLAT = (): number => 0;
const UNIT_COST: EntryCost = () => 1;

/**
 * Контекст решения: террейн боя + кэш BFS-полей дистанций (на одно решение).
 * Тяга к цели ходит по полю, а не по прямой — юниты огибают стены и
 * стягиваются в проходы вместо залипания в локальном минимуме у препятствия.
 */
export interface ScoreCtx {
  blocked: (p: Pos) => boolean;
  /** Высота клетки схемы боя (0 на пустом поле). */
  heightAt: (p: Pos) => number;
  /** Клетки с высотой > 0 — тяга «держать высоту» тянет к ближайшей. */
  highTiles: readonly Pos[];
  /** Труднопроходимая клетка схемы (бурелом, болото). */
  roughAt: (p: Pos) => boolean;
  /** Клетки бурелома — тяга «стеречь кромку» ведёт к ближайшей. */
  roughTiles: readonly Pos[];
  /**
   * Доля урона, снятая каменным укрытием цели при выстреле from → target
   * (0 — укрытия нет). Стрелок с высоты 2 бьёт поверх укрытия.
   */
  coverFrom: (from: Pos, target: Pos) => number;
  /** Цена входа в клетку: бурелом и подъём — 2 очка движения, спуск обычный. */
  entryCost: EntryCost;
  /** Опасность клетки (шипы/огонь); undefined — клетка безопасна. */
  hazardAt: (p: Pos) => HazardKind | undefined;
  /** Путевая дистанция p → target по проходимым клеткам (кэш по цели). */
  distTo: (target: Pos, p: Pos) => number;
  /** Зона задачи боя (план objectives, волна 2); без неё зонные слова молчат. */
  zone?: Zone;
  /** Трофей задачи: где лежит (at) или кто несёт (carrierId); только у задачи carry. */
  prize?: { at: Pos | null; carrierId: string | null };
  /** Слабый фоновый инстинкт зонной задачи для решающего юнита (ZONE_BIAS). */
  zoneInstinct?: boolean;
  /** Режим нерва (план nerve): seeded-разброс весов решения; без него счёт детерминирован. */
  nerve?: NerveSpec;
}

/** Сценарная часть контекста решения (план objectives, волна 2). */
export interface MissionCtx {
  zone?: Zone;
  prize?: { at: Pos | null; carrierId: string | null };
  zoneInstinct?: boolean;
}

export function makeCtx(
  blocked: (p: Pos) => boolean = NO_TERRAIN,
  tiles?: readonly Tile[][],
  mission: MissionCtx = {},
  nerve?: NerveSpec,
): ScoreCtx {
  const fields = new Map<string, Map<string, number>>();
  const highTiles: Pos[] = [];
  const roughTiles: Pos[] = [];
  tiles?.forEach((row, y) =>
    row.forEach((t, x) => {
      if ((t.height ?? 0) > 0) highTiles.push({ x, y });
      if (t.rough) roughTiles.push({ x, y });
    }),
  );
  const heightAt = tiles ? (p: Pos): number => tiles[p.y]?.[p.x]?.height ?? 0 : FLAT;
  const entryCost: EntryCost = tiles
    ? (from, to): number => {
        const t = tiles[to.y]?.[to.x];
        return t?.rough || (t?.height ?? 0) > heightAt(from) ? 2 : 1;
      }
    : UNIT_COST;
  return {
    ...mission,
    ...(nerve && nerve.amp > 0 ? { nerve } : {}),
    blocked,
    heightAt,
    highTiles,
    roughAt: tiles ? (p): boolean => tiles[p.y]?.[p.x]?.rough === true : NO_TERRAIN,
    roughTiles,
    coverFrom: (from, target) =>
      heightAt(from) === 2 ? 0 : hasTerrainCover(from, target, blocked) ? TERRAIN_COVER : 0,
    entryCost,
    hazardAt: tiles ? (p): HazardKind | undefined => tiles[p.y]?.[p.x]?.hazard : () => undefined,
    distTo(target, p) {
      const key = posKey(target);
      let field = fields.get(key);
      if (!field) {
        field = distanceField(target, blocked, entryCost);
        fields.set(key, field);
      }
      return field.get(posKey(p)) ?? UNREACHABLE;
    },
  };
}

function isBlockedBy(units: readonly Fighter[], except: Fighter): (p: Pos) => boolean {
  return (p) => units.some((u) => u.alive && u !== except && posEq(u.pos, p));
}

/** ZoC проецируют живые враги ближнего боя (range 1) на смежные клетки. */
function zocOf(self: Fighter, units: readonly Fighter[]): (p: Pos) => boolean {
  const melee = enemiesOf(self, units).filter((e) => e.range === 1);
  return (p) => melee.some((e) => dist((e as Fighter).pos, p) === 1);
}

/** Дальность атаки с учётом высоты клетки: стрелку холм добавляет +height. */
export function rangeAt(u: CombatUnit, height: number, wRange: number = u.range): number {
  return wRange > 1 ? wRange + height : wRange;
}

/** Плоский бонус урона стрелка с высоты 2 («бью сверху»). */
export function heightDmgBonus(u: CombatUnit, height: number, wRange: number = u.range): number {
  return wRange > 1 && height === 2 ? HIGH_GROUND_DMG : 0;
}

function canAttackFrom(
  from: Pos,
  attacker: Fighter,
  target: Fighter,
  units: readonly Fighter[],
  blocked: (p: Pos) => boolean,
  height = 0,
  // дальность конкретного оружия; по умолчанию — производный максимум юнита
  // (проверки «докуда вообще достаёт», например премия шагу под выстрел)
  wRange: number = attacker.range,
): boolean {
  const d = dist(from, target.pos);
  if (d > rangeAt(attacker, height, wRange)) return false;
  if (wRange === 1) return d === 1;
  // камень, смежный цели, — не стена, а укрытие (гибрид Q-2): выстрел проходит,
  // урон режет coverFrom; тела по-прежнему заслоняют полностью
  return hasLoS(
    from,
    target.pos,
    (p) =>
      (blocked(p) && dist(p, target.pos) > 1) ||
      units.some((u) => u.alive && u !== attacker && u !== target && posEq(u.pos, p)),
  );
}

/**
 * Кандидаты на **одно** действие при остатке `ap`. Шаг — отдельное действие,
 * поэтому атаки и прикрытия считаются из текущей клетки: связку «дойти и
 * ударить» набирает жадный цикл `decide` по одному действию за раз.
 */
export function generateCandidates(
  self: Fighter,
  units: readonly Fighter[],
  ctx: ScoreCtx = makeCtx(),
  ap: number = AP_PER_TURN,
  round = 1,
  // правила для гейтов слов (толчок, касты): decide передаёт СРАБОТАВШИЕ —
  // «если враги накатывают — накрыть скопление» открывает касты только при
  // накате, а не самим фактом правила в приказах
  fired: readonly Rule[] = self.compiled.rules,
): Candidate[] {
  const here = self.pos;
  const { blocked } = ctx;
  const out: Candidate[] = [];
  // нулевая тяга характера — не «маловероятно», а «никогда»: фанатик за щитом
  // не отсиживается вовсе, и обсуждать этот вариант незачем
  const allowed = (a: ActionKind): boolean => biasFor(self.compiled.instincts, a) !== 0;

  const byUnit = isBlockedBy(units, self);
  const occupied = (p: Pos): boolean => byUnit(p) || blocked(p);
  if (ap >= AP_COST.move) {
    const zoc = zocOf(self, units);
    for (const to of reachableTiles(here, self.move, occupied, zoc, ctx.entryCost)) {
      if (!posEq(to, here)) out.push({ to, action: 'move' });
    }
  }

  // осторожный шаг: ровно одна клетка, опасность не срабатывает. Предлагается
  // только на опасные клетки — на чистых он ничем не лучше обычного шага
  if (ap >= apCostFor('carefulStep', self) && allowed('carefulStep')) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const to = { x: here.x + dx, y: here.y + dy };
        if (ctx.hazardAt(to) && !occupied(to)) out.push({ to, action: 'carefulStep' });
      }
    }
  }

  // атаки — на каждое оружие и каждый его приём (план weapon-moves): мастер
  // трёх оружий сам выбирает копьё против строя и молот в упор; у оружия без
  // кита — дефолт-тройка, кандидаты те же, что раньше
  const weapons = weaponsOf(self);
  for (const e of enemiesOf(self, units) as Fighter[]) {
    for (let wi = 0; wi < weapons.length; wi++) {
      const w = weapons[wi]!;
      const moves = movesOf(w);
      for (let mi = 0; mi < moves.length; mi++) {
        const m = moves[mi]!;
        if (!canAttackFrom(here, self, e, units, blocked, ctx.heightAt(here), m.range ?? w.range)) continue;
        if (ap >= (m.ap ?? AP_COST[m.slot]) && allowed(m.slot)) {
          out.push({
            to: here,
            action: m.slot,
            targetId: e.id,
            ...(weapons.length > 1 ? { weapon: wi } : {}),
            ...(w.moves ? { move: mi } : {}),
          });
        }
      }
    }
  }

  // толчок: цель смежна, сдвиг строго от толкающего; в стену / в занятое /
  // за край не проходит и в кандидаты не попадает вовсе — скоринг не учится
  // «толкаться в стену». Инстинкты толчка не знают: без слова «толкать» в
  // правилах кандидатов нет — иначе поле начало бы играть само
  if (ap >= AP_COST.shove && allowed('shove') && fired.some((r) => r.then.kind === 'shove')) {
    for (const e of enemiesOf(self, units) as Fighter[]) {
      if (dist(here, e.pos) !== 1) continue;
      const dest = shoveDest(here, e.pos);
      if (inBounds(dest) && !blocked(dest) && !units.some((u) => u.alive && posEq(u.pos, dest))) {
        out.push({ to: here, action: 'shove', targetId: e.id });
      }
    }
  }

  // площадные касты: залп (мгновенный, 3×3) и ритуал (телеграф, 5×5, замах
  // весь ход). Оружие — spec.aoe (носителей единицы), гейт — правило «накрыть
  // скопление»: инстинкты каста не знают, без слова кандидатов нет (прецедент
  // толчка — иначе поле играло бы само). Центры — не скан поля, а окрестности
  // врагов: только клетки, где зона накрывает хотя бы одного
  // касты открывает «накрыть скопление» — или манера «замахиваться ритуалом»
  // сама по себе (не требовать от игрока два глубоких слова разом)
  if (self.aoe && fired.some((r) => r.then.kind === 'barrage' || r.then.kind === 'castRitual')) {
    const forms: { action: ActionKind; form?: { range: number }; ready: boolean }[] = [
      { action: 'aoeBlast', form: self.aoe.blast, ready: blastReady(self) },
      { action: 'aoeRitual', form: self.aoe.ritual, ready: ritualReady(self, round) },
    ];
    // с манерой «бить на упреждение» ритуал целит и в проекции движения
    // врагов — без затравки от предсказанных позиций таких кандидатов не было бы
    const preempt = fired.some((r) => r.then.kind === 'preempt');
    for (const { action, form, ready } of forms) {
      if (!form || !ready || ap < AP_COST[action] || !allowed(action)) continue;
      const radius = aoeRadius(action);
      const seen = new Set<string>();
      for (const e of enemiesOf(self, units) as Fighter[]) {
        const seeds =
          action === 'aoeRitual' && preempt ? [e.pos, predictedPos(e, units, ctx)] : [e.pos];
        for (const seed of seeds) {
          for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
              const at = { x: seed.x + dx, y: seed.y + dy };
              const key = posKey(at);
              if (seen.has(key)) continue;
              seen.add(key);
              if (!inBounds(at) || blocked(at) || dist(here, at) > form.range) continue;
              // до центра зоны нужна линия видимости сквозь камни (каменоломня —
              // контр шамана); тела взрыв не заслоняют — он навесной
              if (!hasLoS(here, at, blocked)) continue;
              out.push({ to: here, action, at });
            }
          }
        }
      }
    }

    // линия («волна клинка»): 8 направлений от себя, кандидат — только взмах,
    // задевающий хотя бы одного врага; `at` кодирует направление смежной клеткой
    const line = self.aoe.line;
    if (line && ap >= AP_COST.aoeLine && allowed('aoeLine')) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const at = { x: here.x + dx, y: here.y + dy };
          if (!inBounds(at)) continue;
          const cells = lineCells(here, { x: dx, y: dy }, line.len, blocked);
          if (enemiesOf(self, units).some((e) => cells.some((c) => posEq(c, e.pos)))) {
            out.push({ to: here, action: 'aoeLine', at });
          }
        }
      }
    }
  }

  // ярость: актив носителя (план классов) — гейт тот же, что у кастов:
  // оружие есть всегда, но без сработавшего правила «впасть в ярость»
  // кандидата нет; слово решает КОГДА потратить единственный вход
  if (
    ap >= AP_COST.rage &&
    allowed('rage') &&
    rageReady(self) &&
    fired.some((r) => r.then.kind === 'rage')
  ) {
    out.push({ to: here, action: 'rage' });
  }

  // стена: щитоносец кроет себя и смежных союзников. Своего слова нет —
  // гейт защитными правилами («защищать», «прикрывать отход»): у кого в
  // приказах защита, тот и вспоминает про стену
  if (
    ap >= AP_COST.wall &&
    allowed('wall') &&
    wallReady(self) &&
    fired.some((r) => r.then.kind === 'protect' || r.then.kind === 'coverRetreat')
  ) {
    out.push({ to: here, action: 'wall' });
  }

  // исцеление: целитель лечит раненого союзника (или себя) в дальности
  // актива; кого именно — решает скоринг по нужде. Гейт правилом «лечить»
  if (ap >= AP_COST.heal && allowed('heal') && healReady(self) && fired.some((r) => r.then.kind === 'heal')) {
    const range = self.active!.heal!.range;
    for (const a of alliesOf(self, units) as Fighter[]) {
      if (a.hp < a.maxHp && dist(here, a.pos) <= range) {
        out.push({ to: here, action: 'heal', targetId: a.id });
      }
    }
  }

  // благословение: жрец усиливает атаки союзника до конца боя; себя не
  // благословляет — чудо для других (и так выбор цели проще читается)
  if (ap >= AP_COST.bless && allowed('bless') && blessReady(self) && fired.some((r) => r.then.kind === 'bless')) {
    const range = self.active!.bless!.range;
    for (const a of alliesOf(self, units) as Fighter[]) {
      if (a.id !== self.id && a.blessedMult === undefined && dist(here, a.pos) <= range) {
        out.push({ to: here, action: 'bless', targetId: a.id });
      }
    }
  }

  // финт: открыть смежного врага под удары своих (и свои же). Гейт —
  // правило «финтить» (врождённое у трюкачки); открытого второй раз не финтят
  if (ap >= AP_COST.feint && allowed('feint') && self.active?.feint && fired.some((r) => r.then.kind === 'feint')) {
    for (const e of enemiesOf(self, units) as Fighter[]) {
      if (dist(here, e.pos) === 1 && !e.exposed) {
        out.push({ to: here, action: 'feint', targetId: e.id });
      }
    }
  }

  // Одна оборона за ход, и сразу лучшая доступная. Держится только высший
  // уровень прикрытия, поэтому вторая оборона не даёт ничего, а очки хода
  // ест: бастион уходил в прикрытие за 1 очко, следом в глухую защиту — и
  // весь ход стоил ему ровно одной обороны. Дешёвую предлагаем, только когда
  // на глухую не хватает очков (её цена — apCostFor: бастиону 2, незыблемость)
  if (self.coverLevel === 0) {
    const best = (['fullCover', 'cover'] as const).find((a) => ap >= apCostFor(a, self) && allowed(a));
    if (best) out.push({ to: here, action: best });
  }
  // щит кроет только смежного: прикрытие живёт, пока щитоносец рядом,
  // поэтому и выдать его дальнему нельзя — сначала подойди
  if (ap >= AP_COST.shieldAlly && allowed('shieldAlly')) {
    const level = self.passives?.shieldwall?.cover ?? coverLevelOf('shieldAlly');
    for (const a of alliesOf(self, units) as Fighter[]) {
      if (a.id !== self.id && dist(here, a.pos) === 1 && level > effectiveCover(a, units)) {
        out.push({ to: here, action: 'shieldAlly', targetId: a.id });
      }
    }
  }

  // меняться местами (план teamwork): договорённый обмен клетками со смежным
  // своим. Гейт словом — прецедент толчка и кастов: без правила «меняться
  // местами» кандидата нет вовсе, иначе партия начала бы тасоваться сама.
  // `to` — клетка подопечного: именно на ней я закончу, и все оценки поля
  // (угроза, опасность, зона замаха) должны считаться по ней
  if (ap >= AP_COST.swap && allowed('swap') && fired.some((r) => r.then.kind === 'swap')) {
    for (const a of alliesOf(self, units) as Fighter[]) {
      if (a.id !== self.id && dist(here, a.pos) === 1) {
        out.push({ to: { ...a.pos }, action: 'swap', targetId: a.id });
      }
    }
  }

  out.push({ to: here, action: 'wait' });
  return out;
}

/**
 * Радиус, в котором юнит успевает за ход дойти и ударить: шаги на все очки,
 * кроме одного под слабый удар. Общая мера «до кого я достаю» для угрозы,
 * приманки и глухой обороны.
 */
function strikeReach(u: Fighter): number {
  return u.move * (AP_PER_TURN - AP_COST.weakAttack) + u.range;
}

/**
 * Насколько подопечному сейчас нужен щит: доля его hp под угрозой, срезанная
 * по SHIELD_FULL_RISK. Правило «прикрывай X» тратит на щит два очка хода,
 * поэтому платить полную премию за прикрытие того, кому никто не грозит,
 * нельзя: телохранитель перестаёт драться и партия проигрывает бой.
 */
const SHIELD_FULL_RISK = 0.3;

/**
 * Премия правила за щит союзнику при полной нужде. Заметно меньше премии за
 * атаку (3 × вес): прикрыть — часть исполнения приказа «прикрывай X», но не
 * замена бою. При 2.5 наседка уходила в телохранители и теряла шестую часть
 * побед на уроке.
 */
const SHIELD_RULE_BONUS = 1.4;

/**
 * Сопротивление «держать позицию» за клетку удаления в квадрате. При 0.3 слово
 * весом 1.5 отпускает бойца на клетку и держит на второй, а «Глыба» Скалы
 * (вес 0.8) под приказом «бей ближайшего» (вес 1.5) отпускает на три — приказ
 * исполняется, но дальше своей позиции боец не уходит.
 */
const HOLD_RESIST = 0.3;

/**
 * Премия правилу «ждать» за пас и штраф за клетку сближения. Оба числа зажаты
 * с двух сторон, и это главное в слове:
 *  — премия обязана перекрывать пас (он списывает весь остаток хода: 1.5 при
 *    полном), иначе выжидание не видно в бою вовсе;
 *  — но вместе со штрафом за сближение она обязана уступать тяге сработавшего
 *    правила «атаковать» (0.6 за клетку при равных весах), иначе вторая
 *    половина замысла — «а ПОТОМ бросайся в атаку» — не снимает бойца с места.
 * Отсюда штраф ниже всех тяг словаря (0.5 у «отступать» и «подальше»): «ждать»
 * — про темп, и любой явный приказ его перебивает.
 */
const WAIT_BONUS = 0.8;
const WAIT_CLOSING_PENALTY = 0.3;

/**
 * Премия правила о манере удара своему виду атаки. Должна перебивать разницу
 * между видами по урону (около 3.5 очка между слабым и обычным ударом), иначе
 * слово не меняет ничего: приказ «бей часто» обязан пересиливать арифметику,
 * ради этого игрок его и берёт.
 */
const STRIKE_STYLE_BONUS = 2.5;

/**
 * Премия правила «впасть в ярость» самому действию ярости. Выше премии
 * атаки (3 × вес): условие правила уже сказало «сейчас», и откладывать вход
 * ради рядового удара нельзя — ярость жмётся раз в бой, конкуренция за ход
 * ей не грозит после входа. Добивание всё же перебивает (бонус lethal +4):
 * сначала добей — ярость никуда не денется.
 */
const RAGE_RULE_BONUS = 4;

/**
 * Премия правила «лечить» при полной нужде. Чуть выше премии атаки: спасение
 * умирающего важнее среднего удара, но добивание (lethal +4) перевешивает —
 * снятый враг лечит партию лучше всякого чуда.
 */
const HEAL_RULE_BONUS = 3.5;

/** Потеря hp цели, при которой исцеление получает полную премию. */
const HEAL_FULL_NEED = 0.5;

/** Премия правилу «благословить» — уровень манеры удара: буст, не замена бою. */
const BLESS_RULE_BONUS = 2.5;

/**
 * Премия правилу «финтить» при двух добирающих. Должна обыгрывать слабый удар
 * (премия атаки 3 × доля хода 0.5 + агрессия ≈ 2.9 при весе 2): жадный цикл не
 * видит связку «финт → удар», поэтому финт обязан выигрывать сам по себе —
 * его выгоду добирают следующие удары по открытой цели.
 */
const FEINT_RULE_BONUS = 3.2;

/**
 * Премия правилу «добивать» атаке, снимающей цель. Поверх lethal-бонуса
 * агрессии (+4) и сильнее lethal-премии размена (3 × вес): слово о том, что
 * снятая цель важнее любого другого расхода хода — даже удара побольнее по
 * здоровому. Не-летальные атаки слово не трогает: кого бить — решает attack.
 */
const FINISH_RULE_BONUS = 4;

/**
 * Премия правилу «бить туда же» атаке по врагу, которого последним ударил
 * кто-то из своих (канал lastAttackerId — тот же, что у кары Зари, только
 * с точки зрения бьющего). Уровень манеры удара (2.5): наклоняет выбор цели
 * при прочих равных, но не пересиливает явное «атаковать X» (3 × вес).
 */
const FOCUS_FIRE_BONUS = 2.5;

/**
 * Предел развода для «уводить от X» (план teamwork): дальше этой дистанции от
 * подопечного премия не растёт. Кап обязателен по уроку слова «подальше от»:
 * без него увод превращался бы в бегство к краю карты, а уводящий должен
 * оставаться в бою — он тем и полезен, что враги идут за ним.
 */
const LURE_SPREAD = 5;

/**
 * Премия правилу «заслонить от стрелков» за каждого стрелка, который из-за
 * моей клетки теряет подопечного из виду (считается до двух — третий стрелок
 * заслоном уже не лечится). Уровень щита союзнику ×2: заслон дешевле щита
 * (не тратит 2 AP отдельным действием, а достаётся вместе с шагом), но и
 * снимает не долю урона, а весь выстрел.
 */
const SCREEN_BLOCK_BONUS = 1.6;

/**
 * Премия «стеречь кромку» чистой клетке у труднопроходной земли со стороны
 * врага (и штраф той же величины за клетку самого бурелома — слово велит не
 * соваться в грязь). Уровень «за укрытием»: позиционный выигрыш той же
 * природы — враг платит ходами, я стреляю.
 */
const ROUGH_EDGE_BONUS = 1.2;

/** Премия «обходить из-за спин» за клетку бокового смещения и его предел. */
const OUTFLANK_SIDE_BONUS = 0.3;
const OUTFLANK_SPREAD = 4;

/** Штраф обходящему за то, что он ближе всех наших к своей ближайшей угрозе. */
const OUTFLANK_FRONT_PENALTY = 0.9;

/** Премия «сомкнуть строй» за смежного своего и за своего через клетку. */
const REGROUP_ADJ_BONUS = 0.9;
const REGROUP_NEAR_BONUS = 0.3;

/**
 * Премия правилу «меняться местами» при полном облегчении. Уровень лечения
 * (3.5 при полной нужде): обмен — то же спасение, только без траты заряда.
 */
const SWAP_RULE_BONUS = 3;

/**
 * Насколько снятая с подопечного угроза (в долях его ТЕКУЩЕГО hp) даёт полную
 * премию. Мера от текущего hp, а не от максимума: вытащить почти павшего —
 * главное, ради чего слово берут.
 */
const SWAP_FULL_RELIEF = 0.4;

/**
 * Премия «отходить за спины» клетке, перед которой стоит свой (ближе к моей
 * угрозе и с её стороны). Уровень «позади X» (2 × вес): та же геометрия, но
 * заслоном служит любой из наших, а не названный якорь.
 */
const FALLBACK_COVERED_BONUS = 2;

/**
 * Штраф «не застить своим» за каждую пару «наш стрелок → его цель», линию
 * которой рвёт моё тело на этой клетке (считается до двух). Ниже премии
 * заслона (1.6): свой стрелок чаще может шагнуть и открыть линию сам, поэтому
 * застить дешевле, чем заслонять врага, — при 1.6 ближник жертвовал боевой
 * позицией ради чистоты линии и слово уходило в минус (аудит).
 */
const CLEARLINE_PENALTY = 1.0;

/**
 * Премия «связывать боем» за конец хода вплотную к врагу, которого не держит
 * никто из своих. Премия ниже тяги явной атаки (3 × вес): слово выбирает,
 * К КОМУ встать, а не запрещает бить. Штраф за толкучку у уже связанного
 * пробовался (0.6) и убран по аудиту: он воевал с фокус-огнём — ядром меты —
 * и делал слово вредным в среднем (−6пп наиву, худший −22пп на боссе);
 * без него слово только тянет к свободному врагу, а бить всем одного
 * по-прежнему можно.
 */
const PIN_BONUS = 1.5;

/**
 * Премия «держать рубеж» клетке в зоне задачи (план objectives, волна 2).
 * Уровень «держать высоту»: тот же позиционный вкус — стоять там, где велено,
 * и не отдавать место; тяга снаружи мягче атакующей (0.35 < 0.6), чтобы
 * защитник не бросал начатый размен на полпути к зоне.
 */
const HOLD_LINE_BONUS = 1.2;

/**
 * Тяга «уходить к выходу» за клетку путевой дистанции до зоны и премия уже
 * дошедшему. Тяга равна атакующей (0.6): прорыв конкурирует с приказом «бей X»
 * на равных весах, и что перевесит — решает игрок весом слова. Носильщик
 * трофея несёт ношу той же тягой.
 */
const EVACUATE_PULL = 0.6;
const EVACUATE_IN_BONUS = 1.5;

/**
 * Премия «нести трофей» шагу, поднимающему ношу (конец шага на её клетке).
 * Уровень премии добивания: поднять трофей — событие боя, ради которого слово
 * и берут; тяга к лежащей ноше чуть мягче атакующей — по дороге можно драться.
 */
const CARRY_PICKUP_BONUS = 2.5;
const CARRY_PULL = 0.5;

/** Путевая дистанция клетки до зоны задачи (0 — внутри); якорь — ближайшая клетка зоны. */
function zonePathDist(z: Zone, self: Fighter, p: Pos, ctx: ScoreCtx): number {
  if (posInZone(p, z)) return 0;
  return Math.min(ctx.distTo(zoneAnchor(self.pos, z), p), MAX_DIST);
}

function shieldNeed(ally: Fighter, units: readonly Fighter[]): number {
  const risk = threatAt(ally.pos, ally, units) * (1 - effectiveCover(ally, units));
  return Math.min(risk / ally.maxHp / SHIELD_FULL_RISK, 1);
}

/**
 * Ожидаемый урон конкретного вида атаки по цели с учётом её прикрытия,
 * каменного укрытия (максимум, не сумма) и открытости; из клетки from.
 * Урон и «стрелковость» (бонус высоты) — по оружию атаки.
 */
function expectedAttackDamage(
  self: Fighter,
  move: WeaponMove,
  target: CombatUnit,
  units: readonly CombatUnit[],
  ctx: ScoreCtx,
  from: Pos,
  weapon: WeaponSpec = weaponsOf(self)[0]!,
  stance?: Stance,
): number {
  const mitigation = stanceMitigation(
    Math.max(effectiveCover(target, units), ctx.coverFrom(from, target.pos)),
    move,
    stance,
  );
  // бросок атаки (план damage-types): оценка обязана считать так же, как бой
  // исполнит, — промахи и криты сидят в множителе ожидания
  const odds = expectedAttackMult(attackBonusOf(weapon), acOf(target));
  const raw =
    expectedDamage(weapon.dmg) *
      odds *
      rageDmgMult(self) *
      blessMult(self) *
      (stanceAttackMult(move, stance) + gangBonus(move, self, target, units)) *
      (1 - mitigation) *
      (target.exposed ? SELFLESS_VULN_MULT : 1) *
      rageVulnMult(target) +
    heightDmgBonus(self, ctx.heightAt(from), move.range ?? weapon.range);
  // защиты цели по типу урона (план damage-types) — здесь и решается, каким
  // оружием и каким приёмом бить именно этого врага
  return applyDefenses(raw, dmgTypeOf(weapon, move), target.defenses).dmg;
}

/** Оружие кандидата-атаки; у не-атак и одиночного оружия — первое. */
const candWeapon = (self: Fighter, cand: Candidate): WeaponSpec => weaponsOf(self)[cand.weapon ?? 0]!;

/** Приём кандидата-атаки: по индексу кита — или из дефолт-тройки по слоту действия. */
export function candMove(self: CombatUnit, cand: Candidate): WeaponMove {
  const moves = movesOf(weaponsOf(self)[cand.weapon ?? 0]!);
  return (cand.move !== undefined ? moves[cand.move] : moves.find((m) => m.slot === cand.action)) ?? moves[0]!;
}

/**
 * Прибавка к множителю «толпового» приёма (райдер gang): +gang за каждого
 * живого союзника бьющего, стоящего вплотную к цели, — кинжалы в окружении.
 */
export function gangBonus(
  move: WeaponMove,
  attacker: CombatUnit,
  target: CombatUnit,
  units: readonly CombatUnit[],
): number {
  if (!move.gang) return 0;
  let n = 0;
  for (const u of units) {
    if (u.alive && u !== attacker && u !== target && u.side === attacker.side && dist(u.pos, target.pos) === 1) n++;
  }
  return move.gang * n;
}

/**
 * Клетка отскока после удара (райдер stepBack): на 1 строго от цели.
 * Занятая, каменная или опасная клетка — отскока нет: в шипы не прыгаем,
 * поэтому ни скорингу, ни бою не нужна отдельная логика опасности.
 */
export function stepBackDest(
  self: CombatUnit,
  target: CombatUnit,
  units: readonly CombatUnit[],
  ctx: ScoreCtx,
): Pos | null {
  const dest = shoveDest(target.pos, self.pos);
  if (!inBounds(dest) || ctx.blocked(dest) || ctx.hazardAt(dest)) return null;
  if (units.some((u) => u.alive && u !== self && posEq(u.pos, dest))) return null;
  return dest;
}

/**
 * Вторая жертва сдвоенного приёма (райдер twin): ближайший к бьющему другой
 * живой враг в дальности приёма с чистой линией; при равенстве — меньший id.
 * Общая для скоринга и боя — выбор обязан совпадать.
 */
export function twinVictim(
  self: Fighter,
  from: Pos,
  primary: CombatUnit,
  units: readonly Fighter[],
  blocked: (p: Pos) => boolean,
  height: number,
  range: number,
): Fighter | null {
  let best: Fighter | null = null;
  for (const e of enemiesOf(self, units) as Fighter[]) {
    if (e.id === primary.id) continue;
    if (!canAttackFrom(from, self, e, units, blocked, height, range)) continue;
    if (
      !best ||
      dist(from, e.pos) < dist(from, best.pos) ||
      (dist(from, e.pos) === dist(from, best.pos) && e.id < best.id)
    ) {
      best = e;
    }
  }
  return best;
}

function nearestEnemyDist(p: Pos, self: Fighter, units: readonly Fighter[]): number {
  const es = enemiesOf(self, units);
  if (es.length === 0) return MAX_DIST;
  return Math.min(...es.map((e) => dist(e.pos, p)));
}

/**
 * Доступность цели для правила «атаковать X» (план teamwork): множитель на
 * тягу и премии правила. Складывается из двух независимых осей.
 *
 * **Цена дороги** — две скидки: заслон (смежный телохранитель с заряженным
 * перехватом — удар съест он) и крюк пути (до цели заметно дальше, чем до
 * ближайшей альтернативы — «синица в руке»). Сколько из этого юнит видит,
 * решает `caution`: фанатик и буквалист (0) слепы и прут за целью приказа,
 * трус (1.4) преувеличивает. Скидки за глухую оборону цели здесь нет — почему,
 * сказано в `tuning.ts` рядом с `INTERCEPT_APPEAL`.
 *
 * **Внимание** — пока кто-то из своих у цели держит стойку «вызывать на себя»
 * и досягаем для меня, все ОСТАЛЬНЫЕ цели дешевеют; сам провокатор скидки не
 * платит, потому подмена и переезжает на него. Восприимчивость — `provocable`:
 * горячка ведётся вдвое, буквалист и дуэлянт почти нет. Ось отдельная от цены
 * дороги намеренно: фанатик не считает дорогу, но на дерзкий выкрик
 * оборачивается — это разные черты, и слепота к одной не даёт слепоты к другой.
 *
 * Симметрично для обеих сторон, детерминированно, без rng.
 */
export function targetAppeal(
  target: Fighter,
  self: Fighter,
  units: readonly Fighter[],
  ctx: ScoreCtx,
  round = 1,
  // кэш на ОДНО решение: доступность зависит от клетки решающего, а не от
  // кандидата, поэтому внутри decide она считается по разу на цель. Кэш живёт
  // не дольше решения — за ход юнит двигается, и заново считать обязательно
  memo?: AppealMemo,
): number {
  const cached = memo?.get(target.id);
  if (cached !== undefined) return cached;
  const value = computeAppeal(target, self, units, ctx, round);
  memo?.set(target.id, value);
  return value;
}

/** Ключ — id цели; действителен, пока решающий не сдвинулся (см. targetAppeal). */
export type AppealMemo = Map<string, number>;

function computeAppeal(
  target: Fighter,
  self: Fighter,
  units: readonly Fighter[],
  ctx: ScoreCtx,
  round: number,
): number {
  const { caution, provocable } = self.compiled.instincts;
  let road = 1;
  if (caution > 0) {
    const guarded = units.some(
      (g) =>
        g.alive &&
        g !== target &&
        g.side === target.side &&
        !g.interceptUsed &&
        dist(g.pos, target.pos) === 1 &&
        g.compiled.rules.some(
          (rl) =>
            rl.then.kind === 'protect' &&
            resolveAlly(rl.then.ally, g, units)?.id === target.id &&
            evalCondition(rl.when, g, units, round, ctx),
        ),
    );
    if (guarded) road *= INTERCEPT_APPEAL;
    // Крюк считается из текущей клетки (свойство выбора цели, не кандидата).
    // Поле дистанций берём ОТ СЕБЯ и читаем в нём позиции врагов: одна цель —
    // много клеток у тяги правила, здесь наоборот, и поле от себя обходится
    // одним BFS вместо одного на каждого врага (без этого аудит слов шёл вдвое
    // медленнее). На взвешенных клетках направление обхода меняет цену подъёма,
    // но крюк — сравнение целей между собой, и мера у них общая
    const others = (enemiesOf(self, units) as Fighter[]).filter((e) => e.id !== target.id);
    if (others.length > 0) {
      const gapTo = (e: Fighter): number => Math.max(ctx.distTo(self.pos, e.pos) - self.range, 0);
      const detour = gapTo(target) - Math.min(...others.map(gapTo)) - DETOUR_FREE;
      if (detour > 0) road *= Math.max(1 - DETOUR_APPEAL * detour, DETOUR_APPEAL_MIN);
    }
    road = 1 - (1 - road) * caution;
  }

  let attention = 1;
  if (provocable > 0 && !target.stance?.taunt) {
    const taunted = units.some(
      (t) =>
        t.alive &&
        t.side === target.side &&
        t.id !== target.id &&
        t.stance?.taunt &&
        dist(t.pos, self.pos) <= strikeReach(self),
    );
    if (taunted) attention = Math.max(1 - TAUNT_PULL * provocable, 0);
  }

  // пол — после обеих осей: даже преувеличивающий трус под градом выкриков не
  // глушит приказ насмерть, иначе боец без приемлемых целей застывает без дела
  return Math.max(road * attention, APPEAL_FLOOR);
}

/**
 * Кого правило «атаковать X» на самом деле пойдёт бить (план teamwork) и
 * насколько охотно. Приоритет цели приказа — 1, любой другой достижимой
 * цели — ровно недоступность приказанной: пока цель приказа доступна
 * (appeal 1), приоритет прочих нулевой и правило читается буквально, как до
 * плана. Когда за приказанную цель приходится платить больше половины
 * (заслон + крюк), доступная цель перевешивает — и весь градиент правила
 * (тяга, премия удара, премия шага под выстрел) переезжает на неё: это и
 * есть выбор «ударить сейчас или рискнуть и задавить того, кого велено».
 * Тайбрейк по id — детерминизм.
 */
function ruleTarget(
  sel: Selector,
  self: Fighter,
  units: readonly Fighter[],
  ctx: ScoreCtx,
  round: number,
  memo?: AppealMemo,
): { target: Fighter; appeal: number } | undefined {
  const aimed = resolveSelector(sel, self, units, ctx) as Fighter | undefined;
  if (!aimed) return undefined;
  const aimedAppeal = targetAppeal(aimed, self, units, ctx, round, memo);
  let best = { target: aimed, appeal: aimedAppeal, prio: aimedAppeal };
  if (aimedAppeal < 1) {
    for (const e of enemiesOf(self, units) as Fighter[]) {
      if (e.id === aimed.id) continue;
      const appeal = targetAppeal(e, self, units, ctx, round, memo);
      const prio = (1 - aimedAppeal) * appeal;
      if (prio > best.prio + 1e-9 || (Math.abs(prio - best.prio) <= 1e-9 && e.id < best.target.id)) {
        best = { target: e, appeal, prio };
      }
    }
  }
  return { target: best.target, appeal: best.appeal };
}

/** Вклад одного сработавшего правила в оценку кандидата. */
function scorePreference(
  pref: Preference,
  w: number,
  cand: Candidate,
  self: Fighter,
  units: readonly Fighter[],
  ctx: ScoreCtx,
  round = 1,
  memo?: AppealMemo,
): number {
  switch (pref.kind) {
    case 'attack': {
      // цена дороги (план teamwork): заслон и крюк дешевят цель приказа — и,
      // если она стала дороже доступной, правило переезжает на ту, что под
      // рукой. Фанатик скидок не видит и бьёт кого велено
      const aim = ruleTarget(pref.target, self, units, ctx, round, memo);
      if (!aim) return 0;
      const { target, appeal } = aim;
      // тяга к цели — но только до своей дальности: стрелок не лезет в рукопашную.
      // Дистанция путевая (BFS): у стены не залипаем, а идём к проходу.
      // Линейная и достаточно крутая, чтобы правило рулило поверх инстинктов.
      const gap = Math.max(ctx.distTo(target.pos, cand.to) - self.range, 0);
      let s = -0.6 * gap * w * appeal;
      // выстрел в укрытую цель — полдела, и премия правила скалируется
      // качеством выстрела: клетка с чистым углом обыгрывает стрельбу в камень,
      // стрелок меняет позицию, а не стоит (ближнему боя укрытие не мешает)
      const quality = 1 - ctx.coverFrom(cand.to, target.pos);
      // правило говорит, КОГО бить, а не чем: премия за потраченный ход, а не
      // за факт удара, поэтому вид атаки выбирают урон и риск, а не правило
      if (isAttack(cand.action) && cand.targetId === target.id) {
        s += 3 * w * candApShare(cand, self) * quality * appeal;
      }
      // Шаг, из которого цель реально простреливается, — половина дела. Без
      // этого жадный цикл выбирает клетку по одной лишь тяге `-0.6 × gap`:
      // гладкий градиент почти не различает соседние цели, и разные правила
      // «бей X» / «бей Y» сходились бы к одному и тому же маршруту.
      if (
        isMovement(cand.action) &&
        canAttackFrom(cand.to, self, target, units, ctx.blocked, ctx.heightAt(cand.to))
      ) {
        s += 1.5 * w * quality * appeal;
      }
      return s;
    }
    case 'protect': {
      const ally = resolveAlly(pref.ally, self, units) as Fighter | undefined;
      if (!ally) return 0;
      if (cand.action === 'shieldAlly' && cand.targetId === ally.id) {
        return SHIELD_RULE_BONUS * w * shieldNeed(ally as Fighter, units);
      }
      // стена исполняет «защищать», если подопечный в её накрытии
      if (cand.action === 'wall' && dist(self.pos, ally.pos) <= 1) {
        return SHIELD_RULE_BONUS * w * shieldNeed(ally as Fighter, units);
      }
      let s = -0.4 * dist(cand.to, ally.pos) * w;
      const threat = resolveSelector('nearest', ally as Fighter, units);
      if (
        threat &&
        dist(cand.to, ally.pos) <= 2 &&
        dist(cand.to, threat.pos) < dist(ally.pos, threat.pos)
      ) {
        s += 2 * w; // встать между союзником и угрозой
      }
      return s;
    }
    case 'holdPosition':
      // поводок, а не якорь: сопротивление растёт с удалением (квадрат), поэтому
      // явный приказ вытягивает бойца на несколько клеток, а дальше перевешивает
      // позиция. Плоская премия за клетку спавна давала обрыв: шаг к цели даёт
      // 0.6 × вес приказа, а сход с якоря стоил (1.5 + 0.5) × вес позиции — ни
      // один приказ этой ступеньки не брал, и «Глыба» молча глушила слова игрока.
      // Побочный эффект того же обрыва: пас на клетке спавна получал премию,
      // то есть стоять без дела было выгодно.
      return -HOLD_RESIST * w * dist(cand.to, self.startPos) ** 2;
    case 'retreat':
      return 0.5 * Math.min(nearestEnemyDist(cand.to, self, units), MAX_DIST) * w;
    case 'nearTo': {
      const anchor = resolvePosRef(pref.ref, self, units);
      if (!anchor) return 0;
      const d = dist(cand.to, anchor.pos);
      return (-0.5 * d + (d <= 1 ? 1 : 0)) * w;
    }
    case 'behind': {
      const anchor = resolvePosRef(pref.ref, self, units);
      if (!anchor) return 0;
      const threat = resolveSelector('nearest', anchor as Fighter, units);
      let s = -0.4 * dist(cand.to, anchor.pos) * w;
      if (threat && dist(cand.to, anchor.pos) <= 2) {
        const vt = { x: threat.pos.x - anchor.pos.x, y: threat.pos.y - anchor.pos.y };
        const vc = { x: cand.to.x - anchor.pos.x, y: cand.to.y - anchor.pos.y };
        if (vt.x * vc.x + vt.y * vc.y < 0) s += 2 * w; // дальняя от угрозы сторона
      }
      return s;
    }
    case 'bait': {
      // приманка: быть досягаемым для врагов (тянуть на себя), но не под ударом прямо сейчас
      const enemies = enemiesOf(self, units) as Fighter[];
      const reachable = enemies.filter((e) => dist(e.pos, cand.to) <= strikeReach(e)).length;
      const inRange = enemies.filter((e) => dist(e.pos, cand.to) <= e.range).length;
      return (0.5 * reachable - 0.7 * inRange) * w;
    }
    case 'trade': {
      // размен: жать атаку, если она добивает или снимает много — угрозу перевешивает вес
      if (!isAttack(cand.action) || !cand.targetId) return 0;
      const target = units.find((u) => u.id === cand.targetId)!;
      const expDmg = Math.min(
        expectedAttackDamage(self, candMove(self, cand), target, units, ctx, cand.to, candWeapon(self, cand)),
        target.hp,
      );
      return expDmg >= target.hp ? 3 * w : 1.5 * (expDmg / target.maxHp) * w;
    }
    case 'standoff': {
      // держать дистанцию: премия клеткам ровно на своей дальности от ближайшего
      // врага, штраф за ближе (растёт с приближением); дальше — нейтрально, поэтому
      // безопасная клетка вне досягаемости врагов не штрафуется (в отличие от attack)
      const d = nearestEnemyDist(cand.to, self, units);
      if (d < self.range) return -0.8 * (self.range - d) * w;
      return d === self.range ? 1.2 * w : 0;
    }
    case 'coverRetreat': {
      // прикрывать отход: встать между врагами и самым раненым союзником
      const wounded = (alliesOf(self, units) as Fighter[])
        .filter((a) => a.id !== self.id && a.hp < 0.5 * a.maxHp)
        .reduce<Fighter | undefined>(
          (best, a) => (!best || a.hp < best.hp || (a.hp === best.hp && a.id < best.id) ? a : best),
          undefined,
        );
      if (!wounded) return 0;
      if (cand.action === 'shieldAlly' && cand.targetId === wounded.id) {
        return SHIELD_RULE_BONUS * w * shieldNeed(wounded, units);
      }
      if (cand.action === 'wall' && dist(self.pos, wounded.pos) <= 1) {
        return SHIELD_RULE_BONUS * w * shieldNeed(wounded, units);
      }
      const threat = resolveSelector('nearest', wounded, units);
      let s = -0.3 * dist(cand.to, wounded.pos) * w;
      if (
        threat &&
        dist(cand.to, wounded.pos) <= 2 &&
        dist(cand.to, threat.pos) < dist(wounded.pos, threat.pos)
      ) {
        s += 2.2 * w; // заслон: я ближе к угрозе, чем отходящий
      }
      return s;
    }
    case 'flank': {
      // фланг: премия атакам с фланга; ближники подтягиваются к цели
      let s = 0;
      if (isAttack(cand.action) && cand.targetId) {
        const target = units.find((u) => u.id === cand.targetId)!;
        const allies = units
          .filter((u) => u.alive && u.side === self.side && u !== self)
          .map((u) => u.pos);
        // строй ломает фланги: премии за невозможный фланг не бывает
        const targetAllies = units
          .filter((u) => u.alive && u.side === target.side && u !== target)
          .map((u) => u.pos);
        if (self.range === 1 && isFlanking(cand.to, target.pos, allies, targetAllies)) {
          s += 2.5 * w * candApShare(cand, self);
        }
      }
      if (self.range === 1) {
        const nearest = resolveSelector('nearest', self, units);
        if (nearest) {
          s -= 0.3 * Math.max(dist(cand.to, nearest.pos) - 1, 0) * w;
          // манёвр: шаг во фланговую клетку у цели. Без него слово могло лишь
          // наградить уже случившийся фланг, но не создать его (аудит: ≈0)
          if (isMovement(cand.action) && dist(cand.to, nearest.pos) === 1) {
            const allies = units
              .filter((u) => u.alive && u.side === self.side && u !== self)
              .map((u) => u.pos);
            const nearestAllies = units
              .filter((u) => u.alive && u.side === nearest.side && u !== nearest)
              .map((u) => u.pos);
            if (isFlanking(cand.to, nearest.pos, allies, nearestAllies)) s += 1.5 * w;
          }
        }
      }
      return s;
    }
    case 'avoidLineOfFire': {
      // вне линии огня: штраф за клетки под прицелом вражеских стрелков
      const shooters = (enemiesOf(self, units) as Fighter[]).filter((e) => e.range > 1);
      const exposed = shooters.filter(
        (e) =>
          dist(e.pos, cand.to) <= e.range &&
          hasLoS(e.pos, cand.to, (p) =>
            ctx.blocked(p) || units.some((u) => u.alive && u !== self && u !== e && posEq(u.pos, p)),
          ),
      ).length;
      return -1.2 * exposed * w;
    }
    case 'chokepoint': {
      // узкое место: премия проходу — клетка проходима, а пара соседей
      // поперёк (по вертикали или горизонтали) — камни
      const { x, y } = cand.to;
      const choke =
        (ctx.blocked({ x, y: y - 1 }) && ctx.blocked({ x, y: y + 1 })) ||
        (ctx.blocked({ x: x - 1, y }) && ctx.blocked({ x: x + 1, y }));
      return choke ? 1.5 * w : 0;
    }
    case 'brace': {
      // глухая оборона: ценна, когда враги реально достают до клетки
      const mit = coverLevelOf(cand.action);
      if (mit === 0) return 0;
      const reachable = (enemiesOf(self, units) as Fighter[]).filter(
        (e) => dist(e.pos, cand.to) <= strikeReach(e),
      ).length;
      return (0.8 + 0.6 * Math.min(reachable, 2)) * (mit / COVER) * w;
    }
    case 'awayFrom': {
      const anchor = resolvePosRef(pref.ref, self, units);
      if (!anchor) return 0;
      // «подальше» — до безопасной дистанции, не до края карты: без капа
      // стрелки убегали вечно вместо стрельбы (аудит: −17пп winrate)
      const cap = Math.max(self.range, 3) + 1;
      return 0.5 * Math.min(dist(cand.to, anchor.pos), cap) * w;
    }
    // Манера удара: премия своему виду атаки, штраф чужому. Штраф обязателен —
    // без него «бей наверняка» не запрещал бы добирать слабым ударом остаток
    // очков, и слово прочитывалось бы вполсилы. Премия плоская, а не на очко
    // хода: это вкус к манере боя, а не плата за потраченный ход. Кого бить,
    // эти правила не говорят вовсе — за это отвечает attack.
    case 'strikeOften':
      if (cand.action === 'weakAttack') return STRIKE_STYLE_BONUS * w;
      return isAttack(cand.action) ? -STRIKE_STYLE_BONUS * w : 0;
    case 'strikeHard':
      // «наверняка» о расчёте, не о жадности: полный удар обязателен и
      // прицелен (стойка режет митигацию), добор слабым остатка хода манера
      // не запрещает — запрет сжигал треть DPS хода и хоронил слово (аудит)
      if (cand.action === 'attack') return STRIKE_STYLE_BONUS * w;
      return cand.action === 'selflessAttack' ? -STRIKE_STYLE_BONUS * w : 0;
    case 'strikeDesperate':
      if (cand.action === 'selflessAttack') return STRIKE_STYLE_BONUS * w;
      return isAttack(cand.action) ? -STRIKE_STYLE_BONUS * w : 0;
    case 'highGround': {
      // держать высоту: премия клетке на холме, тяга к ближайшему холму.
      // На арене без высот молчит — как узкое место на чистом поле.
      const h = ctx.heightAt(cand.to);
      if (h > 0) return (0.7 + 0.7 * h) * w;
      if (ctx.highTiles.length === 0) return 0;
      const d = Math.min(...ctx.highTiles.map((t) => dist(cand.to, t)));
      return -0.35 * Math.min(d, MAX_DIST) * w;
    }
    case 'behindCover': {
      // за укрытием: премия клеткам, где от вражеских стрелков закрывает
      // камень. Без стрелков (или на арене без камней) слово молчит; против
      // стрелка на высоте 2 камень не спасает — coverFrom это уже знает.
      const shooters = (enemiesOf(self, units) as Fighter[]).filter((e) => e.range > 1);
      if (shooters.length === 0) return 0;
      const covered = shooters.filter((e) => ctx.coverFrom(e.pos, cand.to) > 0).length;
      return 1.2 * (covered / shooters.length) * w;
    }
    case 'avoidHazard': {
      // обходить опасное: сильный штраф шагу на опасную клетку, слабый —
      // осторожному входу (слово говорит «не лезь», а не «лезь аккуратно»);
      // стоящему на опасной клетке — премия за уход на чистую. Зона замаха —
      // то же опасное место, но осторожный шаг от взрыва не спасает
      const zoned = zoneDangerAt(cand.to, units, self) > 0;
      if (zoned) return -2.2 * w;
      if (ctx.hazardAt(cand.to)) return (cand.action === 'carefulStep' ? -1 : -2.2) * w;
      if (
        (ctx.hazardAt(self.pos) || zoneDangerAt(self.pos, units, self) > 0) &&
        isMovement(cand.action)
      ) {
        return 1.5 * w;
      }
      return 0;
    }
    case 'roughEdge': {
      // стеречь кромку: ждать у труднопроходной земли, НЕ ступая на неё, —
      // пусть враг вязнет на подходе под выстрелами. На арене без бурелома
      // слово молчит — паттерн «держать высоту» без высот
      if (ctx.roughTiles.length === 0) return 0;
      if (ctx.roughAt(cand.to)) return -ROUGH_EDGE_BONUS * w;
      const nearest = resolveSelector('nearest', self, units);
      if (nearest) {
        // кромка — чистая клетка, у которой бурелом лежит со стороны врага:
        // та же геометрия направлений, что у каменного укрытия
        const v = { x: nearest.pos.x - cand.to.x, y: nearest.pos.y - cand.to.y };
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            if (ctx.roughAt({ x: cand.to.x + dx, y: cand.to.y + dy }) && dx * v.x + dy * v.y > 0) {
              return ROUGH_EDGE_BONUS * w;
            }
          }
        }
      }
      // не на кромке — тяга к ближайшему бурелому: слово должно уметь занять
      // позицию, а не только наградить занятую (урок фланг-манёвра)
      const d = Math.min(...ctx.roughTiles.map((t) => dist(cand.to, t)));
      return -0.25 * Math.min(d, MAX_DIST) * w;
    }
    case 'outflank': {
      // обходить из-за спин: заходить врагу сбоку одной стороной, не выходя
      // вперёд своих. Одному обходить не из-за кого — без живых своих молчит
      const foes = enemiesOf(self, units) as Fighter[];
      const mates = (alliesOf(self, units) as Fighter[]).filter((a) => a.id !== self.id);
      if (foes.length === 0 || mates.length === 0) return 0;
      const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
      const foeMid = { x: mean(foes.map((e) => e.pos.x)), y: mean(foes.map((e) => e.pos.y)) };
      const mateMid = { x: mean(mates.map((a) => a.pos.x)), y: mean(mates.map((a) => a.pos.y)) };
      const axis = { x: foeMid.x - mateMid.x, y: foeMid.y - mateMid.y };
      const len = Math.hypot(axis.x, axis.y);
      let s = 0;
      if (len > 0) {
        // боковое смещение от оси «наши → враги»; сторона обхода — та, где я
        // уже стою (защёлкивается сама: сдвинулся вбок — туда и продолжаю),
        // ровно на оси — детерминированно влево от строя
        const lat = (p: Pos): number => (axis.x * (p.y - mateMid.y) - axis.y * (p.x - mateMid.x)) / len;
        const side = lat(self.pos) >= 0 ? 1 : -1;
        s += OUTFLANK_SIDE_BONUS * Math.min(Math.max(lat(cand.to) * side, 0), OUTFLANK_SPREAD);
      }
      // позади союзников: к своей ближайшей угрозе я не ближе всех из наших
      const threat = foes.reduce((b, e) => {
        const d = dist(e.pos, cand.to);
        const bd = dist(b.pos, cand.to);
        return d < bd || (d === bd && e.id < b.id) ? e : b;
      });
      if (mates.every((a) => dist(a.pos, threat.pos) > dist(cand.to, threat.pos))) {
        s -= OUTFLANK_FRONT_PENALTY;
      }
      return s * w;
    }
    case 'shove': {
      // толкать: тем ценнее, чем опаснее клетка назначения. В шипы или в зону
      // замаха — сильнее полного удара (урон + сбитая позиция); на чистую
      // клетку — мелкая выгода, соперник слабого удара, а не полного
      if (cand.action !== 'shove' || !cand.targetId) return 0;
      const target = units.find((u) => u.id === cand.targetId)!;
      const dest = shoveDest(self.pos, target.pos);
      const danger = ctx.hazardAt(dest) || zoneDangerAt(dest, units, target) > 0;
      // премии «отрыва» и «сброса с высоты» пробовались планом words и убраны:
      // по аудиту они лишь подменяли удары толчками (−4пп наиву). Толчок
      // оживёт аренами с шипами у точек столкновения, не скорингом
      return (danger ? 3.5 : 0.8) * w;
    }
    case 'barrage': {
      // накрыть скопление: премия только от двух накрытых врагов — и растёт с
      // их числом. По одному касты не жмут (обычная атака выгоднее по урону):
      // АОЕ — ответ на кучность, а не кнопка урона
      if ((cand.action !== 'aoeBlast' && cand.action !== 'aoeLine' && cand.action !== 'aoeRitual') || !cand.at) {
        return 0;
      }
      const covered = castVictims(cand.action, cand.at, self, units, ctx.blocked).filter(
        (v) => v.side !== self.side,
      ).length;
      return covered >= 2 ? 1.5 * covered * w : 0;
    }
    case 'spread': {
      // держать интервал: штраф за конец хода вплотную к союзнику (дист ≤1
      // сильно, 2 — мягко), пока у врага жив АОЕ-носитель; без носителя слово
      // молчит — паттерн «держать высоту» на арене без высот
      if (!(enemiesOf(self, units) as Fighter[]).some((e) => e.aoe)) return 0;
      let s = 0;
      for (const a of alliesOf(self, units)) {
        if (a.id === self.id) continue;
        const d = dist(cand.to, a.pos);
        if (d <= 1) s -= 1.2;
        else if (d === 2) s -= 0.4;
      }
      return s * w;
    }
    case 'preempt': {
      // бить на упреждение: манера ритуала — премия зонам, накрывающим
      // ПРОЕКЦИИ движения врагов (куда придут к залпу), а не текущие позиции.
      // Коэффициент выше премии скопления: прогноз должен перетягивать выбор
      // центра у зон «где стоят», иначе слово не читается
      if (cand.action !== 'aoeRitual' || !cand.at) return 0;
      // премия взвешена глубиной проекций: зона, где бегущие окажутся в
      // середине, обыгрывает зону, где они будут у края
      const depths = (enemiesOf(self, units) as Fighter[])
        .map((e) => predictedPos(e, units, ctx))
        .filter((p) => dist(p, cand.at!) <= AOE_RITUAL_RADIUS)
        .map((p) => ritualDepth(p, cand.at!));
      return depths.length >= 2 ? 2.5 * depths.reduce((s, d) => s + d, 0) * w : 0;
    }
    case 'castRitual': {
      // замахиваться ритуалом: манера каста по образцу манер удара — премия
      // замаху, штраф мгновенным кастам («не разменивайся на залп»). Атаки
      // не трогает: слово о том, ЧЕМ накрывать, а не о том, бить ли вообще
      if (cand.action === 'aoeRitual') return STRIKE_STYLE_BONUS * w;
      if (cand.action === 'aoeBlast' || cand.action === 'aoeLine') return -STRIKE_STYLE_BONUS * w;
      return 0;
    }
    case 'wait': {
      // ждать: слово о темпе, а не о месте. Премия пасу (он списывает весь
      // остаток хода — это и есть «выждать») и штраф шагу, сокращающему
      // дистанцию до ближайшего врага: не сближайся сам.
      //
      // Ждать имеет смысл, только пока бой не докатился: как только до меня
      // достают за свой ход, премия гаснет — иначе слово читалось бы как
      // «стой и умри», а вторая половина замысла («а потом — в атаку») не
      // успевала бы сработать. Атаки слово не трогает вовсе: подошедшего
      // врага бьют, ждать — значит не идти навстречу, а не отказываться драться.
      const reached = (enemiesOf(self, units) as Fighter[]).some(
        (e) => dist(e.pos, self.pos) <= strikeReach(e),
      );
      if (cand.action === 'wait') return reached ? 0 : WAIT_BONUS * w;
      if (isMovement(cand.action)) {
        const closing =
          nearestEnemyDist(self.pos, self, units) - nearestEnemyDist(cand.to, self, units);
        return closing > 0 ? -WAIT_CLOSING_PENALTY * closing * w : 0;
      }
      return 0;
    }
    case 'rage':
      // впасть в ярость: правило-гейт платит и премию — актив жмётся, как
      // только условие правила сработало («если врагов больше — ярись»).
      // Оценивать выгоду ярости инстинктами не пытаемся (сколько боя осталось —
      // юнит не знает); в этом и смысл: КОГДА тратить, решает слово игрока
      return cand.action === 'rage' ? RAGE_RULE_BONUS * w : 0;
    case 'heal': {
      // лечить: премия растёт с нуждой цели — полная при потере половины hp.
      // Царапины лечить невыгодно (заряды считаны), умирающего — важнее удара
      if (cand.action !== 'heal' || !cand.targetId) return 0;
      const target = units.find((u) => u.id === cand.targetId)!;
      const need = Math.min((target.maxHp - target.hp) / target.maxHp / HEAL_FULL_NEED, 1);
      return HEAL_RULE_BONUS * w * need;
    }
    case 'feint': {
      // финтить: ценность — открытая цель под ударами; полная премия, когда
      // добрать могут хотя бы двое своих (включая самого финтёра — он бьёт
      // тем же ходом), иначе финт вхолостую
      if (cand.action !== 'feint' || !cand.targetId) return 0;
      const target = units.find((u) => u.id === cand.targetId)!;
      const reachers = (alliesOf(self, units) as Fighter[]).filter(
        (a) => dist(a.pos, target.pos) <= strikeReach(a),
      ).length;
      return FEINT_RULE_BONUS * w * Math.min(reachers, 2) / 2;
    }
    case 'bless':
      // благословить: цель выбирает премия — самый ударный союзник ценнее
      if (cand.action !== 'bless' || !cand.targetId) return 0;
      return (
        BLESS_RULE_BONUS *
        w *
        (units.find((u) => u.id === cand.targetId)!.atk /
          Math.max(...alliesOf(self, units).map((a) => a.atk), 1))
      );
    case 'finish': {
      // добивать: премия только удару, который снимает цель, — приоритет
      // добивания, а не тяга к раненым (кого бить, по-прежнему решает attack)
      if (!isAttack(cand.action) || !cand.targetId) return 0;
      const target = units.find((u) => u.id === cand.targetId)!;
      const expDmg = expectedAttackDamage(self, candMove(self, cand), target, units, ctx, cand.to, candWeapon(self, cand));
      return expDmg >= target.hp ? FINISH_RULE_BONUS * w : 0;
    }
    case 'focusFire': {
      // бить туда же: премия атаке по врагу, которого уже бил кто-то из своих
      if (!isAttack(cand.action) || !cand.targetId) return 0;
      const target = units.find((u) => u.id === cand.targetId)!;
      const started = units.some(
        (a) => a.alive && a.side === self.side && target.lastAttackerId === a.id,
      );
      return started ? FOCUS_FIRE_BONUS * w * candApShare(cand, self) : 0;
    }
    case 'taunt': {
      // вызывать на себя: работает стойкой (её ставит решение), а позиционно —
      // «будь у врагов на виду»: премия за каждого, кто до меня достаёт. Это не
      // приманка: приманка ещё и уклоняется, а вызов — только зовёт, поэтому
      // коэффициент вдвое меньше приманочного и штрафа «под ударом» нет.
      // Кричать некому — премии нет: слово молчит, когда врагов рядом ноль
      const reachable = (enemiesOf(self, units) as Fighter[]).filter(
        (e) => dist(e.pos, cand.to) <= strikeReach(e),
      ).length;
      return 0.25 * Math.min(reachable, 3) * w;
    }
    case 'lure': {
      // уводить от X: быть досягаемым для врагов (иначе уводить нечем) и при
      // этом тянуть их прочь от подопечного — премия за каждую клетку между
      // мной и X, до предела: увести можно в сторону, а не за карту
      const ally = resolveAlly(pref.ally, self, units) as Fighter | undefined;
      if (!ally) return 0;
      const reachable = (enemiesOf(self, units) as Fighter[]).filter(
        (e) => dist(e.pos, cand.to) <= strikeReach(e),
      ).length;
      if (reachable === 0) return 0;
      const away = Math.min(dist(cand.to, ally.pos), LURE_SPREAD);
      return (0.25 * Math.min(reachable, 3) + 0.4 * away) * w;
    }
    case 'screen': {
      // заслонить от стрелков: премия клетке, из-за которой стрелок теряет
      // подопечного из виду. Тела рвут линию выстрела целиком (canAttackFrom),
      // поэтому заслон — не доля урона, а отменённый выстрел. Стрелков нет —
      // слово молчит вовсе: это контр-приём, а не позиционная привычка
      const ward = resolveAlly(pref.ally, self, units) as Fighter | undefined;
      if (!ward) return 0;
      const shooters = (enemiesOf(self, units) as Fighter[]).filter((e) => e.range > 1);
      if (shooters.length === 0) return 0;
      // чужие тела и камни (кроме смежного цели — он лишь укрытие) заслоняют
      // и без меня; моё тело добавляется клеткой-кандидатом
      const solid = (p: Pos, e: Fighter): boolean =>
        (ctx.blocked(p) && dist(p, ward.pos) > 1) ||
        units.some((u) => u.alive && u !== self && u !== e && u !== ward && posEq(u.pos, p));
      const blocking = shooters.filter(
        (e) =>
          dist(e.pos, ward.pos) <= rangeAt(e, ctx.heightAt(e.pos)) &&
          hasLoS(e.pos, ward.pos, (p) => solid(p, e)) &&
          !hasLoS(e.pos, ward.pos, (p) => posEq(p, cand.to) || solid(p, e)),
      ).length;
      // тяга к подопечному: без неё слово умеет только наградить уже
      // сложившийся заслон, но не встать в него (урок «фланг-манёвра»)
      return (SCREEN_BLOCK_BONUS * Math.min(blocking, 2) - 0.25 * dist(cand.to, ward.pos)) * w;
    }
    case 'regroup': {
      // сомкнуть строй: зеркало «держать интервал». Гейта у слова нет (в
      // отличие от интервала, который молчит без вражеского АОЕ): строй
      // полезен всегда — он ломает фланги и держит рипост
      const mates = (alliesOf(self, units) as Fighter[]).filter((a) => a.id !== self.id);
      if (mates.length === 0) return 0;
      let s = 0;
      for (const a of mates) {
        const d = dist(cand.to, a.pos);
        if (d <= 1) s += REGROUP_ADJ_BONUS;
        else if (d === 2) s += REGROUP_NEAR_BONUS;
      }
      // издалека — тяга к ближайшему своему: слово должно уметь собирать
      // строй, а не только награждать сложившийся
      const nearest = Math.min(...mates.map((a) => dist(cand.to, a.pos)));
      s -= 0.25 * Math.max(Math.min(nearest, MAX_DIST) - 2, 0);
      return s * w;
    }
    case 'swap': {
      // меняться местами: премия — снятая с подопечного угроза, нормированная
      // на его текущее hp. Из огня в огонь не тащим: опасная клетка под мной
      // обнуляет приём (подопечный въедет в неё сам)
      const ward = resolveAlly(pref.ally, self, units) as Fighter | undefined;
      if (!ward) return 0;
      // подойти вплотную — половина дела: обмен возможен только со смежным
      let s = -0.3 * Math.max(dist(cand.to, ward.pos) - 1, 0) * w;
      if (cand.action === 'swap' && cand.targetId === ward.id && !ctx.hazardAt(self.pos)) {
        const relief = pressureAt(ward.pos, self, units) - pressureAt(self.pos, self, units);
        if (relief > 0) {
          s += SWAP_RULE_BONUS * w * Math.min(relief / Math.max(ward.hp, 1) / SWAP_FULL_RELIEF, 1);
        }
      }
      return s;
    }
    case 'mark':
      // метить цель: работает стойкой (её ставит решение) — сам удар вешает
      // метку в battle. Кандидатов слово не двигает: кого бить, решает attack,
      // а канал читают напарники со словом «помеченный»
      return 0;
    case 'fallback': {
      // отходить за спины: отступать К своим, а не от врага в никуда. Тяга к
      // ближайшему своему держит отход в партии (урок «отступать»: без якоря
      // бегство кончается краем карты), премия — за своего между мной и моей
      // ближайшей угрозой: та же геометрия «дальняя от угрозы сторона», что у
      // «позади X», только заслоном служит любой из наших
      const mates = (alliesOf(self, units) as Fighter[]).filter((a) => a.id !== self.id);
      if (mates.length === 0) return 0;
      const threat = resolveSelector('nearest', self, units);
      const nearestMate = Math.min(...mates.map((a) => dist(cand.to, a.pos)));
      let s = -0.35 * Math.max(Math.min(nearestMate, MAX_DIST) - 1, 0);
      if (threat) {
        const covered = mates.some((a) => {
          const va = { x: a.pos.x - cand.to.x, y: a.pos.y - cand.to.y };
          const vt = { x: threat.pos.x - cand.to.x, y: threat.pos.y - cand.to.y };
          return (
            dist(a.pos, threat.pos) < dist(cand.to, threat.pos) && va.x * vt.x + va.y * vt.y > 0
          );
        });
        if (covered) s += FALLBACK_COVERED_BONUS;
      }
      return s * w;
    }
    case 'clearLine': {
      // не застить своим: штраф клетке, из-за которой НАШ стрелок теряет цель
      // из виду, — зеркало заслона со сменой стороны и знака. Тела рвут линию
      // выстрела целиком (canAttackFrom), поэтому застить — отменять выстрел.
      // Своих стрелков нет — слово молчит: дисциплина, а не привычка
      const shooters = (alliesOf(self, units) as Fighter[]).filter(
        (a) => a.id !== self.id && a.range > 1,
      );
      if (shooters.length === 0) return 0;
      const foes = enemiesOf(self, units) as Fighter[];
      let blocking = 0;
      for (const sh of shooters) {
        for (const e of foes) {
          if (dist(sh.pos, e.pos) > rangeAt(sh, ctx.heightAt(sh.pos))) continue;
          // камень, смежный с целью, — лишь укрытие; чужие тела глухие
          const solid = (p: Pos): boolean =>
            (ctx.blocked(p) && dist(p, e.pos) > 1) ||
            units.some((u) => u.alive && u !== self && u !== sh && u !== e && posEq(u.pos, p));
          if (
            hasLoS(sh.pos, e.pos, solid) &&
            !hasLoS(sh.pos, e.pos, (p) => posEq(p, cand.to) || solid(p))
          ) {
            blocking++;
          }
        }
      }
      return -CLEARLINE_PENALTY * Math.min(blocking, 2) * w;
    }
    case 'pin': {
      // связывать боем: каждому по врагу. Премия за конец хода вплотную к
      // врагу, которого не держит никто из своих (моё тело — его зона
      // контроля), штраф за толкучку у уже связанного; издалека — тяга к
      // ближайшему несвязанному, чтобы слово умело занять контакт, а не
      // только наградить занятый (урок фланг-манёвра)
      const foes = enemiesOf(self, units) as Fighter[];
      if (foes.length === 0) return 0;
      const mates = (alliesOf(self, units) as Fighter[]).filter((a) => a.id !== self.id);
      const held = (e: Fighter): boolean => mates.some((a) => dist(a.pos, e.pos) === 1);
      const adjacent = foes.filter((e) => dist(cand.to, e.pos) === 1);
      let s = 0;
      if (adjacent.some((e) => !held(e))) s += PIN_BONUS;
      else {
        const unheld = foes.filter((e) => !held(e));
        if (unheld.length > 0) {
          const d = Math.min(...unheld.map((e) => dist(cand.to, e.pos)));
          s -= 0.25 * Math.max(Math.min(d, MAX_DIST) - 1, 0);
        }
      }
      return s * w;
    }
    case 'holdLine': {
      // держать рубеж: премия клетке в зоне задачи, тяга к зоне снаружи.
      // Без зоны слово молчит — паттерн «держать высоту» на плоской арене
      const z = ctx.zone;
      if (!z) return 0;
      const d = zonePathDist(z, self, cand.to, ctx);
      if (d === 0) return HOLD_LINE_BONUS * w;
      return -0.35 * d * w;
    }
    case 'evacuate': {
      // уходить к выходу: пробиваться в зону задачи — тяга атакующей силы,
      // бой по дороге не запрещён (подошедшего бьют, но крюков не делают)
      const z = ctx.zone;
      if (!z) return 0;
      const d = zonePathDist(z, self, cand.to, ctx);
      return (d === 0 ? EVACUATE_IN_BONUS : -EVACUATE_PULL * d) * w;
    }
    case 'carry': {
      // нести трофей: ноша лежит — идти к ней и поднять (конец шага на её
      // клетке); несу сам — тащить к зоне; несёт другой — слово молчит
      // (охрану носильщика выражают другие слова)
      const p = ctx.prize;
      if (!p) return 0;
      if (p.carrierId === self.id) {
        const z = ctx.zone;
        if (!z) return 0;
        const d = zonePathDist(z, self, cand.to, ctx);
        return (d === 0 ? EVACUATE_IN_BONUS : -EVACUATE_PULL * d) * w;
      }
      if (p.at) {
        const d = Math.min(ctx.distTo(p.at, cand.to), MAX_DIST);
        let s = -CARRY_PULL * d;
        if (isMovement(cand.action) && posEq(cand.to, p.at)) s += CARRY_PICKUP_BONUS;
        return s * w;
      }
      return 0;
    }
  }
}

/**
 * Урон, который клетка получает **прямо сейчас** — от врагов, достающих до
 * неё без шага. Мера обмена местами: `threatAt` считает досягаемость за целый
 * ход (strikeReach), а она у соседних клеток почти одинакова — по ней вытащить
 * зажатого было бы нечем. Обмен и ценен тем, что снимает удары, которые уже
 * занесены.
 */
function pressureAt(p: Pos, self: Fighter, units: readonly Fighter[]): number {
  return (enemiesOf(self, units) as Fighter[])
    .filter((e) => dist(e.pos, p) <= e.range)
    .reduce((sum, e) => sum + expectedDamage(e.atk), 0);
}

function threatAt(p: Pos, self: Fighter, units: readonly Fighter[]): number {
  return (enemiesOf(self, units) as Fighter[])
    .filter((e) => dist(e.pos, p) <= strikeReach(e))
    .reduce((sum, e) => sum + expectedDamage(e.atk), 0);
}

export function scoreCandidate(
  cand: Candidate,
  self: Fighter,
  units: readonly Fighter[],
  firedRules: readonly Rule[],
  ctx: ScoreCtx = makeCtx(),
  round = 1,
  memo?: AppealMemo,
): Factor[] {
  const { instincts } = self.compiled;
  const factors: Factor[] = [];

  // тяга характера к самому действию — независимо от того, насколько оно
  // выгодно здесь и сейчас (нулевая тяга отсекается ещё в кандидатах)
  const bias = biasFor(instincts, cand.action);
  if (bias !== 1) {
    factors.push({ label: 'характер:тяга', value: (bias - 1) * ACTION_BIAS_WEIGHT });
  }

  if (isAttack(cand.action) && cand.targetId) {
    const weapon = candWeapon(self, cand);
    const move = candMove(self, cand);
    const target = units.find((u) => u.id === cand.targetId)!;
    const stance = stanceOf(firedRules);
    const expDmg = Math.min(
      expectedAttackDamage(self, move, target, units, ctx, cand.to, weapon, stance) *
        shadowMult(self, cand.to, units, ctx.blocked) *
        retributionMult(self, target, units),
      target.hp,
    );
    const lethal = expDmg >= target.hp;
    let aggr = (expDmg / target.maxHp) * 6 + (lethal ? 4 : 0);
    // сдвоенный приём (райдер twin): вторая стрела — та же валюта, суммой
    // (прецедент АОЕ); без неё половинный множитель хоронил бы приём
    if (move.twin) {
      const second = twinVictim(self, cand.to, target, units, ctx.blocked, ctx.heightAt(cand.to), move.range ?? weapon.range);
      if (second) {
        const d2 = Math.min(
          expectedAttackDamage(self, move, second, units, ctx, cand.to, weapon, stance) *
            shadowMult(self, cand.to, units, ctx.blocked) *
            retributionMult(self, second, units),
          second.hp,
        );
        aggr += (d2 / second.maxHp) * 6 + (d2 >= second.hp ? 4 : 0);
      }
    }
    const v = aggr * instincts.aggression;
    if (v !== 0) factors.push({ label: 'инстинкт:агрессия', value: v });
    // цель задачи боя (план objectives): слабая тяга к юниту с тегом quarry —
    // фон, который любое слово игрока перебивает
    if (target.tags.includes('quarry')) {
      factors.push({ label: 'инстинкт:задача', value: QUARRY_BIAS });
    }
    // рипост (план защиты): ближний удар по глухой обороне вернётся раной —
    // умный переключается, настойчивый платит; расчётливый удар не ловит
    if (
      (move.range ?? weapon.range) === 1 &&
      !lethal &&
      target.coverLevel >= FULL_COVER &&
      !isSureStrike(move, stance)
    ) {
      factors.push({
        label: 'рипост цели',
        value: -(RIPOSTE_DMG / self.maxHp) * 6 * instincts.survival,
      });
    }
    // аффинность оружия к манере: мягкий вкус, слово игрока (±2.5) перебивает
    const aff = weapon.affinity?.[cand.action as 'weakAttack' | 'attack' | 'selflessAttack'];
    if (aff) factors.push({ label: 'оружие:манера', value: aff * WEAPON_AFFINITY_BONUS });
    // толчок приёма: сдвиг сам по себе скоринг не ценит (урок слова «толкать»:
    // премии отрыва подменяли удары), но толчок в шипы или под висящую зону —
    // честный урон той же валютой, что и агрессия
    if (move.push) {
      const dest = shoveDest(cand.to, target.pos);
      const free =
        inBounds(dest) &&
        !ctx.blocked(dest) &&
        !units.some((u) => u.alive && posEq(u.pos, dest));
      if (free && (ctx.hazardAt(dest) || zoneDangerAt(dest, units, target) > 0)) {
        factors.push({
          label: 'толчок в опасное',
          value: (Math.min(HAZARD_DMG, target.hp) / target.maxHp) * 6 * instincts.aggression,
        });
      }
    }
  }

  // площадной каст: та же валюта, что у агрессии, но суммой по накрытым.
  // Свои в зоне (friendly fire) — в минус, вес ffCare (у всех 1, фанатик 0:
  // «в замес — так в замес»). Ритуал оценивается по текущим позициям: без
  // слова упреждения кастер целит в скопление «где стоят» — зона читаема и
  // уворачиваема, это норма
  const aoeForm =
    cand.action === 'aoeBlast' ? self.aoe?.blast
    : cand.action === 'aoeLine' ? self.aoe?.line
    : cand.action === 'aoeRitual' ? self.aoe?.ritual
    : undefined;
  if (aoeForm && cand.at) {
    let foes = 0;
    let own = 0;
    for (const v of castVictims(cand.action, cand.at, self, units, ctx.blocked)) {
      const dmg = Math.min(aoeDamage(self, aoeForm.mult, v, units), v.hp);
      let val = (dmg / v.maxHp) * 6 + (dmg >= v.hp ? 4 : 0);
      // ритуал бьёт через ход: жертва у края зоны выйдет одним шагом, из
      // середины — не успеет. Глубина в зоне — ожидаемая доля попадания;
      // без неё все центры, накрывшие пару, равны, и тай-брейк порядка
      // генерации выбирал угловую зону — «цепляет краем» вместо накрытия
      if (cand.action === 'aoeRitual') {
        val *= 0.4 + 0.6 * ritualDepth(v.pos, cand.at);
      }
      if (v.side !== self.side) foes += val;
      else own += val;
    }
    if (foes !== 0) factors.push({ label: 'инстинкт:агрессия', value: foes * instincts.aggression });
    if (own !== 0 && instincts.ffCare !== 0) {
      factors.push({ label: 'свои в зоне', value: -own * instincts.ffCare });
    }
  }

  // зонная задача боя (план objectives, волна 2): слабый фон — премия клетке
  // в зоне и мягкий градиент к ней; любое слово игрока перебивает (ZONE_BIAS)
  if (ctx.zoneInstinct && ctx.zone) {
    const d = zoneDist(cand.to, ctx.zone);
    factors.push({
      label: 'инстинкт:задача',
      value: d === 0 ? ZONE_BIAS : (-ZONE_BIAS * Math.min(d, MAX_DIST)) / MAX_DIST,
    });
  }

  const hpFrac = self.hp / self.maxHp;
  // отскок (райдер stepBack): угроза и ZoC меряются с клетки, где юнит
  // окажется ПОСЛЕ удара, — иначе выгода приёма невидима и он мёртв
  const restPos = attackRestPos(self, cand, units, ctx);
  const threat = threatAt(restPos, self, units);
  if (threat > 0) {
    const v = -(threat / self.maxHp) * 2 * instincts.survival * (2 - hpFrac);
    factors.push({ label: 'инстинкт:самосохранение', value: v });
  }
  // шаг, оконченный на опасной клетке, — гарантированный урон; та же валюта,
  // что и у агрессии (доля maxHp × 6). Осторожный шаг опасность не будит
  if ((cand.action === 'move' || cand.action === 'swap') && ctx.hazardAt(cand.to)) {
    factors.push({
      label: 'инстинкт:опасная клетка',
      value: -(HAZARD_DMG / self.maxHp) * 6 * instincts.survival,
    });
  }
  // зона замаха: бьёт присутствие в момент залпа, поэтому штраф — полю, а не
  // действию «шаг»: любой кандидат, оканчивающийся в зоне, платит, и выход
  // из зоны снимает штраф сам собой. Осторожный шаг от взрыва не спасает.
  // Трус (survival ×2.2) разбегается, фанатик стоит — искажения бесплатно
  const zoneDmg = zoneDangerAt(cand.to, units, self);
  if (zoneDmg > 0) {
    factors.push({ label: 'инстинкт:зона замаха', value: -(zoneDmg / self.maxHp) * 6 * instincts.survival });
  }
  if (!instincts.ignoreZoC && zocOf(self, units)(restPos)) {
    factors.push({ label: 'инстинкт:зона контроля', value: -1.5 * instincts.survival });
  }

  // Защитные действия и отчаянный удар оцениваются в той же валюте, что и
  // агрессия: доля maxHp × 6. Иначе выбор между «ударить сильнее» и «не
  // подставиться» решался бы не обстановкой, а случайными коэффициентами.
  const mit = coverLevelOf(cand.action);
  if (mit > 0 && cand.action !== 'shieldAlly' && threat > 0) {
    const v = ((threat * mit) / self.maxHp) * 6 * instincts.survival;
    if (v !== 0) factors.push({ label: 'инстинкт:прикрытие', value: v });
  }
  // открывающий приём (дефолт-размен, «сплеча») — плата уязвимостью
  if (isAttack(cand.action) && cand.targetId && candMove(self, cand).expose && threat > 0) {
    const v = -((threat * (SELFLESS_VULN_MULT - 1)) / self.maxHp) * 6 * instincts.survival * (2 - hpFrac);
    factors.push({ label: 'инстинкт:открыться', value: v });
  }
  if (cand.action === 'shieldAlly' && cand.targetId) {
    const ally = units.find((u) => u.id === cand.targetId);
    if (ally?.alive) {
      // щитоносец («стена щита» Грома) кроет союзника сильнее общего COVER
      const level = self.passives?.shieldwall?.cover ?? COVER;
      const spared = threatAt(ally.pos, ally, units) * (1 - effectiveCover(ally, units)) * level;
      const v = (spared / ally.maxHp) * 6 * instincts.survival;
      if (v !== 0) factors.push({ label: 'инстинкт:прикрыть своего', value: v });
    }
  }
  if (cand.action === 'wall') {
    // стена: суммарно спасённый урон по себе и смежным союзникам — та же
    // валюта, что у щита одному
    let v = 0;
    for (const a of alliesOf(self, units)) {
      if (a.id !== self.id && dist(a.pos, self.pos) > 1) continue;
      v += (threatAt(a.pos, a as Fighter, units) * (1 - effectiveCover(a, units)) * COVER) / a.maxHp;
    }
    v *= 6 * instincts.survival;
    if (v !== 0) factors.push({ label: 'инстинкт:стена', value: v });
  }

  for (const rule of firedRules) {
    const v = scorePreference(rule.then, rule.weight, cand, self, units, ctx, round, memo);
    if (v === 0) continue;
    // подмену цели видно в разборе боя: иначе игрок не поймёт, почему боец с
    // приказом «бей слабейшего» бьёт кого-то другого (план teamwork)
    let label = `правило:${rule.source}`;
    if (rule.then.kind === 'attack') {
      const aimed = resolveSelector(rule.then.target, self, units, ctx);
      const aim = ruleTarget(rule.then.target, self, units, ctx, round, memo);
      if (aimed && aim && aim.target.id !== aimed.id) label += ` → ${aim.target.name} (кто доступен)`;
    }
    factors.push({ label, value: v });
  }
  return factors;
}

/** Клетка, где юнит окажется после действия: у приёма с отскоком — клетка отскока. */
function attackRestPos(self: Fighter, cand: Candidate, units: readonly Fighter[], ctx: ScoreCtx): Pos {
  if (cand.move === undefined || !isAttack(cand.action) || !cand.targetId) return cand.to;
  const move = candMove(self, cand);
  if (!move.stepBack) return cand.to;
  const target = units.find((u) => u.id === cand.targetId);
  if (!target) return cand.to;
  return stepBackDest(self, target, units, ctx) ?? cand.to;
}

/**
 * Детерминированный выбор **одного** действия при остатке `ap`.
 *
 * Действия разной цены сравниваются по `сумма факторов − AP × AP_VALUE`:
 * линейная альтернативная стоимость очка хода. Делить на цену нельзя —
 * оценка бывает отрицательной, и деление переворачивало бы смысл.
 *
 * Пас списывает **весь** остаток очков, а не ноль: он завершает ход, и
 * несделанные действия пропадают. Иначе «постоять» было бы бесплатным и
 * обыгрывало бы любое действие с небольшой пользой.
 *
 * Тайбрейк: меньше двигаться, потом дешевле, потом по порядку генерации.
 */
/**
 * Разброс весов решения (план nerve): один и тот же множитель на все слагаемые
 * с одной меткой — перекос применяется ко **всем** кандидатам решения разом,
 * поэтому боец последовательно действует по своей ошибке, а не дёргается.
 * Множитель не уходит ниже нуля: опасность можно недооценить до нуля, но
 * манить она не начинает.
 */
function sway(
  factors: Factor[],
  amp: number,
  nerve: NerveSpec | undefined,
  unitId: string,
  round: number,
  ap: number,
): Factor[] {
  if (!nerve || amp <= 0) return factors;
  return factors.map((f) => ({
    label: f.label,
    value: f.value * Math.max(0, 1 + amp * nerveRoll(nerve.seed, unitId, round, ap, f.label)),
  }));
}

export function decide(
  self: Fighter,
  units: readonly Fighter[],
  round = 1,
  blocked: (p: Pos) => boolean = NO_TERRAIN,
  ap: number = AP_PER_TURN,
  ctx: ScoreCtx = makeCtx(blocked),
): Decision {
  const fired = self.compiled.rules.filter((r) => evalCondition(r.when, self, units, round, ctx));
  const condRules = fired.filter((r) => r.when.kind !== 'always').length;

  if (!self.compiled.instincts.gapFill && fired.length === 0) {
    // буквалисту нечего исполнять — весь ход стоит за щитом, доигрывать нечем
    const action: ActionKind = ap >= AP_COST.fullCover ? 'fullCover' : 'wait';
    return {
      chosen: { to: self.pos, action },
      score: 0,
      // имя линзы в лейбл не пишем: характеры скрыты от игрока (план линз)
      factors: [{ label: 'нет правила на ситуацию — защищаюсь', value: 0 }],
      candidateCount: 1,
      condRules,
      firedCount: 0,
      stance: stanceOf(fired),
    };
  }

  const candidates = generateCandidates(self, units, ctx, ap, round, fired);
  // доступность целей одна на всё решение: юнит стоит на месте, пока выбирает
  const appealMemo: AppealMemo = new Map();
  // нерв (план nerve): давление считается раз на решение — пока боец выбирает,
  // ни его раны, ни кольцо вокруг не меняются
  const nerve = ctx.nerve;
  // фокус игрока собирает бойца: приказ, за который держатся, гасит разброс
  const calm = fired.some((r) => r.focus) ? NERVE_FOCUS_CALM : 1;
  const amp = nerve ? nerve.amp * calm * nervePressure(self, units, fired.length) : 0;
  let best: { cand: Candidate; score: number; factors: Factor[] } | undefined;
  for (const cand of candidates) {
    const factors = sway(
      scoreCandidate(cand, self, units, fired, ctx, round, appealMemo),
      amp,
      nerve,
      self.id,
      round,
      ap,
    );
    const spent = cand.action === 'wait' ? ap : candApCost(cand, self);
    const score = factors.reduce((s, f) => s + f.value, 0) - spent * AP_VALUE;
    if (
      !best ||
      score > best.score + 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 &&
        (dist(cand.to, self.pos) < dist(best.cand.to, self.pos) ||
          (dist(cand.to, self.pos) === dist(best.cand.to, self.pos) &&
            candApCost(cand, self) < candApCost(best.cand, self))))
    ) {
      best = { cand, score, factors };
    }
  }
  const b = best!;
  const top = b.factors
    .slice()
    .sort((f1, f2) => Math.abs(f2.value) - Math.abs(f1.value))
    .slice(0, 3);
  return {
    chosen: b.cand,
    score: b.score,
    factors: top,
    candidateCount: candidates.length,
    condRules,
    firedCount: fired.length,
    stance: stanceOf(fired),
  };
}

export { describePreference };
