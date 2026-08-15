import { type Rng, mulberry32, shuffle } from './rng.js';
import { AP_PER_TURN, COVER, FULL_COVER, HAZARD_DMG, RIPOSTE_DMG, SELFLESS_VULN_MULT, expectedDamage } from './tuning.js';
import { applyLens } from './lens.js';
import { type Rule, evalCondition, resolveAlly } from './ir.js';
import { dist, hasLoS, inBounds, isFlanking, posEq } from './grid.js';
import { type ArenaTag, type HazardKind, type Tile, pickTerrain } from './terrain.js';
import type { ActiveSpec, AoeSpec, LensId, PassiveSpec, Pos, Side, WeaponSpec } from './types.js';
import {
  type ActionKind,
  type Decision,
  type Fighter,
  AOE_RITUAL_RADIUS,
  aoeDamage,
  aoeVictims,
  apCostFor,
  blastReady,
  castVictims,
  ritualReady,
  attackMult,
  coverLevelOf,
  decide,
  effectiveCover,
  heightDmgBonus,
  isAttack,
  isMovement,
  makeCtx,
  stanceAttackMult,
  stanceMitigation,
  blessMult,
  blessReady,
  healReady,
  retributionMult,
  rageDmgMult,
  rageReady,
  rageVulnMult,
  rangeAt,
  shadowMult,
  shoveDest,
  wallReady,
  weaponsOf,
} from './scoring.js';

export interface UnitSpec {
  id: string;
  name: string;
  side: Side;
  maxHp: number;
  /** Стартовое hp боя (перенос между боями забега); по умолчанию maxHp. */
  hp?: number;
  /**
   * Оружие юнита (план классов) — носитель урона и дальности. Шортхенд для
   * тестов и сценариев: вместо weapons можно задать atk/range — соберётся
   * неявное безымянное оружие.
   */
  weapons?: WeaponSpec[];
  atk?: number;
  range?: number;
  speed: number;
  move: number;
  tags?: string[];
  /** Линзы характера в порядке применения. */
  lenses: LensId[];
  rules: Rule[];
  /** Площадное оружие носителя АОЕ (план АОЕ); в норме живёт в weapons[].aoe. */
  aoe?: AoeSpec;
  /** Классовые активы (план классов); без спеки кандидатов действия нет. */
  active?: ActiveSpec;
  /** Классовые пассивы (план классов); всегда включены, слов не требуют. */
  passives?: PassiveSpec;
  /** Фиксированная точка спавна; у врагов без неё слот выбирается по сиду. */
  spawn?: Pos;
}

/**
 * Задача боя (план objectives): чем кончается бой помимо «перебей всех».
 * killTarget — смерть цели решает бой мгновенно, остальных можно не трогать;
 * killBefore — то же, но если цель жива к началу раунда round, бой проигран;
 * survive — партия жива к концу раунда rounds = победа, врагов можно не бить.
 */
export type Objective =
  | { kind: 'eliminate' }
  | { kind: 'killTarget'; targetId: string }
  | { kind: 'killBefore'; targetId: string; round: number }
  | { kind: 'survive'; rounds: number };

/** Волна подкреплений: выходит на поле в начале раунда и действует в нём же. */
export interface Wave {
  round: number;
  specs: UnitSpec[];
}

export interface BattleSetup {
  objective?: Objective;
  waves?: Wave[];
}

