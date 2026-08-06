import type { Condition, LensMark, Rule } from './ir.js';
import type { ActionKind, LensId } from './types.js';
import { type Rng, shuffle } from './rng.js';

/** Дописать правилу след линзы; source не трогаем — он остаётся словами игрока. */
const marked = (r: Rule, m: LensMark): LensMark[] => [...(r.marks ?? []), m];

/** Множители на привлекательность конкретных действий; отсутствующий ключ = 1. */
export type ActionBias = Partial<Record<ActionKind, number>>;

/** Базовые инстинкты: множители на слагаемые utility-скоринга. */
export interface Instincts {
  aggression: number;
  survival: number;
  /** Насколько жалко своих в зоне площадного каста; 0 — «в замес — так в замес». */
  ffCare: number;
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

/**
 * Эмоциональный дрейф (план линз): детерминированный триггер и «сдвинутый»
 * режим, который защёлкивается до конца боя. Оба режима компилируются до боя;
 * защёлку держит battle.ts (эмоция не отщёлкивается, даже если условие
 * перестало быть истинным — вылеченный трус остаётся в панике).
 */
export interface MoodDrift {
  lens: LensId;
  trigger: Condition;
  rules: Rule[];
  instincts: Instincts;
}

export interface CompiledBehavior {
  rules: Rule[];
  instincts: Instincts;
  /** Дрейф первой (доминирующей) линзы с дрейфом; у стабильных характеров нет. */
  drift?: MoodDrift;
}

const BASE: Instincts = {
  aggression: 1,
  survival: 1,
  ffCare: 1,
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
  ffCare?: number;
  ignoreZoC?: true;
  gapFill?: false;
  actionBias?: ActionBias;
}

/**
 * Линза характера: детерминированная трансформация IR + инстинкты.
 * Применяется на компиляции, до боя. Следы трансформаций — структурные
 * пометки marks на правилах (source остаётся словами игрока); из них
 * строятся карточка «как понял» и реплики в журнале боя.
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
    instincts.ffCare *= step.mods.ffCare ?? 1;
    if (step.mods.ignoreZoC) instincts.ignoreZoC = true;
    if (step.mods.gapFill === false) instincts.gapFill = false;
    for (const [action, mult] of Object.entries(step.mods.actionBias ?? {})) {
      const a = action as ActionKind;
      instincts.actionBias[a] = (instincts.actionBias[a] ?? 1) * mult;
    }
  }
  // дрейф — у первой линзы по порядку, у которой он есть: доминирующая
  // черта характера; режим строится из УЖЕ трансформированных правил
  for (const lens of lenses) {
    const drift = driftFor(lens, out, instincts);
    if (drift) return { rules: out, instincts, drift };
  }
  return { rules: out, instincts };
}

/** Копия инстинктов под правку режима дрейфа. */
const cloneInstincts = (i: Instincts): Instincts => ({ ...i, actionBias: { ...i.actionBias } });

/**
 * Дрейф линзы: триггер + режим до конца боя. Правила режима без новых пометок:
 * карточка дрейф не показывает — он раскрывается событием moodShift в бою.
 */
function driftFor(lens: LensId, rules: Rule[], base: Instincts): MoodDrift | undefined {
  switch (lens) {
    case 'avenger': {
      // пал кто-то из наших — дальше все приказы читаются через ярость
      const inst = cloneInstincts(base);
      inst.aggression *= 1.3;
      return {
        lens,
        trigger: { kind: 'allyFallen' },
        rules: rules.map((r) =>
          r.then.kind === 'attack' ? { ...r, then: { kind: 'attack', target: 'attacker' } } : r,
        ),
        instincts: inst,
      };
    }
    case 'coward': {
      // довели до края — паника: бегство больше не выключается лечением
      const inst = cloneInstincts(base);
      inst.survival *= 1.3;
      return {
        lens,
        trigger: { kind: 'hpBelow', who: 'self', frac: 0.3 },
        rules: rules.map((r) =>
          r.then.kind === 'retreat' && r.when.kind === 'hpBelow' && r.when.who === 'self'
            ? { ...r, when: { kind: 'always' } }
            : r,
        ),
        instincts: inst,
      };
    }
    case 'hothead': {
      // первая кровь — закипел: бьёт ещё чаще, о защите не думает
      const inst = cloneInstincts(base);
      inst.survival *= 0.8;
      inst.actionBias.weakAttack = (inst.actionBias.weakAttack ?? 1) * 1.5;
      return { lens, trigger: { kind: 'firstBlood' }, rules: rules.slice(), instincts: inst };
    }
    case 'gloryhound': {
      // вожак пал — слава добыта или украдена: сдувается
      const inst = cloneInstincts(base);
      inst.aggression *= 0.8;
      return {
        lens,
        trigger: { kind: 'leaderDown' },
        rules: rules.map((r) => (r.then.kind === 'attack' ? { ...r, weight: r.weight * 0.8 } : r)),
        instincts: inst,
      };
    }
    default:
      return undefined;
  }
}

function applyOne(lens: LensId, rules: Rule[]): { rules: Rule[]; mods: InstinctMods } {
  switch (lens) {
    case 'plain':
      return { rules: rules.slice(), mods: {} };

    case 'coward': {
      const out: Rule[] = rules.flatMap((r): Rule[] => {
        if (r.then.kind === 'protect') {
          // контекстное прочтение: прикрывает, пока сам цел (hpAbove гасит и
          // перехват телохранителя — потрёпанный трус бросает пост); дальше
          // встаёт ПОЗАДИ объекта. Условные правила не расщепляем (двух
          // условий IR не выражает) — им остаётся старая прямая замена
          if (r.when.kind !== 'always') {
            return [
              {
                ...r,
                then: { kind: 'behind', ref: { type: 'ally', id: r.then.ally } },
                marks: marked(r, { lens: 'coward', kind: 'reword', from: r.then }),
              },
            ];
          }
          return [
            {
              ...r,
              when: { kind: 'hpAbove', who: 'self', frac: 0.5 },
              marks: marked(r, { lens: 'coward', kind: 'recondition', from: r.when }),
            },
            {
              ...r,
              when: { kind: 'hpBelow', who: 'self', frac: 0.5 },
              then: { kind: 'behind', ref: { type: 'ally', id: r.then.ally } },
              weight: r.weight * 1.5,
              marks: marked(r, { lens: 'coward', kind: 'reword', from: r.then }),
            },
          ];
        }
        if (r.then.kind === 'bait') {
          // «приманка» требует смелости — трус просто отходит
          return [
            {
              ...r,
              then: { kind: 'retreat' },
              marks: marked(r, { lens: 'coward', kind: 'reword', from: r.then }),
            },
          ];
        }
        if (r.then.kind === 'attack' || r.then.kind === 'trade' || r.then.kind === 'flank') {
          // рискованные правила получают штраф веса
          return [
            {
              ...r,
              weight: r.weight * 0.7,
              marks: marked(r, { lens: 'coward', kind: 'reweight', mult: 0.7 }),
            },
          ];
        }
        if (r.then.kind === 'strikeDesperate') {
          // отчаянный размен требует смелости — трус хотя бы бьёт в полную силу
          return [
            {
              ...r,
              then: { kind: 'strikeHard' },
              marks: marked(r, { lens: 'coward', kind: 'reword', from: r.then }),
            },
          ];
        }
        if (r.then.kind === 'rage') {
          // ярость — «получать больнее до конца боя»?! трус на такое не подпишется
          return [
            {
              ...r,
              then: { kind: 'brace' },
              marks: marked(r, { lens: 'coward', kind: 'reword', from: r.then }),
            },
          ];
        }
        if (r.then.kind === 'standoff') {
          // держать дистанцию — трусу по сердцу: исполняет рьяно
          return [
            {
              ...r,
              weight: r.weight * 1.3,
              marks: marked(r, { lens: 'coward', kind: 'reweight', mult: 1.3 }),
            },
          ];
        }
        return [r];
      });
      // бежит при hp<30% несмотря ни на что
      out.push({
        when: { kind: 'hpBelow', who: 'self', frac: 0.3 },
        then: { kind: 'retreat' },
        weight: 100,
        scope: 'self',
        source: 'инстинкт: бежать при hp<30%',
        marks: [{ lens: 'coward', kind: 'instinct' }],
      });
      return {
        rules: out,
        mods: {
          aggression: 0.7,
          survival: 2.2,
          // за щитом отсидеться — первое, что приходит в голову; открыться —
          // последнее; на опасное поле — только осторожно, даже где не надо
          actionBias: { cover: 1.5, fullCover: 1.2, selflessAttack: 0.2, carefulStep: 1.5 },
        },
      };
    }

    case 'fanatic': {
      // «отступай» → «отступай, перебив всех» = не отступает; осторожность инвертируется
      const out: Rule[] = rules.map((r) =>
        r.then.kind === 'retreat' ||
        r.then.kind === 'coverRetreat' ||
        r.then.kind === 'avoidLineOfFire' ||
        r.then.kind === 'standoff' ||
        r.then.kind === 'brace'
          ? {
              ...r,
              then: { kind: 'attack', target: 'nearest' },
              marks: marked(r, { lens: 'fanatic', kind: 'reword', from: r.then }),
            }
          : r.then.kind === 'strikeOften' || r.then.kind === 'strikeHard'
            ? {
                // любая манера удара у фанатика — отчаянная
                ...r,
                then: { kind: 'strikeDesperate' },
                marks: marked(r, { lens: 'fanatic', kind: 'reword', from: r.then }),
              }
            : r.then.kind === 'rage' && r.when.kind !== 'always'
              ? {
                  // ждать повода для ярости? она не ждёт
                  ...r,
                  when: { kind: 'always' },
                  marks: marked(r, { lens: 'fanatic', kind: 'recondition', from: r.when }),
                }
              : r,
      );
      return {
        rules: out,
        mods: {
          aggression: 1.6,
          survival: 0.4,
          // свои в зоне каста не жалко: в замес — так в замес (план АОЕ)
          ffCare: 0,
          ignoreZoC: true,
          // щиты — для трусов: глухая защита исключена вовсе, размен ран — норма;
          // красться по шипам смешно, а толкать — недостаточно кроваво: бей!
          actionBias: { selflessAttack: 2.5, cover: 0.3, fullCover: 0, carefulStep: 0.3, shove: 0 },
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
        source: 'инстинкт: кто меня ударил — тот умрёт',
        marks: [{ lens: 'avenger', kind: 'instinct' }],
      });
      return { rules: out, mods: { aggression: 1.2 } };
    }

    case 'duelist': {
      const out: Rule[] = rules.flatMap((r): Rule[] => {
        if (r.then.kind === 'attack' && r.then.target === 'weakest') {
          // добивать слабых — бесчестье… пока силы равны; в меньшинстве —
          // война есть война: ситуационное правило перевешивает
          const challenge: Rule = {
            ...r,
            then: { kind: 'attack', target: 'mostDangerous' },
            marks: marked(r, { lens: 'duelist', kind: 'reword', from: r.then }),
          };
          if (r.when.kind !== 'always') return [challenge];
          return [
            challenge,
            {
              ...r,
              when: { kind: 'outnumbered' },
              weight: r.weight * 1.5,
              marks: marked(r, { lens: 'duelist', kind: 'reword', from: r.then }),
            },
          ];
        }
        if (r.then.kind === 'flank') {
          // бить в спину — бесчестье
          return [
            {
              ...r,
              then: { kind: 'attack', target: 'nearest' },
              marks: marked(r, { lens: 'duelist', kind: 'reword', from: r.then }),
            },
          ];
        }
        return [r];
      });
      // вполсилы не бьёт — это оскорбление противника; толкаться — недостойно;
      // бить по площади, не глядя противнику в лицо, — тем более (план АОЕ)
      return {
        rules: out,
        mods: { aggression: 1.1, actionBias: { weakAttack: 0.85, shove: 0, aoeBlast: 0, aoeLine: 0, aoeRitual: 0 } },
      };
    }

    case 'gloryhound': {
      // слава — это голова вожака; остальные цели недостойны
      const out: Rule[] = rules.map((r) =>
        r.then.kind === 'attack' && r.then.target !== 'leader'
          ? {
              ...r,
              then: { kind: 'attack', target: 'leader' },
              marks: marked(r, { lens: 'gloryhound', kind: 'reword', from: r.then }),
            }
          : r,
      );
      return { rules: out, mods: { aggression: 1.25, survival: 0.85 } };
    }

    case 'guardian': {
      const out: Rule[] = rules.flatMap((r): Rule[] => {
        if (r.then.kind !== 'protect' && r.then.kind !== 'coverRetreat') return [r];
        const boosted: Rule = {
          ...r,
          weight: r.weight * 1.4,
          marks: marked(r, { lens: 'guardian', kind: 'reweight', mult: 1.4 }),
        };
        // контекстное прочтение: подопечного потрепали — всё остальное подождёт
        if (r.then.kind === 'protect' && r.when.kind === 'always') {
          return [
            boosted,
            {
              ...r,
              when: { kind: 'hpBelow', who: { ally: r.then.ally }, frac: 0.5 },
              weight: r.weight * 2.5,
              marks: marked(r, { lens: 'guardian', kind: 'reword', from: r.then }),
            },
          ];
        }
        return [boosted];
      });
      out.push({
        when: { kind: 'always' },
        then: { kind: 'coverRetreat' },
        weight: 1.2,
        scope: 'self',
        source: 'инстинкт: прикрывать самого раненого',
        marks: [{ lens: 'guardian', kind: 'instinct' }],
      });
      return {
        rules: out,
        mods: {
          aggression: 0.85,
          survival: 1.2,
          // закрыть своего собой — самый понятный наседке способ потратить ход;
          // стена (укрыть всех разом) — ещё роднее щита одному: ×3 против ×2.2
          // сдвигает выбор в её пользу даже при единственном подопечном
          actionBias: { shieldAlly: 2.2, wall: 3 },
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
        source: 'инстинкт: везде мерещатся стрелки',
        marks: [{ lens: 'paranoid', kind: 'instinct' }],
      });
      return {
        rules: out,
        // осторожный шаг — параноику родной: мало ли что там под ногами
        mods: { aggression: 0.85, survival: 1.5, actionBias: { cover: 1.8, carefulStep: 1.5 } },
      };
    }

    case 'hothead': {
      const out: Rule[] = rules.flatMap((r): Rule[] => {
        if (r.then.kind === 'strikeHard') {
          // терпения примеряться хватает, пока бой свеж; затянулся —
          // ситуационное правило перевешивает: бьёт часто и как попало
          if (r.when.kind !== 'always') {
            return [
              {
                ...r,
                then: { kind: 'strikeOften' },
                marks: marked(r, { lens: 'hothead', kind: 'reword', from: r.then }),
              },
            ];
          }
          return [
            r,
            {
              ...r,
              when: { kind: 'battleDrags' },
              then: { kind: 'strikeOften' },
              weight: r.weight * 1.5,
              marks: marked(r, { lens: 'hothead', kind: 'reword', from: r.then }),
            },
          ];
        }
        if (r.then.kind === 'holdPosition' || r.then.kind === 'bait' || r.then.kind === 'brace') {
          // стоять, приманивать, отсиживаться за щитом — невыносимо
          return [
            {
              ...r,
              then: { kind: 'attack', target: 'nearest' },
              marks: marked(r, { lens: 'hothead', kind: 'reword', from: r.then }),
            },
          ];
        }
        return [r];
      });
      return {
        rules: out,
        mods: {
          aggression: 1.35,
          survival: 0.75,
          // бьёт сразу и часто, примеряться и прикрываться некогда; замах на
          // целый ход с ударом через ход — пытка: жги залпом сейчас (план АОЕ)
          actionBias: { weakAttack: 3, cover: 0.5, aoeRitual: 0.3 },
        },
      };
    }

    case 'showman': {
      const out: Rule[] = rules.map((r) =>
        r.then.kind === 'flank'
          ? {
              ...r,
              weight: r.weight * 1.5,
              marks: marked(r, { lens: 'showman', kind: 'reweight', mult: 1.5 }),
            }
          : r,
      );
      out.push({
        when: { kind: 'always' },
        then: { kind: 'bait' },
        weight: 1.1,
        scope: 'self',
        source: 'инстинкт: красоваться перед строем врага',
        marks: [{ lens: 'showman', kind: 'instinct' }],
      });
      // широкий жест на публику дороже расчёта
      return {
        rules: out,
        mods: { aggression: 1.1, survival: 0.9, actionBias: { selflessAttack: 1.5 } },
      };
    }
  }
}
