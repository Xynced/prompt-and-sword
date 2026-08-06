import {
  type Preference,
  type Rule,
  alliesOf,
  describePreference,
  enemiesOf,
  evalCondition,
  resolvePosRef,
  resolveSelector,
} from './ir.js';
import { type CompiledBehavior, biasFor } from './lens.js';
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
  posKey,
  reachableTiles,
} from './grid.js';
import type { HazardKind, Tile } from './terrain.js';
import type { ActionKind, CombatUnit, Pos } from './types.js';
import {
  ACTION_BIAS_WEIGHT,
  AP_PER_TURN,
  AP_VALUE,
  COVER,
  FULL_COVER,
  HAZARD_DMG,
  HIGH_GROUND_DMG,
  SELFLESS_ATK_MULT,
  SELFLESS_VULN_MULT,
  TERRAIN_COVER,
  WEAK_ATK_MULT,
  expectedDamage,
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
  attack: 2,
  selflessAttack: 2,
  shieldAlly: 2,
  fullCover: 3,
  wait: 0,
};

/**
 * Цена действия для конкретного юнита. Единственное отклонение от констант:
 * осторожный шаг медленному (`move: 1`) стоит 2 AP — он не может за ход и
 * осторожно зайти на шипы, и нормально ударить.
 */
export function apCostFor(action: ActionKind, u: CombatUnit): number {
  return action === 'carefulStep' && u.move <= 1 ? 2 : AP_COST[action];
}

/** Множитель урона по виду атаки; 0 — действие не атака. */
const ATTACK_MULT: Record<ActionKind, number> = {
  weakAttack: WEAK_ATK_MULT,
  attack: 1,
  selflessAttack: SELFLESS_ATK_MULT,
  move: 0,
  carefulStep: 0,
  shove: 0,
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
  wait: 0,
};

/** Клетка, куда толчок сдвигает цель: ровно на 1 строго от толкающего. */
export function shoveDest(pusher: Pos, target: Pos): Pos {
  return {
    x: target.x + Math.sign(target.x - pusher.x),
    y: target.y + Math.sign(target.y - pusher.y),
  };
}

/** Перемещения: у обоих `to` — новая клетка; осторожный шаг не будит опасность. */
export const isMovement = (a: ActionKind): boolean => a === 'move' || a === 'carefulStep';

export const attackMult = (a: ActionKind): number => ATTACK_MULT[a];
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
const apShare = (a: ActionKind): number => AP_COST[a] / AP_COST.attack;

export interface Candidate {
  /** Клетка после действия; у всего, кроме шага, — текущая клетка юнита. */
  to: Pos;
  action: ActionKind;
  /** Цель атаки — или прикрываемый союзник для `shieldAlly`. */
  targetId?: string;
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
}

