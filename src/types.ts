export type Side = 'party' | 'foe';

export interface Pos {
  x: number;
  y: number;
}

/** Что юнит может сделать за очко хода. Цены — `AP_COST`/`apCostFor` в scoring.ts. */
export type ActionKind =
  | 'move'
  | 'carefulStep'
  | 'weakAttack'
  | 'attack'
  | 'selflessAttack'
  | 'shove'
  | 'aoeBlast'
  | 'aoeRitual'
  | 'cover'
  | 'fullCover'
  | 'shieldAlly'
  | 'wait';

/**
 * Площадное оружие юнита (план АОЕ) — «умеет накрывать». АОЕ не действие для
 * всех: без спеки кандидатов каста нет; использование гейтится правилом
 * «накрыть скопление» (у врагов — в спеке, у героев — словом).
 */
export interface AoeSpec {
  /** Залп: мгновенный взрыв 3×3 вокруг центра в дальности range; урон mult × ожидаемый удар, фиксированный. */
  blast?: { range: number; mult: number };
  /**
   * Ритуал: телеграфированная зона 5×5 — замах весь ход (3 AP), бьёт всех,
   * кто в зоне в начале **следующего** хода кастера; смерть кастера отменяет.
   * cooldown — раундов между замахами; usesPerBattle — жёсткий лимит на бой.
   */
  ritual?: { range: number; mult: number; cooldown?: number; usesPerBattle?: number };
}

export type LensId =
  | 'plain'
  | 'coward'
  | 'fanatic'
  | 'literalist'
  | 'avenger'
  | 'duelist'
  | 'gloryhound'
  | 'guardian'
  | 'paranoid'
  | 'hothead'
  | 'showman';

/** Юнит в бою — общий вид для IR-условий, скоринга и сима. */
export interface CombatUnit {
  id: string;
  name: string;
  side: Side;
  maxHp: number;
  hp: number;
  atk: number;
  /** 1 = ближний бой; >1 требует линии видимости. */
  range: number;
  speed: number;
  move: number;
  pos: Pos;
  startPos: Pos;
  alive: boolean;
  /** Доля снятого входящего урона (0, COVER, FULL_COVER); держится до своего следующего хода. */
  coverLevel: number;
  /** Отчаянный удар открыл: входящий урон ×SELFLESS_VULN_MULT до своего следующего хода. */
  exposed: boolean;
  tags: string[];
  /** Линзы характера в порядке применения (1–3 у героев). */
  lenses: LensId[];
  /** Площадное оружие носителя АОЕ; у большинства юнитов отсутствует. */
  aoe?: AoeSpec;
  /** Висящая зона ритуала: центр 5×5; бьёт в начале следующего хода кастера. */
  pendingRitual?: { at: Pos };
  /** Раунд последнего замаха ритуала — перезарядка. */
  lastRitualRound?: number;
  /** Потраченных применений ритуала в этом бою — лимит usesPerBattle. */
  ritualUses?: number;
  /** Кто последним нанёс мне урон — для селектора «кто атаковал меня». */
  lastAttackerId?: string;
}