export type BattleEvent =
  | { t: 'spawn'; unit: string; name: string; side: Side; pos: Pos; maxHp: number }
  | { t: 'round'; n: number }
  | ({ t: 'decision'; unit: string; round: number } & Pick<Decision, 'factors' | 'condRules' | 'firedCount'> & {
      to: Pos;
      action: ActionKind;
      target?: string;
      /** Центр зоны площадного каста. */
      at?: Pos;
      /** Очков хода на момент решения (до списания цены действия). */
      ap: number;
    })
  | { t: 'move'; unit: string; from: Pos; to: Pos }
  | { t: 'hazard'; unit: string; kind: HazardKind; dmg: number; hp: number }
  | { t: 'shove'; unit: string; target: string; from: Pos; to: Pos }
  /** Обмен местами (план teamwork): `from` — клетка затевающего (туда встаёт подопечный), `to` — его новая. */
  | { t: 'swap'; unit: string; target: string; from: Pos; to: Pos }
  /** holds: зона «полымя» держится — будут ещё залпы (пульсы Весты). */
  | { t: 'aoeCast'; unit: string; form: 'blast' | 'line' | 'ritual'; at: Pos; holds?: true }
  /** Вошёл в ярость: урон и уязвимость по спеке актива — до конца боя. */
  | { t: 'rage'; unit: string }
  /** Охотник пометил цель: тег marked для всей его стороны (прежняя метка снята). */
  | { t: 'mark'; unit: string; target: string }
  /** Исцеление: цели восстановлено amount hp (после капа), hp — итог. */
  | { t: 'heal'; unit: string; target: string; amount: number; hp: number }
  /** Регенерация: юнит зарастает в начале своего хода (пассив regen). */
  | { t: 'regen'; unit: string; amount: number; hp: number }
  /** Эмоциональный дрейф (план линз): триггер сработал, режим защёлкнут до конца боя. */
  | { t: 'moodShift'; unit: string; lens: LensId }
  /** Благословение: атаки цели ×mult до конца боя. */
  | { t: 'bless'; unit: string; target: string; mult: number }
  /** Финт: цель открыта (входящий ×SELFLESS_VULN_MULT) до её следующего хода. */
  | { t: 'feint'; unit: string; target: string }
  /** Перехват: телохранитель принимает удар, предназначенный подопечному. */
  | { t: 'intercept'; unit: string; target: string }
  /** Рипост: ближний удар по глухой обороне ранит бьющего (`unit`); by — оборонявшийся. */
  | { t: 'riposte'; unit: string; by: string; dmg: number; hp: number }
  | { t: 'aoeHit'; unit: string; by: string; dmg: number; hp: number }
  /** Замах ритуала: зона 5×5 у `at` объявлена, ударит в начале следующего хода кастера. */
  | { t: 'telegraph'; unit: string; at: Pos; dmg: number }
  | {
      t: 'attack';
      unit: string;
      action: ActionKind;
      target: string;
      dmg: number;
      flank: boolean;
      targetHp: number;
    }
  | { t: 'cover'; unit: string; level: number; ally?: string }
  | { t: 'wait'; unit: string }
  | { t: 'die'; unit: string }
  | { t: 'end'; winner: Side | 'draw'; rounds: number };

export interface BattleResult {
  winner: Side | 'draw';
  rounds: number;
  events: BattleEvent[];
  units: Fighter[];
  /** Террейн боя: имя и вопрос схемы, клетки [y][x] — для отрисовки и разбора. */
  terrain: { name: string; scenario: string; tiles: Tile[][] };
}

const MAX_ROUNDS = 30;
const FOE_SPAWN_SLOTS: Pos[] = [3, 6, 8, 11, 14].map((y) => ({ x: 15, y }));

function makeFighter(spec: UnitSpec, pos: Pos): Fighter {
  // atk/range юнита — производные максимумы по оружию: мера угрозы для
  // threatAt и селекторов; урон конкретной атаки считает её оружие
  const weapons = spec.weapons;
  if (!weapons?.length && spec.atk === undefined) {
    throw new Error(`У юнита ${spec.id} нет ни weapons, ни atk/range`);
  }
  return {
    id: spec.id,
    name: spec.name,
    side: spec.side,
    maxHp: spec.maxHp,
    hp: Math.min(spec.hp ?? spec.maxHp, spec.maxHp),
    weapons,
    atk: weapons?.length ? Math.max(...weapons.map((w) => w.dmg)) : spec.atk!,
    range: weapons?.length ? Math.max(...weapons.map((w) => w.range)) : spec.range!,
    speed: spec.speed,
    move: spec.move,
    pos: { ...pos },
    startPos: { ...pos },
    alive: true,
    coverLevel: 0,
    exposed: false,
    tags: spec.tags ?? [],
    lenses: spec.lenses,
    aoe: spec.aoe ?? weapons?.find((w) => w.aoe)?.aoe,
    active: spec.active,
    passives: spec.passives,
    compiled: applyLens(spec.lenses, spec.rules),
  };
}

