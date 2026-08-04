import type { Rule } from './ir.js';
import type { CharacterId } from './types.js';

/** Базовые инстинкты: множители на слагаемые utility-скоринга. */
export interface Instincts {
  aggression: number;
  survival: number;
  /** Фанатик игнорирует угрозу зон контроля. */
  ignoreZoC: boolean;
  /** Буквалист не достраивает пропуски: нет сработавшего правила → защищается на месте. */
  gapFill: boolean;
}

export interface CompiledBehavior {
  rules: Rule[];
  instincts: Instincts;
}

const BASE: Instincts = { aggression: 1, survival: 1, ignoreZoC: false, gapFill: true };

/**
 * Линза характера: детерминированная трансформация IR + инстинкты.
 * Применяется на компиляции, до боя. Пометки линзы пишутся в source —
 * из них потом собирается карточка «как понял».
 */
export function applyLens(character: CharacterId, rules: Rule[]): CompiledBehavior {
  switch (character) {
    case 'plain':
      return { rules: rules.slice(), instincts: { ...BASE } };

    case 'coward': {
      const out: Rule[] = rules.map((r) => {
        if (r.then.kind === 'protect') {
          // «прикрывать» у труса = стоять ПОЗАДИ объекта
          return {
            ...r,
            then: { kind: 'behind', ref: { type: 'ally', id: r.then.ally } },
            source: `${r.source} (трус: прикрывать = стоять позади)`,
          };
        }
        if (r.then.kind === 'bait') {
          // «приманка» требует смелости — трус просто отходит
          return {
            ...r,
            then: { kind: 'retreat' },
            source: `${r.source} (трус: приманка = просто отойти)`,
          };
        }
        if (r.then.kind === 'attack' || r.then.kind === 'trade' || r.then.kind === 'flank') {
          // рискованные правила получают штраф веса
          return { ...r, weight: r.weight * 0.7, source: `${r.source} (трус: неохотно)` };
        }
        return r;
      });
      // бежит при hp<30% несмотря ни на что
      out.push({
        when: { kind: 'hpBelow', who: 'self', frac: 0.3 },
        then: { kind: 'retreat' },
        weight: 100,
        scope: 'self',
        source: 'инстинкт труса: бежать при hp<30%',
      });
      return { rules: out, instincts: { ...BASE, aggression: 0.7, survival: 2.2 } };
    }

    case 'fanatic': {
      // «отступай» → «отступай, перебив всех» = не отступает; осторожность инвертируется
      const out: Rule[] = rules.map((r) =>
        r.then.kind === 'retreat'
          ? {
              ...r,
              then: { kind: 'attack', target: 'nearest' },
              source: `${r.source} (фанатик: отступать = перебить всех)`,
            }
          : r.then.kind === 'coverRetreat'
            ? {
                ...r,
                then: { kind: 'attack', target: 'nearest' },
                source: `${r.source} (фанатик: отход не прикрывают — добивают)`,
              }
            : r.then.kind === 'avoidLineOfFire'
              ? {
                  ...r,
                  then: { kind: 'attack', target: 'nearest' },
                  source: `${r.source} (фанатик: под огонь — так под огонь, вперёд)`,
                }
              : r,
      );
      return {
        rules: out,
        instincts: { ...BASE, aggression: 1.6, survival: 0.4, ignoreZoC: true },
      };
    }

    case 'literalist':
      // правила точно как написаны; сила и слабость — нулевая отсебятина
      return {
        rules: rules.slice(),
        instincts: { aggression: 0.15, survival: 0.15, ignoreZoC: false, gapFill: false },
      };
  }
}
