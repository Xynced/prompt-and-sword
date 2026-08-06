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
  | 'aoeLine'
  | 'aoeRitual'
  | 'rage'
  | 'wall'
  | 'heal'
  | 'bless'
  | 'feint'
  | 'cover'
  | 'fullCover'
  | 'shieldAlly'
  | 'wait';

/**
 * Классовые активы (план классов) — по образцу AoeSpec: без спеки кандидатов
 * действия нет, использование гейтится словом (прецедент «накрыть скопление»).
 */
export interface ActiveSpec {
  /**
   * Ярость: 1 AP, раз в бой, до конца боя — свой урон ×dmgMult,
   * входящий ×vulnMult. Длящийся статус: раз войдя, назад не выйти.
   */
  rage?: { dmgMult: number; vulnMult: number };
  /**
   * Стена (щитоносец): 2 AP — прикрытие COVER себе и всем смежным союзникам
   * до их следующего хода. Гейт — правила «защищать»/«прикрывать отход»:
   * своего слова не нужно.
   */
  wall?: { usesPerBattle: number };
  /**
   * Исцеление (целитель): 2 AP — союзнику в дальности +amount hp (не выше
   * максимума). Первый «hp вверх» в симе; гейт — правило «лечить».
   */
  heal?: { amount: number; range: number; usesPerBattle: number };
  /**
   * Благословение (боевой жрец): 2 AP — атаки союзника ×dmgMult до конца
   * боя. Тот же канал длящихся статусов, что у ярости.
   */
  bless?: { dmgMult: number; range: number; usesPerBattle: number };
  /**
   * Финт (трюкачка): 1 AP — смежный враг «открыт» (входящий ×SELFLESS_VULN_MULT)
   * до своего следующего хода. Сетап для своих: «финт → все бьют».
   */
  feint?: Record<string, never>;
}

/**
 * Классовые пассивы (план классов) — всегда включены, слов и действий не
 * требуют; каждый — одно точечное отклонение от общих правил боя.
 */
export interface PassiveSpec {
  /** Щитоносец (Гром): его прикрытие союзника держит cover вместо общего COVER. */
  shieldwall?: { cover: number };
  /** Охотник (Дарт): его цель становится «помеченной» для всей партии (тег marked). */
  markOnHit?: true;
  /** Бастион (Скала): глухая защита за 2 AP вместо 3. */
  steadfast?: true;
  /** Тень (Мара): атаки ×mult, пока сама вне прицела вражеских стрелков. */
  shadow?: { mult: number };
  /** В спину (Тесса): фланговый множитель урона вместо общего 1.5. */
  sneak?: { flankMult: number };
  /** Кара (Заря): атаки ×mult по врагу, чей удар последним получил кто-то из своих. */
  retribution?: { mult: number };
  /** Регенерация (тролль): +amount hp в начале своего хода, не выше максимума. */
  regen?: { amount: number };
}

/**
 * Оружие (план классов): носитель урона и дальности — они переезжают с юнита
 * на оружие. У героя 1–3 оружия (мастер выбирает по ситуации), у врага одно.
 * Аффинность манер — МЯГКАЯ: родная манера получает премию, чужая штраф, но
 * слово игрока (STRIKE_STYLE_BONUS > WEAPON_AFFINITY_BONUS) её перебивает —
 * щитника можно заставить биться отчаянно.
 */
export interface WeaponSpec {
  /** Имя — идёт в разведку и карточку («меч и щит», «костяной лук»). */
  name: string;
  /** Урон оружия — заменяет atk юнита. */
  dmg: number;
  /** Дальность оружия — заменяет range юнита; 1 = ближний бой. */
  range: number;
  /** Родные (1) и чуждые (−1) манеры удара; отсутствие — нейтрально. */
  affinity?: Partial<Record<'weakAttack' | 'attack' | 'selflessAttack', 1 | -1>>;
  /** Множитель слабого удара этого оружия вместо общего WEAK_ATK_MULT (кулаки Юны). */
  weakMult?: number;
  /** Площадные формы оружия (план АОЕ) — жезл Лии, копьё ци Жала, посох шамана. */
  aoe?: AoeSpec;
}

/**
 * Площадное оружие юнита (план АОЕ) — «умеет накрывать». АОЕ не действие для
 * всех: без спеки кандидатов каста нет; использование гейтится правилом
 * «накрыть скопление» (у врагов — в спеке, у героев — словом).
 */
export interface AoeSpec {
  /** Залп: мгновенный взрыв 3×3 вокруг центра в дальности range; урон mult × ожидаемый удар, фиксированный. */
  blast?: { range: number; mult: number; usesPerBattle?: number };
  /** Линия («волна клинка»): мгновенная полоса 1×len от себя в одном из 8 направлений; камень обрывает взмах. */
  line?: { len: number; mult: number };
  /**
   * Ритуал: телеграфированная зона 5×5 — замах весь ход (3 AP), бьёт всех,
   * кто в зоне в начале **следующего** хода кастера; смерть кастера отменяет.
   * cooldown — раундов между замахами; usesPerBattle — жёсткий лимит на бой.
   * pulses — залпов подряд (по одному на ход кастера): зона держится и жжёт,
   * пока пульсы не выйдут, — «полымя»-контроль Весты; по умолчанию 1.
   */
  ritual?: { range: number; mult: number; cooldown?: number; usesPerBattle?: number; pulses?: number };
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
  /**
   * Оружие юнита (план классов). Отсутствует у «голых» юнитов тестов —
   * тогда неявное оружие собирается из atk/range (`weaponsOf` в scoring).
   */
  weapons?: WeaponSpec[];
  /** Производный от оружия максимум урона — для оценки угрозы и селекторов. */
  atk: number;
  /** Производный максимум дальности; 1 = ближний бой; >1 требует линии видимости. */
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
  /** Классовые активы юнита; у большинства отсутствуют. */
  active?: ActiveSpec;
  /** Классовые пассивы юнита; у большинства отсутствуют. */
  passives?: PassiveSpec;
  /** В ярости: свой урон и входящий умножены по спеке — до конца боя. */
  raged?: boolean;
  /** Потраченных «стен» в этом бою — лимит usesPerBattle. */
  wallUses?: number;
  /** Потраченных исцелений в этом бою — лимит usesPerBattle. */
  healUses?: number;
  /** Потраченных благословений в этом бою — лимит usesPerBattle. */
  blessUses?: number;
  /** Благословлён: атаки ×множитель до конца боя (число — от спеки кастера). */
  blessedMult?: number;
  tags: string[];
  /** Линзы характера в порядке применения (1–3 у героев). */
  lenses: LensId[];
  /** Площадное оружие носителя АОЕ; у большинства юнитов отсутствует. */
  aoe?: AoeSpec;
  /** Висящая зона ритуала: центр 5×5; бьёт в начале следующего хода кастера; pulsesLeft — оставшиеся залпы «полымя». */
  pendingRitual?: { at: Pos; pulsesLeft?: number };
  /** Раунд последнего замаха ритуала — перезарядка. */
  lastRitualRound?: number;
  /** Потраченных применений ритуала в этом бою — лимит usesPerBattle. */
  ritualUses?: number;
  /** Потраченных залпов в этом бою — лимит usesPerBattle заряда. */
  blastUses?: number;
  /** Кто последним нанёс мне урон — для селектора «кто атаковал меня». */
  lastAttackerId?: string;
}
