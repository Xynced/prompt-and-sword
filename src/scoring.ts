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
import type { CompiledBehavior } from './lens.js';
import {
  GRID_H,
  GRID_W,
  dist,
  distanceField,
  hasLoS,
  isFlanking,
  posEq,
  posKey,
  reachableTiles,
} from './grid.js';
import type { CombatUnit, Pos } from './types.js';
import {
  AP_PER_TURN,
  AP_VALUE,
  COVER,
  FULL_COVER,
  SELFLESS_ATK_MULT,
  SELFLESS_VULN_MULT,
  WEAK_ATK_MULT,
  expectedDamage,
} from './tuning.js';

export interface Fighter extends CombatUnit {
  compiled: CompiledBehavior;
}

export type ActionKind =
  | 'move'
  | 'weakAttack'
  | 'attack'
  | 'selflessAttack'
  | 'cover'
  | 'fullCover'
  | 'shieldAlly'
  | 'wait';

/** Цена действия в очках хода. `wait` бесплатен и завершает ход. */
export const AP_COST: Record<ActionKind, number> = {
  move: 1,
  weakAttack: 1,
  cover: 1,
  attack: 2,
  selflessAttack: 2,
  shieldAlly: 2,
  fullCover: 3,
  wait: 0,
};

/** Множитель урона по виду атаки; 0 — действие не атака. */
const ATTACK_MULT: Record<ActionKind, number> = {
  weakAttack: WEAK_ATK_MULT,
  attack: 1,
  selflessAttack: SELFLESS_ATK_MULT,
  move: 0,
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
  weakAttack: 0,
  attack: 0,
  selflessAttack: 0,
  wait: 0,
};

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

/**
 * Контекст решения: террейн боя + кэш BFS-полей дистанций (на одно решение).
 * Тяга к цели ходит по полю, а не по прямой — юниты огибают стены и
 * стягиваются в проходы вместо залипания в локальном минимуме у препятствия.
 */
export interface ScoreCtx {
  blocked: (p: Pos) => boolean;
  /** Путевая дистанция p → target по проходимым клеткам (кэш по цели). */
  distTo: (target: Pos, p: Pos) => number;
}

export function makeCtx(blocked: (p: Pos) => boolean = NO_TERRAIN): ScoreCtx {
  const fields = new Map<string, Map<string, number>>();
  return {
    blocked,
    distTo(target, p) {
      const key = posKey(target);
      let field = fields.get(key);
      if (!field) {
        field = distanceField(target, blocked);
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

function canAttackFrom(
  from: Pos,
  attacker: Fighter,
  target: Fighter,
  units: readonly Fighter[],
  blocked: (p: Pos) => boolean,
): boolean {
  const d = dist(from, target.pos);
  if (d > attacker.range) return false;
  if (attacker.range === 1) return d === 1;
  return hasLoS(
    from,
    target.pos,
    (p) => blocked(p) || units.some((u) => u.alive && u !== attacker && u !== target && posEq(u.pos, p)),
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
  blocked: (p: Pos) => boolean = NO_TERRAIN,
  ap: number = AP_PER_TURN,
): Candidate[] {
  const here = self.pos;
  const out: Candidate[] = [];

  if (ap >= AP_COST.move) {
    const byUnit = isBlockedBy(units, self);
    const occupied = (p: Pos): boolean => byUnit(p) || blocked(p);
    const zoc = zocOf(self, units);
    for (const to of reachableTiles(here, self.move, occupied, zoc)) {
      if (!posEq(to, here)) out.push({ to, action: 'move' });
    }
  }

  for (const e of enemiesOf(self, units) as Fighter[]) {
    if (!canAttackFrom(here, self, e, units, blocked)) continue;
    for (const action of ['weakAttack', 'attack', 'selflessAttack'] as const) {
      if (ap >= AP_COST[action]) out.push({ to: here, action, targetId: e.id });
    }
  }

  // прикрытие поверх такого же или лучшего ничего не даёт — не предлагаем
  for (const action of ['cover', 'fullCover'] as const) {
    if (ap >= AP_COST[action] && coverLevelOf(action) > self.coverLevel) out.push({ to: here, action });
  }
  if (ap >= AP_COST.shieldAlly) {
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

/** Ожидаемый урон конкретного вида атаки по цели с учётом её прикрытия и открытости. */
function expectedAttackDamage(self: Fighter, action: ActionKind, target: CombatUnit): number {
  return (
    expectedDamage(self.atk) *
    attackMult(action) *
    (1 - target.coverLevel) *
    (target.exposed ? SELFLESS_VULN_MULT : 1)
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
      // правило говорит, КОГО бить, а не чем: премия за потраченный ход, а не
      // за факт удара, поэтому вид атаки выбирают урон и риск, а не правило
      if (isAttack(cand.action) && cand.targetId === target.id) s += 3 * w * apShare(cand.action);
      // Шаг, из которого цель реально простреливается, — половина дела. Без
      // этого жадный цикл выбирает клетку по одной лишь тяге `-0.6 × gap`:
      // гладкий градиент почти не различает соседние цели, и разные правила
      // «бей X» / «бей Y» сходились бы к одному и тому же маршруту.
      if (cand.action === 'move' && canAttackFrom(cand.to, self, target as Fighter, units, ctx.blocked)) {
        s += 1.5 * w;
      }
      return s;
    }
    case 'protect': {
      const ally = units.find((u) => u.id === pref.ally && u.alive);
      if (!ally) return 0;
      if (cand.action === 'shieldAlly' && cand.targetId === ally.id) return 2.5 * w;
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
      const expDmg = Math.min(expectedAttackDamage(self, cand.action, target), target.hp);
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
      if (cand.action === 'shieldAlly' && cand.targetId === wounded.id) return 2.5 * w;
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

  if (isAttack(cand.action) && cand.targetId) {
    const target = units.find((u) => u.id === cand.targetId)!;
    const expDmg = Math.min(expectedAttackDamage(self, cand.action, target), target.hp);
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
  if (!instincts.ignoreZoC && zocOf(self, units)(cand.to)) {
    factors.push({ label: 'инстинкт:зона контроля', value: -1.5 * instincts.survival });
  }

  // Защитные действия и отчаянный удар оцениваются в той же валюте, что и
  // агрессия: доля maxHp × 6. Иначе выбор между «ударить сильнее» и «не
  // подставиться» решался бы не обстановкой, а случайными коэффициентами.
  const mit = coverLevelOf(cand.action);
  if (mit > 0 && cand.action !== 'shieldAlly' && threat > 0) {
    const v = ((threat * mit) / self.maxHp) * 6 * instincts.survival;
    factors.push({ label: 'инстинкт:прикрытие', value: v });
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

  const candidates = generateCandidates(self, units, blocked, ap);
  let best: { cand: Candidate; score: number; factors: Factor[] } | undefined;
  for (const cand of candidates) {
    const factors = scoreCandidate(cand, self, units, fired, ctx);
    const spent = cand.action === 'wait' ? ap : AP_COST[cand.action];
    const score = factors.reduce((s, f) => s + f.value, 0) - spent * AP_VALUE;
    if (
      !best ||
      score > best.score + 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 &&
        (dist(cand.to, self.pos) < dist(best.cand.to, self.pos) ||
          (dist(cand.to, self.pos) === dist(best.cand.to, self.pos) &&
            AP_COST[cand.action] < AP_COST[best.cand.action])))
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
