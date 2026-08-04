export type Side = 'party' | 'foe';

export interface Pos {
  x: number;
  y: number;
}

export type CharacterId = 'plain' | 'coward' | 'fanatic' | 'literalist';

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
  character: CharacterId;
  /** Кто последним нанёс мне урон — для селектора «кто атаковал меня». */
  lastAttackerId?: string;
}
