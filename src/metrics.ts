import type { BattleResult } from './battle.js';
import { dist } from './grid.js';
import type { Pos, Side } from './types.js';

/**
 * Поведенческий отпечаток боя — считается по логу событий (реплеем позиций).
 * Ворота A смотрят не только исход: разные наборы правил должны отличаться
 * ещё и процессом — иначе «цифры разные, картинка одна».
 * Метрики поведения — по стороне партии: враги в сценарии фиксированы.
 */
export interface Fingerprint {
  rounds: number;
  /** Раунд первой атаки (любой стороной); бой без атак — undefined. */
  firstContactRound?: number;
  /** Доля атак партии с фланга. */
  flankPct: number;
  /** Доля решений партии, где сработало условное (не always) правило. */
  condPct: number;
  /** Средняя по решениям партии дистанция выбранной клетки до ближайшего врага. */
  avgNearestEnemyDist: number;
  /** Доля урона партии, пришедшаяся в главную (самую обстрелянную) цель — концентрация фокус-огня. */
  focusShare: number;
}

export function fingerprint(result: BattleResult): Fingerprint {
  const pos = new Map<string, Pos>();
  const side = new Map<string, Side>();
  const alive = new Set<string>();
  let round = 0;
  let firstContactRound: number | undefined;
  let partyAttacks = 0;
  let partyFlanks = 0;
  let partyDecisions = 0;
  let partyCondDecisions = 0;
  let distSum = 0;
  let distN = 0;
  const dmgByTarget = new Map<string, number>();

  for (const e of result.events) {
    switch (e.t) {
      case 'spawn':
        pos.set(e.unit, { ...e.pos });
        side.set(e.unit, e.side);
        alive.add(e.unit);
        break;
      case 'round':
        round = e.n;
        break;
      case 'decision': {
        if (side.get(e.unit) !== 'party') break;
        partyDecisions++;
        if (e.condRules > 0) partyCondDecisions++;
        let nearest = Infinity;
        for (const id of alive) {
          if (side.get(id) === 'party') continue;
          nearest = Math.min(nearest, dist(e.to, pos.get(id)!));
        }
        if (Number.isFinite(nearest)) {
          distSum += nearest;
          distN++;
        }
        break;
      }
      case 'move':
        pos.set(e.unit, { ...e.to });
        break;
      case 'attack':
        firstContactRound ??= round;
        if (side.get(e.unit) === 'party') {
          partyAttacks++;
          if (e.flank) partyFlanks++;
          dmgByTarget.set(e.target, (dmgByTarget.get(e.target) ?? 0) + e.dmg);
        }
        break;
      case 'die':
        alive.delete(e.unit);
        break;
      default:
        break;
    }
  }

  const totalDmg = [...dmgByTarget.values()].reduce((a, b) => a + b, 0);
  return {
    rounds: result.rounds,
    ...(firstContactRound !== undefined ? { firstContactRound } : {}),
    flankPct: partyAttacks > 0 ? partyFlanks / partyAttacks : 0,
    condPct: partyDecisions > 0 ? partyCondDecisions / partyDecisions : 0,
    avgNearestEnemyDist: distN > 0 ? distSum / distN : 0,
    focusShare: totalDmg > 0 ? Math.max(...dmgByTarget.values()) / totalDmg : 0,
  };
}