/** Точки спавна по спекам: явный spawn как есть, остальным — слоты от сида. */
function assignSpawns(specs: readonly UnitSpec[], rng: Rng): Pos[] {
  const slots = shuffle(FOE_SPAWN_SLOTS, rng);
  let slotIdx = 0;
  return specs.map((s) => s.spawn ?? slots[slotIdx++ % slots.length]!);
}

function placeUnits(specs: readonly UnitSpec[], rng: Rng): Fighter[] {
  const spawns = assignSpawns(specs, rng);
  return specs.map((s, i) => makeFighter(s, spawns[i]!));
}

/**
 * Позиции спавна без боя — превью расстановки на экране узла: тот же сид и
 * тот же порядок спеков, что у runBattle, дают ту же раскладку.
 */
export function spawnPreview(seed: number, specs: readonly UnitSpec[]): { id: string; pos: Pos }[] {
  const rng = mulberry32(seed);
  return assignSpawns(specs, rng).map((pos, i) => ({ id: specs[i]!.id, pos: { ...pos } }));
}

function rollDamage(base: number, rng: Rng): number {
  return Math.max(1, Math.round(expectedDamage(base) * (0.85 + 0.3 * rng())));
}

/** Ближайшая к want свободная небитая клетка: фиксированный обход колец, без rng. */
function freeSpawnNear(want: Pos, units: readonly Fighter[], blocked: (p: Pos) => boolean): Pos {
  const free = (p: Pos): boolean =>
    inBounds(p) && !blocked(p) && !units.some((u) => u.alive && posEq(u.pos, p));
  for (let ring = 0; ring < 18; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const p = { x: want.x + dx, y: want.y + dy };
        if (free(p)) return p;
      }
    }
  }
  return { ...want }; // поле целиком занято — невозможно на 18×18
}

