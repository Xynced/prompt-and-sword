import type { Rule } from './ir.js';
import type { ActionKind, LensId } from './types.js';
import { type Rng, shuffle } from './rng.js';

/** Множители на привлекательность конкретных действий; отсутствующий ключ = 1. */
export type ActionBias = Partial<Record<ActionKind, number>>;

/** Базовые инстинкты: множители на слагаемые utility-скоринга. */
export interface Instincts {
  aggression: number;
  survival: number;
  /** Фанатик игнорирует угрозу зон контроля. */
  ignoreZoC: boolean;
  /** Буквалист не достраивает пропуски: нет сработавшего правила → защищается на месте. */
  gapFill: boolean;
  /**
   * На что характер охотнее тратит очки хода. Правило говорит, кого бить и
   * куда идти, — а чем именно бить и прикрываться ли, решает эта таблица.
   * Множится на «тягу» действия, но не на его цену: трус боится открыться
   * ровно так же, как все, он просто реже хочет.
   */
  actionBias: ActionBias;
}

export interface CompiledBehavior {
  rules: Rule[];
  instincts: Instincts;
}

const BASE: Instincts = {
  aggression: 1,
  survival: 1,
  ignoreZoC: false,
  gapFill: true,
  actionBias: {},
};

/** Тяга характера к действию; 1 — как у всех. */
export function biasFor(instincts: Instincts, action: ActionKind): number {
  return instincts.actionBias[action] ?? 1;
}

/** Короткие русские имена линз — для карточек, интела и пометок в source. */
export const LENS_RU: Record<LensId, string> = {
  plain: 'обычный',
  coward: 'трус',
  fanatic: 'фанатик',
  literalist: 'буквалист',
  avenger: 'мститель',
  duelist: 'дуэлянт',
  gloryhound: 'славолюб',
  guardian: 'наседка',
  paranoid: 'параноик',
  hothead: 'горячка',
  showman: 'позёр',
};

/** Пул случайной генерации: все линзы, кроме нейтральной plain. */
export const LENS_POOL: readonly LensId[] = [
  'coward',
  'fanatic',
  'literalist',
  'avenger',
  'duelist',
  'gloryhound',
  'guardian',
  'paranoid',
  'hothead',
  'showman',
];

/** 1–3 случайные линзы без повторов; детерминировано от rng. */
export function rollLenses(rng: Rng): LensId[] {
  const count = 1 + Math.floor(rng() * 3);
  return shuffle(LENS_POOL, rng).slice(0, count);
}

/** Поправки одной линзы к инстинктам: множители и флаги поверх базы. */
interface InstinctMods {
  aggression?: number;
  survival?: number;
  ignoreZoC?: true;
  gapFill?: false;
  actionBias?: ActionBias;
}

/**
 * Линза характера: детерминированная трансформация IR + инстинкты.
 * Применяется на компиляции, до боя. Пометки линзы пишутся в source —
 * из них потом собирается карточка «как понял».
 *
 * У персонажа 1–3 линзы; они применяются по порядку списка: правила
 * трансформируются последовательно, множители инстинктов перемножаются.
 */
export function applyLens(lenses: readonly LensId[], rules: Rule[]): CompiledBehavior {
  let out = rules.slice();
  // actionBias копируем отдельно: без этого все вызовы делили бы один объект
  // с BASE и накапливали в нём тягу каждой применённой линзы навсегда
  const instincts: Instincts = { ...BASE, actionBias: { ...BASE.actionBias } };
  for (const lens of lenses) {
    const step = applyOne(lens, out);
    out = step.rules;
    instincts.aggression *= step.mods.aggression ?? 1;
    instincts.survival *= step.mods.survival ?? 1;
    if (step.mods.ignoreZoC) instincts.ignoreZoC = true;
    if (step.mods.gapFill === false) instincts.gapFill = false;
    for (const [action, mult] of Object.entries(step.mods.actionBias ?? {})) {
      const a = action as ActionKind;
      instincts.actionBias[a] = (instincts.actionBias[a] ?? 1) * mult;
    }
  }
  return { rules: out, instincts };
}

