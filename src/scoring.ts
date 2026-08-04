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
import { dist, hasLoS, isFlanking, posEq, reachableTiles } from './grid.js';
import type { CombatUnit, Pos } from './types.js';

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
}

const MAX_DIST = 7;

function isBlockedBy(units: readonly Fighter[], except: Fighter): (p: Pos) => boolean {
  return (p) => units.some((u) => u.alive && u !== except && posEq(u.pos, p));
}

/** ZoC проецируют живые враги ближнего боя (range 1) на смежные клетки. */
function zocOf(self: Fighter, units: readonly Fighter[]): (p: Pos) => boolean {
  const melee = enemiesOf(self, units).filter((e) => e.range === 1);
  return (p) => melee.some((e) => dist((e as Fighter).pos, p) === 1);
}

function canAttackFrom(from: Pos, attacker: Fighter, target: Fighter, units: readonly Fighter[]): boolean {
  const d = dist(from, target.pos);
  if (d > attacker.range) return false;
  if (attacker.range === 1) return d === 1;
  return hasLoS(from, target.pos, (p) =>
    units.some((u) => u.alive && u !== attacker && u !== target && posEq(u.pos, p)),
  );
}

export function generateCandidates(self: Fighter, units: readonly Fighter[]): Candidate[] {
  const occupied = isBlockedBy(units, self);
  const zoc = zocOf(self, units);
  const tiles = reachableTiles(self.pos, self.move, occupied, zoc);
  const enemies = enemiesOf(self, units) as Fighter[];
  const out: Candidate[] = [];
  for (const to of tiles) {
    for (const e of enemies) {
      if (canAttackFrom(to, self, e, units)) out.push({ to, action: 'attack', targetId: e.id });
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
): number {
  switch (pref.kind) {
    case 'attack': {
      const target = resolveSelector(pref.target, self, units);
      if (!target) return 0;
      // тяга к цели — но только до своей дальности: стрелок не лезет в рукопашную.
      // Линейная и достаточно крутая, чтобы правило рулило поверх инстинктов.
      const gap = Math.max(dist(cand.to, target.pos) - self.range, 0);
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
      const expDmg = Math.min(self.atk * (target.defending ? 0.5 : 1), target.hp);
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
            units.some((u) => u.alive && u !== self && u !== e && posEq(u.pos, p)),
          ),
      ).length;
      return -1.2 * exposed * w;
    }
    case 'brace': {
      // глухая оборона: ценна, когда враги реально достают до клетки
      if (cand.action !== 'defend') return 0;
      const reachable = (enemiesOf(self, units) as Fighter[]).filter(
        (e) => dist(e.pos, cand.to) <= e.move + e.range,
      ).length;
      return (0.8 + 0.6 * Math.min(reachable, 2)) * w;
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
    .filter((e) => dist(e.pos, p) <= e.move + e.range)
    .reduce((sum, e) => sum + e.atk, 0);
}

export function scoreCandidate(
  cand: Candidate,
  self: Fighter,
  units: readonly Fighter[],
  firedRules: readonly Rule[],
): Factor[] {
  const { instincts } = self.compiled;
  const factors: Factor[] = [];

  if (cand.action === 'attack' && cand.targetId) {
    const target = units.find((u) => u.id === cand.targetId)!;
    const expDmg = Math.min(self.atk * (target.defending ? 0.5 : 1), target.hp);
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
    const v = scorePreference(rule.then, rule.weight, cand, self, units);
    if (v !== 0) factors.push({ label: `правило:${rule.source}`, value: v });
  }
  return factors;
}

/** Детерминированный выбор действия: max score, тайбрейк — меньше двигаться, потом по порядку. */
export function decide(self: Fighter, units: readonly Fighter[], round = 1): Decision {
  const fired = self.compiled.rules.filter((r) => evalCondition(r.when, self, units, round));

  if (!self.compiled.instincts.gapFill && fired.length === 0) {
    return {
      chosen: { to: self.pos, action: 'defend' },
      score: 0,
      factors: [{ label: 'буквалист: нет правила на ситуацию — защищаюсь', value: 0 }],
      candidateCount: 1,
    };
  }

  const candidates = generateCandidates(self, units);
  let best: { cand: Candidate; score: number; factors: Factor[] } | undefined;
  for (const cand of candidates) {
    const factors = scoreCandidate(cand, self, units, fired);
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
  return { chosen: b.cand, score: b.score, factors: top, candidateCount: candidates.length };
}

export { describePreference };
