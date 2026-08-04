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
import { expectedDamage } from './tuning.js';

export interface Fighter extends CombatUnit {
  compiled: CompiledBehavior;
}

export type ActionKind = 'attack' | 'defend' | 'wait';

export interface Candidate {
  to: Pos;
  action: ActionKind;
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

export function generateCandidates(
  self: Fighter,
  units: readonly Fighter[],
  blocked: (p: Pos) => boolean = NO_TERRAIN,
): Candidate[] {
  const byUnit = isBlockedBy(units, self);
  const occupied = (p: Pos): boolean => byUnit(p) || blocked(p);
  const zoc = zocOf(self, units);
  const tiles = reachableTiles(self.pos, self.move, occupied, zoc);
  const enemies = enemiesOf(self, units) as Fighter[];
  const out: Candidate[] = [];
  for (const to of tiles) {
    for (const e of enemies) {
      if (canAttackFrom(to, self, e, units, blocked)) out.push({ to, action: 'attack', targetId: e.id });
    }
    out.push({ to, action: 'defend' });
  }
  out.push({ to: self.pos, action: 'wait' });
  return out;
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
      if (cand.action === 'attack' && cand.targetId === target.id) s += 3 * w;
      return s;
    }
    case 'protect': {
      const ally = units.find((u) => u.id === pref.ally && u.alive);
      if (!ally) return 0;
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
      const reachable = enemies.filter((e) => dist(e.pos, cand.to) <= e.move + e.range).length;
      const inRange = enemies.filter((e) => dist(e.pos, cand.to) <= e.range).length;
      return (0.5 * reachable - 0.7 * inRange) * w;
    }
    case 'trade': {
      // размен: жать атаку, если она добивает или снимает много — угрозу перевешивает вес
      if (cand.action !== 'attack' || !cand.targetId) return 0;
      const target = units.find((u) => u.id === cand.targetId)!;
      const expDmg = Math.min(expectedDamage(self.atk) * (target.defending ? 0.5 : 1), target.hp);
      return expDmg >= target.hp ? 3 * w : 1.5 * (expDmg / target.maxHp) * w;
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
      if (cand.action === 'attack' && cand.targetId) {
        const target = units.find((u) => u.id === cand.targetId)!;
        const allies = units
          .filter((u) => u.alive && u.side === self.side && u !== self)
          .map((u) => u.pos);
        if (self.range === 1 && isFlanking(cand.to, target.pos, allies)) s += 2.5 * w;
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
  }
}

function threatAt(p: Pos, self: Fighter, units: readonly Fighter[]): number {
  return (enemiesOf(self, units) as Fighter[])
    .filter((e) => dist(e.pos, p) <= e.move + e.range)
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

  if (cand.action === 'attack' && cand.targetId) {
    const target = units.find((u) => u.id === cand.targetId)!;
    const expDmg = Math.min(expectedDamage(self.atk) * (target.defending ? 0.5 : 1), target.hp);
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
  if (cand.action === 'defend' && threat > 0) {
    factors.push({ label: 'инстинкт:глухая оборона', value: 1 * instincts.survival });
  }

  for (const rule of firedRules) {
    const v = scorePreference(rule.then, rule.weight, cand, self, units, ctx);
    if (v !== 0) factors.push({ label: `правило:${rule.source}`, value: v });
  }
  return factors;
}

/** Детерминированный выбор действия: max score, тайбрейк — меньше двигаться, потом по порядку. */
export function decide(
  self: Fighter,
  units: readonly Fighter[],
  round = 1,
  blocked: (p: Pos) => boolean = NO_TERRAIN,
): Decision {
  const fired = self.compiled.rules.filter((r) => evalCondition(r.when, self, units, round));
  const condRules = fired.filter((r) => r.when.kind !== 'always').length;

  if (!self.compiled.instincts.gapFill && fired.length === 0) {
    return {
      chosen: { to: self.pos, action: 'defend' },
      score: 0,
      factors: [{ label: 'буквалист: нет правила на ситуацию — защищаюсь', value: 0 }],
      candidateCount: 1,
      condRules,
    };
  }

  const ctx = makeCtx(blocked);
  const candidates = generateCandidates(self, units, blocked);
  let best: { cand: Candidate; score: number; factors: Factor[] } | undefined;
  for (const cand of candidates) {
    const factors = scoreCandidate(cand, self, units, fired, ctx);
    const score = factors.reduce((s, f) => s + f.value, 0);
    if (
      !best ||
      score > best.score + 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 && dist(cand.to, self.pos) < dist(best.cand.to, self.pos))
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