function applyOne(lens: LensId, rules: Rule[]): { rules: Rule[]; mods: InstinctMods } {
  switch (lens) {
    case 'plain':
      return { rules: rules.slice(), mods: {} };

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
        if (r.then.kind === 'standoff') {
          // держать дистанцию — трусу по сердцу: исполняет рьяно
          return { ...r, weight: r.weight * 1.3, source: `${r.source} (трус: дистанция — это святое)` };
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
      return {
        rules: out,
        mods: {
          aggression: 0.7,
          survival: 2.2,
          // за щитом отсидеться — первое, что приходит в голову; открыться — последнее
          actionBias: { cover: 1.5, fullCover: 1.2, selflessAttack: 0.2 },
        },
      };
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
              : r.then.kind === 'standoff'
                ? {
                    ...r,
                    then: { kind: 'attack', target: 'nearest' },
                    source: `${r.source} (фанатик: моя дистанция — длина клинка)`,
                  }
                : r.then.kind === 'brace'
                  ? {
                      ...r,
                      then: { kind: 'attack', target: 'nearest' },
                      source: `${r.source} (фанатик: щиты — для трусов)`,
                    }
                  : r,
      );
      return {
        rules: out,
        mods: {
          aggression: 1.6,
          survival: 0.4,
          ignoreZoC: true,
          // щиты — для трусов: глухая защита исключена вовсе, размен ран — норма
          actionBias: { selflessAttack: 2.5, cover: 0.3, fullCover: 0 },
        },
      };
    }

    case 'literalist':
      // правила точно как написаны; сила и слабость — нулевая отсебятина
      return { rules: rules.slice(), mods: { aggression: 0.15, survival: 0.15, gapFill: false } };

    case 'avenger': {
      // обиды не прощает: последний обидчик становится целью
      const out = rules.slice();
      out.push({
        when: { kind: 'always' },
        then: { kind: 'attack', target: 'attacker' },
        weight: 2.5,
        scope: 'self',
        source: 'инстинкт мстителя: кто меня ударил — тот умрёт',
      });
      return { rules: out, mods: { aggression: 1.2 } };
    }

    case 'duelist': {
      const out: Rule[] = rules.map((r) => {
        if (r.then.kind === 'attack' && r.then.target === 'weakest') {
          // добивать слабых — бесчестье
          return {
            ...r,
            then: { kind: 'attack', target: 'mostDangerous' },
            source: `${r.source} (дуэлянт: слабых не добиваю — вызываю сильнейшего)`,
          };
        }
        if (r.then.kind === 'flank') {
          // бить в спину — бесчестье
          return {
            ...r,
            then: { kind: 'attack', target: 'nearest' },
            source: `${r.source} (дуэлянт: в спину не бью — только лицом к лицу)`,
          };
        }
        return r;
      });
      // вполсилы не бьёт — это оскорбление противника
      return { rules: out, mods: { aggression: 1.1, actionBias: { weakAttack: 0.7 } } };
    }

    case 'gloryhound': {
      // слава — это голова вожака; остальные цели недостойны
      const out: Rule[] = rules.map((r) =>
        r.then.kind === 'attack' && r.then.target !== 'leader'
          ? {
              ...r,
              then: { kind: 'attack', target: 'leader' },
              source: `${r.source} (славолюб: достойная цель — только вожак)`,
            }
          : r,
      );
      return { rules: out, mods: { aggression: 1.25, survival: 0.85 } };
    }

    case 'guardian': {
      const out: Rule[] = rules.map((r) =>
        r.then.kind === 'protect' || r.then.kind === 'coverRetreat'
          ? { ...r, weight: r.weight * 1.4, source: `${r.source} (наседка: своих не бросаю)` }
          : r,
      );
      out.push({
        when: { kind: 'always' },
        then: { kind: 'coverRetreat' },
        weight: 1.2,
        scope: 'self',
        source: 'инстинкт наседки: прикрывать самого раненого',
      });
      return {
        rules: out,
        mods: {
          aggression: 0.85,
          survival: 1.2,
          // закрыть своего собой — самый понятный наседке способ потратить ход
          actionBias: { shieldAlly: 3 },
        },
      };
    }

    case 'paranoid': {
      const out = rules.slice();
      out.push({
        when: { kind: 'always' },
        then: { kind: 'avoidLineOfFire' },
        weight: 1.5,
        scope: 'self',
        source: 'инстинкт параноика: везде мерещатся стрелки',
      });
      return {
        rules: out,
        mods: { aggression: 0.85, survival: 1.5, actionBias: { cover: 1.8 } },
      };
    }

    case 'hothead': {
      const out: Rule[] = rules.map((r) =>
        r.then.kind === 'holdPosition'
          ? {
              ...r,
              then: { kind: 'attack', target: 'nearest' },
              source: `${r.source} (горячка: стоять на месте невыносимо)`,
            }
          : r.then.kind === 'bait'
            ? {
                ...r,
                then: { kind: 'attack', target: 'nearest' },
                source: `${r.source} (горячка: приманивать? просто нападу)`,
              }
            : r.then.kind === 'brace'
              ? {
                  ...r,
                  then: { kind: 'attack', target: 'nearest' },
                  source: `${r.source} (горячка: отсиживаться за щитом невыносимо)`,
                }
              : r,
      );
      return {
        rules: out,
        mods: {
          aggression: 1.35,
          survival: 0.75,
          // бьёт сразу и часто, примеряться и прикрываться некогда
          actionBias: { weakAttack: 3, cover: 0.5 },
        },
      };
    }

    case 'showman': {
      const out: Rule[] = rules.map((r) =>
        r.then.kind === 'flank'
          ? { ...r, weight: r.weight * 1.5, source: `${r.source} (позёр: эффектный заход — это по мне)` }
          : r,
      );
      out.push({
        when: { kind: 'always' },
        then: { kind: 'bait' },
        weight: 1.1,
        scope: 'self',
        source: 'инстинкт позёра: красоваться перед строем врага',
      });
      // широкий жест на публику дороже расчёта
      return {
        rules: out,
        mods: { aggression: 1.1, survival: 0.9, actionBias: { selflessAttack: 1.5 } },
      };
    }
  }
}