export function makeCtx(blocked: (p: Pos) => boolean = NO_TERRAIN, tiles?: readonly Tile[][]): ScoreCtx {
  const fields = new Map<string, Map<string, number>>();
  const highTiles: Pos[] = [];
  tiles?.forEach((row, y) =>
    row.forEach((t, x) => {
      if ((t.height ?? 0) > 0) highTiles.push({ x, y });
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
    blocked,
    heightAt,
    highTiles,
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
export function rangeAt(u: CombatUnit, height: number): number {
  return u.range > 1 ? u.range + height : u.range;
}

/** Плоский бонус урона стрелка с высоты 2 («бью сверху»). */
export function heightDmgBonus(u: CombatUnit, height: number): number {
  return u.range > 1 && height === 2 ? HIGH_GROUND_DMG : 0;
}

function canAttackFrom(
  from: Pos,
  attacker: Fighter,
  target: Fighter,
  units: readonly Fighter[],
  blocked: (p: Pos) => boolean,
  height = 0,
): boolean {
  const d = dist(from, target.pos);
  if (d > rangeAt(attacker, height)) return false;
  if (attacker.range === 1) return d === 1;
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

  for (const e of enemiesOf(self, units) as Fighter[]) {
    if (!canAttackFrom(here, self, e, units, blocked, ctx.heightAt(here))) continue;
    for (const action of ['weakAttack', 'attack', 'selflessAttack'] as const) {
      if (ap >= AP_COST[action] && allowed(action)) out.push({ to: here, action, targetId: e.id });
    }
  }

  // толчок: цель смежна, сдвиг строго от толкающего; в стену / в занятое /
  // за край не проходит и в кандидаты не попадает вовсе — скоринг не учится
  // «толкаться в стену». Инстинкты толчка не знают: без слова «толкать» в
  // правилах кандидатов нет — иначе поле начало бы играть само
  if (
    ap >= AP_COST.shove &&
    allowed('shove') &&
    self.compiled.rules.some((r) => r.then.kind === 'shove')
  ) {
    for (const e of enemiesOf(self, units) as Fighter[]) {
      if (dist(here, e.pos) !== 1) continue;
      const dest = shoveDest(here, e.pos);
      if (inBounds(dest) && !blocked(dest) && !units.some((u) => u.alive && posEq(u.pos, dest))) {
        out.push({ to: here, action: 'shove', targetId: e.id });
      }
    }
  }

  // прикрытие поверх такого же или лучшего ничего не даёт — не предлагаем
  for (const action of ['cover', 'fullCover'] as const) {
    if (ap >= AP_COST[action] && allowed(action) && coverLevelOf(action) > self.coverLevel) {
      out.push({ to: here, action });
    }
  }
  if (ap >= AP_COST.shieldAlly && allowed('shieldAlly')) {
    for (const a of alliesOf(self, units) as Fighter[]) {
      if (a.id !== self.id && coverLevelOf('shieldAlly') > a.coverLevel) {
        out.push({ to: here, action: 'shieldAlly', targetId: a.id });
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
 * Премия правила о манере удара своему виду атаки. Должна перебивать разницу
 * между видами по урону (около 3.5 очка между слабым и обычным ударом), иначе
 * слово не меняет ничего: приказ «бей часто» обязан пересиливать арифметику,
 * ради этого игрок его и берёт.
 */
const STRIKE_STYLE_BONUS = 2.5;

function shieldNeed(ally: Fighter, units: readonly Fighter[]): number {
  const risk = threatAt(ally.pos, ally, units) * (1 - ally.coverLevel);
  return Math.min(risk / ally.maxHp / SHIELD_FULL_RISK, 1);
}

/**
 * Ожидаемый урон конкретного вида атаки по цели с учётом её прикрытия,
 * каменного укрытия (максимум, не сумма) и открытости; из клетки from.
 */
function expectedAttackDamage(
  self: Fighter,
  action: ActionKind,
  target: CombatUnit,
  ctx: ScoreCtx,
  from: Pos,
): number {
  const mitigation = Math.max(target.coverLevel, ctx.coverFrom(from, target.pos));
  return (
    expectedDamage(self.atk) *
      attackMult(action) *
      (1 - mitigation) *
      (target.exposed ? SELFLESS_VULN_MULT : 1) +
    heightDmgBonus(self, ctx.heightAt(from))
  );
}

function nearestEnemyDist(p: Pos, self: Fighter, units: readonly Fighter[]): number {
  const es = enemiesOf(self, units);
  if (es.length === 0) return MAX_DIST;
  return Math.min(...es.map((e) => dist(e.pos, p)));
}

/** Вклад одного сработавшего правила в оценку кандидата. */
function scorePreference(
  pref: Preference,
  w: number,
  cand: Candidate,
  self: Fighter,
  units: readonly Fighter[],
  ctx: ScoreCtx,
): number {
  switch (pref.kind) {
    case 'attack': {
      const target = resolveSelector(pref.target, self, units);
      if (!target) return 0;
      // тяга к цели — но только до своей дальности: стрелок не лезет в рукопашную.
      // Дистанция путевая (BFS): у стены не залипаем, а идём к проходу.
      // Линейная и достаточно крутая, чтобы правило рулило поверх инстинктов.
      const gap = Math.max(ctx.distTo(target.pos, cand.to) - self.range, 0);
      let s = -0.6 * gap * w;
      // выстрел в укрытую цель — полдела, и премия правила скалируется
      // качеством выстрела: клетка с чистым углом обыгрывает стрельбу в камень,
      // стрелок меняет позицию, а не стоит (ближнему боя укрытие не мешает)
      const quality = 1 - ctx.coverFrom(cand.to, target.pos);
      // правило говорит, КОГО бить, а не чем: премия за потраченный ход, а не
      // за факт удара, поэтому вид атаки выбирают урон и риск, а не правило
      if (isAttack(cand.action) && cand.targetId === target.id) s += 3 * w * apShare(cand.action) * quality;
      // Шаг, из которого цель реально простреливается, — половина дела. Без
      // этого жадный цикл выбирает клетку по одной лишь тяге `-0.6 × gap`:
      // гладкий градиент почти не различает соседние цели, и разные правила
      // «бей X» / «бей Y» сходились бы к одному и тому же маршруту.
      if (
        isMovement(cand.action) &&
        canAttackFrom(cand.to, self, target as Fighter, units, ctx.blocked, ctx.heightAt(cand.to))
      ) {
        s += 1.5 * w * quality;
      }
      return s;
    }
    case 'protect': {
      const ally = units.find((u) => u.id === pref.ally && u.alive);
      if (!ally) return 0;
      if (cand.action === 'shieldAlly' && cand.targetId === ally.id) {
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
      return posEq(cand.to, self.startPos) ? 1.5 * w : -0.5 * dist(cand.to, self.startPos) * w;
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
      const expDmg = Math.min(expectedAttackDamage(self, cand.action, target, ctx, cand.to), target.hp);
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
        if (self.range === 1 && isFlanking(cand.to, target.pos, allies)) s += 2.5 * w * apShare(cand.action);
      }
      if (self.range === 1) {
        const nearest = resolveSelector('nearest', self, units);
        if (nearest) s -= 0.3 * Math.max(dist(cand.to, nearest.pos) - 1, 0) * w;
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
      return 0.5 * Math.min(dist(cand.to, anchor.pos), MAX_DIST) * w;
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
      if (cand.action === 'attack') return STRIKE_STYLE_BONUS * w;
      return isAttack(cand.action) ? -STRIKE_STYLE_BONUS * w : 0;
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
      // стоящему на опасной клетке — премия за уход на чистую
      if (ctx.hazardAt(cand.to)) return (cand.action === 'carefulStep' ? -1 : -2.2) * w;
      if (ctx.hazardAt(self.pos) && isMovement(cand.action)) return 1.5 * w;
      return 0;
    }
    case 'shove': {
      // толкать: тем ценнее, чем опаснее клетка назначения. В шипы — сильнее
      // полного удара (гарантированный урон + сбитая позиция); на чистую
      // клетку — мелкая выгода, соперник слабого удара, а не полного
      if (cand.action !== 'shove' || !cand.targetId) return 0;
      const target = units.find((u) => u.id === cand.targetId)!;
      const dest = shoveDest(self.pos, target.pos);
      return (ctx.hazardAt(dest) ? 3.5 : 0.8) * w;
    }
  }
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
    const target = units.find((u) => u.id === cand.targetId)!;
    const expDmg = Math.min(expectedAttackDamage(self, cand.action, target, ctx, cand.to), target.hp);
    const lethal = expDmg >= target.hp;
    const v = ((expDmg / target.maxHp) * 6 + (lethal ? 4 : 0)) * instincts.aggression;
    if (v !== 0) factors.push({ label: 'инстинкт:агрессия', value: v });
  }

  const hpFrac = self.hp / self.maxHp;
  const threat = threatAt(cand.to, self, units);
  if (threat > 0) {
    const v = -(threat / self.maxHp) * 2 * instincts.survival * (2 - hpFrac);
    factors.push({ label: 'инстинкт:самосохранение', value: v });
  }
  // шаг, оконченный на опасной клетке, — гарантированный урон; та же валюта,
  // что и у агрессии (доля maxHp × 6). Осторожный шаг опасность не будит
  if (cand.action === 'move' && ctx.hazardAt(cand.to)) {
    factors.push({
      label: 'инстинкт:опасная клетка',
      value: -(HAZARD_DMG / self.maxHp) * 6 * instincts.survival,
    });
  }
  if (!instincts.ignoreZoC && zocOf(self, units)(cand.to)) {
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
  if (cand.action === 'selflessAttack' && threat > 0) {
    const v = -((threat * (SELFLESS_VULN_MULT - 1)) / self.maxHp) * 6 * instincts.survival * (2 - hpFrac);
    factors.push({ label: 'инстинкт:открыться', value: v });
  }
  if (cand.action === 'shieldAlly' && cand.targetId) {
    const ally = units.find((u) => u.id === cand.targetId);
    if (ally?.alive) {
      const spared = threatAt(ally.pos, ally, units) * (1 - ally.coverLevel) * COVER;
      const v = (spared / ally.maxHp) * 6 * instincts.survival;
      if (v !== 0) factors.push({ label: 'инстинкт:прикрыть своего', value: v });
    }
  }

  for (const rule of firedRules) {
    const v = scorePreference(rule.then, rule.weight, cand, self, units, ctx);
    if (v !== 0) factors.push({ label: `правило:${rule.source}`, value: v });
  }
  return factors;
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
export function decide(
  self: Fighter,
  units: readonly Fighter[],
  round = 1,
  blocked: (p: Pos) => boolean = NO_TERRAIN,
  ap: number = AP_PER_TURN,
  ctx: ScoreCtx = makeCtx(blocked),
): Decision {
  const fired = self.compiled.rules.filter((r) => evalCondition(r.when, self, units, round));
  const condRules = fired.filter((r) => r.when.kind !== 'always').length;

  if (!self.compiled.instincts.gapFill && fired.length === 0) {
    // буквалисту нечего исполнять — весь ход стоит за щитом, доигрывать нечем
    const action: ActionKind = ap >= AP_COST.fullCover ? 'fullCover' : 'wait';
    return {
      chosen: { to: self.pos, action },
      score: 0,
      factors: [{ label: 'буквалист: нет правила на ситуацию — защищаюсь', value: 0 }],
      candidateCount: 1,
      condRules,
    };
  }

  const candidates = generateCandidates(self, units, ctx, ap);
  let best: { cand: Candidate; score: number; factors: Factor[] } | undefined;
  for (const cand of candidates) {
    const factors = scoreCandidate(cand, self, units, fired, ctx);
    const spent = cand.action === 'wait' ? ap : apCostFor(cand.action, self);
    const score = factors.reduce((s, f) => s + f.value, 0) - spent * AP_VALUE;
    if (
      !best ||
      score > best.score + 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 &&
        (dist(cand.to, self.pos) < dist(best.cand.to, self.pos) ||
          (dist(cand.to, self.pos) === dist(best.cand.to, self.pos) &&
            apCostFor(cand.action, self) < apCostFor(best.cand.action, self))))
    ) {
      best = { cand, score, factors };
    }
  }
  const b = best!;
  const top = b.factors
    .slice()
    .sort((f1, f2) => Math.abs(f2.value) - Math.abs(f1.value))
    .slice(0, 3);
  return { chosen: b.cand, score: b.score, factors: top, candidateCount: candidates.length, condRules };
}

export { describePreference };
