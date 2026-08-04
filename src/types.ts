export type Side = 'party' | 'foe';

export interface Pos {
  x: number;
  y: number;
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
  defending: boolean;
  tags: string[];
  /** Линзы характера в порядке применения (1–3 у героев). */
  lenses: LensId[];
  /** Кто последним нанёс мне урон — для селектора «кто атаковал меня». */
  lastAttackerId?: string;
}