/** Детерминированный бой: тот же seed + те же принципы = тот же лог событий. */
export function runBattle(
  seed: number,
  specs: readonly UnitSpec[],
  arena: ArenaTag = 'late',
  setup: BattleSetup = {},
): BattleResult {
  const rng = mulberry32(seed);
  const units = placeUnits(specs, rng);
  const objective: Objective = setup.objective ?? { kind: 'eliminate' };
  const waves = setup.waves ?? [];
  // цель kill-задачи помечается тегом quarry: слабый фоновый инстинкт в
  // скоринге тянет к ней без слов (рамка плана objectives)
  const quarryId =
    objective.kind === 'killTarget' || objective.kind === 'killBefore' ? objective.targetId : undefined;
  const tagQuarry = (u: Fighter): void => {
    if (u.id === quarryId && !u.tags.includes('quarry')) u.tags.push('quarry');
  };
  for (const u of units) tagQuarry(u);

  // конец боя: смерть цели kill-задачи решает мгновенно; сторона без живых
  // тел не проиграла, пока её волны ещё в пути
  const checkEnd = (round: number): Side | undefined => {
    if (!units.some((u) => u.alive && u.side === 'party')) return 'foe';
    if (quarryId) {
      const quarry = units.find((u) => u.id === quarryId);
      if (quarry && !quarry.alive) return 'party';
    }
    const wavesPending = waves.some((w) => w.round > round);
    if (units.some((u) => u.alive && u.side === 'foe') || wavesPending) return undefined;
    return 'party';
  };
  // рабочая копия схемы; камни, совпавшие с чьей-то точкой спавна, убираем
  // (кастомные спавны тестов/сценариев)
  const layout = pickTerrain(seed, arena);
  const tiles = layout.tiles.map((row) => row.map((t) => ({ ...t })));
  for (const u of units) {
    const t = tiles[u.pos.y]?.[u.pos.x];
    if (t?.blocked) t.blocked = false;
  }
  const terrain = { name: layout.name, scenario: layout.scenario, tiles };
  const blocked = (p: Pos): boolean => tiles[p.y]?.[p.x]?.blocked === true;
  const heightAt = (p: Pos): number => tiles[p.y]?.[p.x]?.height ?? 0;
  // вид на землю для условий рельефа («я на высоте», «меня прижали»)
  const ground = { heightAt, blocked };
  const events: BattleEvent[] = [];
  for (const u of units) {
    events.push({ t: 'spawn', unit: u.id, name: u.name, side: u.side, pos: { ...u.pos }, maxHp: u.maxHp });
  }
  let rounds = 0;

  // общий урон площадного каста: фиксированный, по всем жертвам (friendly
  // fire), с событием aoeHit и смертями; порядок жертв — порядок в units
  const applyAoe = (caster: Fighter, mult: number, victims: readonly Fighter[]): void => {
    for (const v of victims) {
      const dmg = aoeDamage(caster, mult, v, units);
      v.hp = Math.max(0, v.hp - dmg);
      v.lastAttackerId = caster.id;
      events.push({ t: 'aoeHit', unit: v.id, by: caster.id, dmg, hp: v.hp });
      if (v.hp === 0) {
        v.alive = false;
        events.push({ t: 'die', unit: v.id });
      }
    }
  };

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    rounds = round;
    events.push({ t: 'round', n: round });
    // волны подкреплений: выходят в начале раунда и действуют в нём же;
    // занятая или каменная клетка — ближайшая свободная по кольцам
    for (const wave of waves) {
      if (wave.round !== round) continue;
      for (const [i, spec] of wave.specs.entries()) {
        const want = spec.spawn ?? FOE_SPAWN_SLOTS[i % FOE_SPAWN_SLOTS.length]!;
        const f = makeFighter(spec, freeSpawnNear(want, units, blocked));
        tagQuarry(f);
        units.push(f);
        events.push({ t: 'spawn', unit: f.id, name: f.name, side: f.side, pos: { ...f.pos }, maxHp: f.maxHp });
      }
    }
    // дедлайн kill-задачи: цель дожила до раунда round — дочитала своё
    if (objective.kind === 'killBefore' && round >= objective.round) {
      const quarry = units.find((u) => u.id === objective.targetId);
      if (quarry?.alive) {
        events.push({ t: 'end', winner: 'foe', rounds: round });
        return { winner: 'foe', rounds: round, events, units, terrain };
      }
    }
    const order = units
      .filter((u) => u.alive)
      .sort((a, b) => b.speed - a.speed || (a.id < b.id ? -1 : 1));

    for (const unit of order) {
      if (!unit.alive) continue;

      // висящая зона ритуала бьёт в начале хода кастера — ДО сброса прикрытий:
      // «не могу выйти — прикрываюсь» работает, прикрытия жертв ещё активны.
      // Смерть кастера отменяет зону сама собой: мёртвый хода не получает
      if (unit.pendingRitual) {
        const { at } = unit.pendingRitual;
        // «полымя»: зона с пульсами бьёт по разу в начале каждого хода
        // кастера, пока пульсы не выйдут; holds в событии — зона ещё висит
        const pulsesLeft = (unit.pendingRitual.pulsesLeft ?? 1) - 1;
        unit.pendingRitual = pulsesLeft > 0 ? { at, pulsesLeft } : undefined;
        events.push({
          t: 'aoeCast', unit: unit.id, form: 'ritual', at: { ...at },
          ...(pulsesLeft > 0 ? { holds: true as const } : {}),
        });
        applyAoe(unit, unit.aoe?.ritual?.mult ?? 1, aoeVictims(at, units, AOE_RITUAL_RADIUS));
        const w = checkEnd(round);
        if (w) {
          events.push({ t: 'end', winner: w, rounds: round });
          return { winner: w, rounds: round, events, units, terrain };
        }
        if (!unit.alive) continue; // накрыл сам себя
      }

      // регенерация: зарастает в начале своего хода, не выше максимума
      const regen = unit.passives?.regen;
      if (regen && unit.hp < unit.maxHp) {
        const amount = Math.min(regen.amount, unit.maxHp - unit.hp);
        unit.hp += amount;
        events.push({ t: 'regen', unit: unit.id, amount, hp: unit.hp });
      }

      // эмоциональный дрейф (план линз): триггер проверяется в начале хода,
      // режим защёлкивается до конца боя — обратной дороги нет, условие
      // может перестать быть истинным (вылеченный трус остаётся в панике)
      const drift = unit.compiled.drift;
      if (drift && evalCondition(drift.trigger, unit, units, round, ground)) {
        unit.compiled = { rules: drift.rules, instincts: drift.instincts };
        events.push({ t: 'moodShift', unit: unit.id, lens: drift.lens });
      }

      // прикрытие (своё и выданное), открытость и перехват держатся до
      // своего следующего хода
      unit.coverLevel = 0;
      unit.guardedBy = undefined;
      unit.exposed = false;
      unit.interceptUsed = false;

      // поля дистанций считаем раз на ход: за ход этого юнита никто, кроме
      // него, не двигается, поэтому кэш ctx остаётся верным для всех действий
      const ctx = makeCtx(blocked, tiles);
      let ap = AP_PER_TURN;
      let over = false;

      while (ap > 0 && !over && unit.alive) {
        const decision = decide(unit, units, round, blocked, ap, ctx);
        // стойки манер (план words): держатся до следующего решения юнита —
        // приманка сохраняет прикрытие и на чужих ходах
        unit.stance = decision.stance;
        const { to, action, targetId, at } = decision.chosen;
        events.push({
          t: 'decision',
          unit: unit.id,
          round,
          to,
          action,
          ...(targetId ? { target: targetId } : {}),
          ...(at ? { at: { ...at } } : {}),
          ap,
          factors: decision.factors,
          condRules: decision.condRules,
          firedCount: decision.firedCount,
        });
        ap -= apCostFor(action, unit);

        if (isMovement(action)) {
          events.push({ t: 'move', unit: unit.id, from: { ...unit.pos }, to: { ...to } });
          unit.pos = { ...to };
          // опасная клетка бьёт закончившего на ней шаг; осторожный шаг не
          // будит опасность, проход насквозь безопасен. Без rng — фиксированный
          const hz = action === 'move' ? tiles[to.y]?.[to.x]?.hazard : undefined;
          if (hz) {
            unit.hp = Math.max(0, unit.hp - HAZARD_DMG);
            events.push({ t: 'hazard', unit: unit.id, kind: hz, dmg: HAZARD_DMG, hp: unit.hp });
            if (unit.hp === 0) {
              unit.alive = false;
              events.push({ t: 'die', unit: unit.id });
            }
          }
        } else if (isAttack(action) && targetId) {
          if (action === 'selflessAttack') unit.exposed = true;
          const aimed = units.find((u) => u.id === targetId)!;
          // урон, дальность и «стрелковость» — по оружию кандидата
          const weapon: WeaponSpec = weaponsOf(unit)[decision.chosen.weapon ?? 0]!;
          if (
            aimed.alive &&
            dist(unit.pos, aimed.pos) <= rangeAt(unit, heightAt(unit.pos), weapon.range)
          ) {
            // перехват (план защиты): смежный телохранитель со сработавшим
            // правилом «защищать(цель)» принимает удар на себя — раз в раунд.
            // Линза уже решает за него: у труса protect превращается в behind,
            // и перехватывать становится нечем
            const guardian = units
              .filter(
                (g) =>
                  g.alive &&
                  g !== aimed &&
                  g.side === aimed.side &&
                  !g.interceptUsed &&
                  dist(g.pos, aimed.pos) === 1 &&
                  g.compiled.rules.some(
                    (rl) =>
                      rl.then.kind === 'protect' &&
                      resolveAlly(rl.then.ally, g, units)?.id === aimed.id &&
                      evalCondition(rl.when, g, units, round, ground),
                  ),
              )
              .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
            const target = guardian ?? aimed;
            if (guardian) {
              guardian.interceptUsed = true;
              events.push({ t: 'intercept', unit: guardian.id, target: aimed.id });
            }
            const allyPositions = units
              .filter((u) => u.alive && u.side === unit.side && u !== unit)
              .map((u) => u.pos);
            // строй ломает фланги: смежный с целью союзник прикрывает ей спину
            const targetAllyPositions = units
              .filter((u) => u.alive && u.side === target.side && u !== target)
              .map((u) => u.pos);
            const flank =
              weapon.range === 1 && isFlanking(unit.pos, target.pos, allyPositions, targetAllyPositions);
            // фланговый множитель: у плута «в спину» — свой, острее общего
            const flankMult = flank ? unit.passives?.sneak?.flankMult ?? 1.5 : 1;
            const raw = rollDamage(
              weapon.dmg *
                rageDmgMult(unit) *
                blessMult(unit) *
                shadowMult(unit, unit.pos, units, blocked) *
                retributionMult(unit, target, units) *
                stanceAttackMult(action, weapon, unit.stance) *
                flankMult,
              rng,
            );
            // каменное укрытие цели не складывается с прикрытием — берётся максимум;
            // стойка «наверняка» режет митигацию полного удара вдвое
            const mitigation = stanceMitigation(
              Math.max(effectiveCover(target, units), ctx.coverFrom(unit.pos, target.pos)),
              action,
              unit.stance,
            );
            const dmg = Math.max(
              1,
              Math.round(
                raw *
                  (1 - mitigation) *
                  (target.exposed ? SELFLESS_VULN_MULT : 1) *
                  rageVulnMult(target),
              ) + heightDmgBonus(unit, heightAt(unit.pos), weapon.range),
            );
            target.hp = Math.max(0, target.hp - dmg);
            target.lastAttackerId = unit.id;
            events.push({
              t: 'attack',
              unit: unit.id,
              action,
              target: target.id,
              dmg,
              flank,
              targetHp: target.hp,
            });
            if (target.hp === 0) {
              target.alive = false;
              events.push({ t: 'die', unit: target.id });
            } else if (
              (unit.passives?.markOnHit || unit.stance?.mark) &&
              !target.tags.includes('marked')
            ) {
              // охотник — пассивкой, носитель слова «метить цель» — стойкой
              // (третья волна teamwork): метит добычу самим ударом; одна метка
              // на стороне цели, прежняя снимается — стая идёт за метящим
              for (const u of units) {
                if (u.side === target.side) u.tags = u.tags.filter((t) => t !== 'marked');
              }
              target.tags.push('marked');
              events.push({ t: 'mark', unit: unit.id, target: target.id });
            }
            // рипост (план защиты): ближний удар по живому в глухой обороне
            // ранит бьющего — фиксированно, без rng (прецедент шипов).
            // Стойка «наверняка» (план words) рипоста не ловит: удар расчётлив
            if (
              weapon.range === 1 &&
              target.alive &&
              target.coverLevel >= FULL_COVER &&
              !(unit.stance?.hard && action === 'attack')
            ) {
              unit.hp = Math.max(0, unit.hp - RIPOSTE_DMG);
              unit.lastAttackerId = target.id;
              events.push({ t: 'riposte', unit: unit.id, by: target.id, dmg: RIPOSTE_DMG, hp: unit.hp });
              if (unit.hp === 0) {
                unit.alive = false;
                events.push({ t: 'die', unit: unit.id });
              }
            }
          }
        } else if (action === 'shove' && targetId) {
          const target = units.find((u) => u.id === targetId)!;
          const dest = shoveDest(unit.pos, target.pos);
          if (
            target.alive &&
            dist(unit.pos, target.pos) === 1 &&
            inBounds(dest) &&
            !blocked(dest) &&
            !units.some((u) => u.alive && posEq(u.pos, dest))
          ) {
            events.push({ t: 'shove', unit: unit.id, target: target.id, from: { ...target.pos }, to: { ...dest } });
            target.pos = { ...dest };
            // опасность на клетке назначения срабатывает немедленно — иначе весь смысл
            const hz = tiles[dest.y]?.[dest.x]?.hazard;
            if (hz) {
              target.hp = Math.max(0, target.hp - HAZARD_DMG);
              target.lastAttackerId = unit.id; // мститель запомнит толкнувшего
              events.push({ t: 'hazard', unit: target.id, kind: hz, dmg: HAZARD_DMG, hp: target.hp });
              if (target.hp === 0) {
                target.alive = false;
                events.push({ t: 'die', unit: target.id });
              }
            }
          }
        } else if (action === 'aoeRitual' && at) {
          // замах: зона объявлена, урон — в начале следующего хода кастера.
          // Перезарядка и лимит списываются на замахе, а не на залпе
          const ritual = unit.aoe?.ritual;
          if (
            ritual &&
            ritualReady(unit, round) &&
            dist(unit.pos, at) <= ritual.range &&
            hasLoS(unit.pos, at, blocked)
          ) {
            unit.pendingRitual = {
              at: { ...at },
              ...(ritual.pulses && ritual.pulses > 1 ? { pulsesLeft: ritual.pulses } : {}),
            };
            unit.lastRitualRound = round;
            unit.ritualUses = (unit.ritualUses ?? 0) + 1;
            // dmg — номинал по чистой цели, для телеграфии в логе и разведке
            const nominal = Math.max(1, Math.round(expectedDamage(unit.atk) * ritual.mult));
            events.push({ t: 'telegraph', unit: unit.id, at: { ...at }, dmg: nominal });
          }
        } else if (action === 'aoeBlast' && at) {
          // залп: фиксированный урон всем в 3×3 вокруг центра — обеим сторонам
          // (friendly fire включён) и самому кастеру, если влез в зону
          const blast = unit.aoe?.blast;
          if (blast && blastReady(unit) && dist(unit.pos, at) <= blast.range && hasLoS(unit.pos, at, blocked)) {
            unit.blastUses = (unit.blastUses ?? 0) + 1;
            events.push({ t: 'aoeCast', unit: unit.id, form: 'blast', at: { ...at } });
            applyAoe(unit, blast.mult, aoeVictims(at, units));
          }
        } else if (action === 'aoeLine' && at) {
          // волна клинка: мгновенная полоса от себя, `at` — клетка-направление
          const line = unit.aoe?.line;
          if (line && dist(unit.pos, at) === 1) {
            events.push({ t: 'aoeCast', unit: unit.id, form: 'line', at: { ...at } });
            applyAoe(unit, line.mult, castVictims('aoeLine', at, unit, units, blocked));
          }
        } else if (action === 'rage') {
          // вход в ярость: статус до конца боя, второго входа нет по устройству
          if (rageReady(unit)) {
            unit.raged = true;
            events.push({ t: 'rage', unit: unit.id });
          }
        } else if (action === 'wall') {
          // стена: прикрытие себе и всем смежным союзникам; снимается у
          // каждого в начале ЕГО хода — та же жизнь, что у щита одному
          if (wallReady(unit)) {
            unit.wallUses = (unit.wallUses ?? 0) + 1;
            unit.coverLevel = Math.max(unit.coverLevel, COVER);
            events.push({ t: 'cover', unit: unit.id, level: unit.coverLevel });
            for (const a of units) {
              if (a.alive && a !== unit && a.side === unit.side && dist(a.pos, unit.pos) <= 1) {
                if (COVER > (a.guardedBy?.level ?? 0)) a.guardedBy = { id: unit.id, level: COVER };
                events.push({ t: 'cover', unit: unit.id, level: a.guardedBy!.level, ally: a.id });
              }
            }
          }
        } else if (action === 'heal' && targetId) {
          // первый «hp вверх» в симе: фиксированное значение, без rng
          const heal = unit.active?.heal;
          const ally = units.find((u) => u.id === targetId)!;
          if (heal && healReady(unit) && ally.alive && dist(unit.pos, ally.pos) <= heal.range) {
            unit.healUses = (unit.healUses ?? 0) + 1;
            const amount = Math.min(heal.amount, ally.maxHp - ally.hp);
            ally.hp += amount;
            events.push({ t: 'heal', unit: unit.id, target: ally.id, amount, hp: ally.hp });
          }
        } else if (action === 'bless' && targetId) {
          const bless = unit.active?.bless;
          const ally = units.find((u) => u.id === targetId)!;
          if (bless && blessReady(unit) && ally.alive && dist(unit.pos, ally.pos) <= bless.range) {
            unit.blessUses = (unit.blessUses ?? 0) + 1;
            ally.blessedMult = bless.dmgMult;
            events.push({ t: 'bless', unit: unit.id, target: ally.id, mult: bless.dmgMult });
          }
        } else if (action === 'feint' && targetId) {
          const target = units.find((u) => u.id === targetId)!;
          if (unit.active?.feint && target.alive && dist(unit.pos, target.pos) === 1) {
            target.exposed = true;
            events.push({ t: 'feint', unit: unit.id, target: target.id });
          }
        } else if (action === 'shieldAlly' && targetId) {
          const ally = units.find((u) => u.id === targetId)!;
          // щит кроет только смежного; прикрытие живёт, пока щитоносец рядом
          if (ally.alive && dist(unit.pos, ally.pos) === 1) {
            // щитоносец («стена щита») кроет союзника сильнее общего уровня
            const level = unit.passives?.shieldwall?.cover ?? coverLevelOf(action);
            if (level > (ally.guardedBy?.level ?? 0)) ally.guardedBy = { id: unit.id, level };
            events.push({ t: 'cover', unit: unit.id, level: ally.guardedBy!.level, ally: ally.id });
          }
        } else if (action === 'swap' && targetId) {
          // обмен местами: договорённость, а не толчок — ход подопечного не
          // тратится. Условия перепроверяются на месте (как у толчка): между
          // решением и исполнением подопечный мог погибнуть или отойти
          const ally = units.find((u) => u.id === targetId)!;
          if (ally.alive && ally.side === unit.side && dist(unit.pos, ally.pos) === 1) {
            const mine = { ...unit.pos };
            const theirs = { ...ally.pos };
            unit.pos = theirs;
            ally.pos = mine;
            events.push({ t: 'swap', unit: unit.id, target: ally.id, from: mine, to: theirs });
            // опасная клетка бьёт каждого, кто на ней закончил, — общее
            // правило поля: вытаскивать своего из огня в огонь бессмысленно
            for (const u of [unit, ally]) {
              const hz = tiles[u.pos.y]?.[u.pos.x]?.hazard;
              if (!hz) continue;
              u.hp = Math.max(0, u.hp - HAZARD_DMG);
              events.push({ t: 'hazard', unit: u.id, kind: hz, dmg: HAZARD_DMG, hp: u.hp });
              if (u.hp === 0) {
                u.alive = false;
                events.push({ t: 'die', unit: u.id });
              }
            }
          }
        } else if (coverLevelOf(action) > 0) {
          unit.coverLevel = Math.max(unit.coverLevel, coverLevelOf(action));
          events.push({ t: 'cover', unit: unit.id, level: unit.coverLevel });
        } else {
          events.push({ t: 'wait', unit: unit.id });
          over = true; // пас завершает ход: тратить остаток очков не на что
        }

        const w = checkEnd(round);
        if (w) {
          events.push({ t: 'end', winner: w, rounds: round });
          return { winner: w, rounds: round, events, units, terrain };
        }
      }
    }

    // задача «выстоять»: партия дожила до конца раунда rounds — победа
    if (objective.kind === 'survive' && round >= objective.rounds) {
      events.push({ t: 'end', winner: 'party', rounds: round });
      return { winner: 'party', rounds: round, events, units, terrain };
    }
  }

  events.push({ t: 'end', winner: 'draw', rounds });
  return { winner: 'draw', rounds, events, units, terrain };
}

