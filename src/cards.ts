import { ALLY_ROLE_RU, type AllyRef, type Condition, type LensMark, type Preference, type Rule } from './ir.js';
import { applyLens } from './lens.js';
import { DAMAGE_TYPE_RU } from './types.js';
import type { ActiveSpec, AoeSpec, DamageType, Defenses, LensId, PassiveSpec, ShieldSpec, WeaponMove, WeaponSpec } from './types.js';

/**
 * Карточка «Как понял Гром»: шаблонный обратный перевод IR ПОСЛЕ линз.
 * Контракт с игроком: все искажения характера видны ДО боя.
 */

export interface UnderstandingCard {
  heroName: string;
  lenses: LensId[];
  lines: string[];
}

const SEL_RU: Record<string, string> = {
  nearest: 'ближайшего',
  weakest: 'самого слабого',
  leader: 'вожака',
  mostDangerous: 'самого опасного',
  attacker: 'того, кто меня атаковал',
  marked: 'помеченного',
  shooter: 'стрелка',
  farthest: 'самого дальнего',
  strongest: 'самого здорового',
  fastest: 'самого быстрого',
  healer: 'вражеского лекаря',
  caster: 'вражеского заклинателя',
  straggler: 'отбившегося от своих',
  tormentor: 'обидчика наших',
  heckler: 'вражеского крикуна',
  unengaged: 'свободного врага',
  intruder: 'прорывающегося к рубежу',
  ward: 'подопечного задачи',
  vulnerable: 'того, кого моё оружие берёт лучше всех',
  armored: 'самого бронированного',
};

/** Ссылка на своего в нужном падеже: имя героя не склоняем, роль — по таблице. */
const allyRu = (
  ref: AllyRef,
  nm: (id: string) => string,
  form: 'nom' | 'gen' | 'ins' = 'gen',
): string => (typeof ref === 'string' ? nm(ref) : ALLY_ROLE_RU[ref.role][form]);

function condRu(c: Condition, nm: (id: string) => string): string {
  switch (c.kind) {
    case 'always':
      return '';
    case 'hpBelow':
      return c.who === 'self'
        ? `если моё hp ниже ${Math.round(c.frac * 100)}% — `
        : `если hp ${allyRu(c.who.ally, nm)} ниже ${Math.round(c.frac * 100)}% — `;
    case 'hpAbove':
      return c.who === 'self'
        ? `пока моё hp не ниже ${Math.round(c.frac * 100)}% — `
        : `пока hp ${allyRu(c.who.ally, nm)} не ниже ${Math.round(c.frac * 100)}% — `;
    case 'outnumbered':
      return 'если врагов больше, чем нас — ';
    case 'allyInDanger':
      return `если ${allyRu(c.ally, nm, 'nom')} в опасности — `;
    case 'battleDrags':
      return 'если бой затянулся — ';
    case 'initiativeEdge':
      return 'если мы быстрее — ';
    case 'allyFallen':
      return 'если кто-то из наших пал — ';
    case 'surrounded':
      return 'если меня окружили — ';
    case 'underCharge':
      return 'если враги накатывают — ';
    case 'firstBlood':
      return 'если пролилась первая кровь — ';
    case 'leaderDown':
      return 'если вожак врага пал — ';
    case 'wasHit':
      return 'если меня уже били — ';
    case 'enemyAdjacent':
      return 'если враг вплотную — ';
    case 'allyAdjacent':
      return 'пока рядом стоит кто-то из наших — ';
    case 'alone':
      return 'если я в отрыве от своих — ';
    case 'weOutnumber':
      return 'если нас больше — ';
    case 'enemyShooters':
      return 'пока у врага живы стрелки — ';
    case 'enemyCasters':
      return 'пока у врага жив заклинатель — ';
    case 'enemyWavering':
      return 'если враг дрогнул — ';
    case 'lastEnemy':
      return 'если враг остался один — ';
    case 'allyHurt':
      return 'если кто-то из наших ранен — ';
    case 'enemiesClustered':
      return 'если враги скучились — ';
    case 'allyTaunting':
      return 'если кто-то из наших вызвал врагов на себя — ';
    case 'allyEngaged':
      return 'если кто-то из наших схватился с врагом — ';
    case 'guarded':
      return 'если меня прикрывают — ';
    case 'allySurrounded':
      return 'если кого-то из наших обступили — ';
    case 'alliesFocusing':
      return 'если наши уже навалились на кого-то — ';
    case 'spreadThin':
      return 'если мы растянулись — ';
    case 'lull':
      return 'пока затишье и до меня не дотягиваются — ';
    case 'weaponFails':
      return 'если моё оружие не берёт того, кто ближе всех, — ';
    case 'smoldering':
      return 'пока на мне тлеет рана — огонь, яд или кровь — ';
    case 'onHighGround':
      return 'пока я стою на высоте — ';
    case 'cornered':
      return 'если меня прижали и деваться некуда — ';
    case 'inFormation':
      return 'пока мы стоим строем, плечом к плечу — ';
    case 'inZone':
      return 'пока я стою на рубеже задачи — ';
    case 'enemyInZone':
      return 'если враг ворвался на рубеж — ';
    case 'timeShort':
      return 'если время задачи на исходе — ';
    case 'prizeHeld':
      return 'пока трофей на руках у наших — ';
    case 'and':
      // вложенность читается сцепкой «если … — если … — »
      return c.conds.map((s) => condRu(s, nm)).join('');
    case 'or':
      // «если … — или если … — »: части уже кончаются на « — »
      return c.conds.map((s) => condRu(s, nm)).join('или ');
  }
}

function prefRu(p: Preference, nm: (id: string) => string): string {
  switch (p.kind) {
    case 'attack':
      return `атакую ${SEL_RU[p.target]}`;
    case 'protect':
      return `прикрываю ${allyRu(p.ally, nm)}`;
    case 'holdPosition':
      return 'держу позицию';
    case 'retreat':
      return 'отхожу';
    case 'nearTo':
      return `держусь рядом с ${p.ref.type === 'ally' ? allyRu(p.ref.id, nm, 'ins') : SEL_RU[p.ref.sel]}`;
    case 'behind':
      return `встаю позади ${p.ref.type === 'ally' ? allyRu(p.ref.id, nm) : SEL_RU[p.ref.sel]}`;
    case 'bait':
      return 'изображаю приманку: маячу перед врагами, не подставляясь под удар';
    case 'trade':
      return 'иду на размен: бью, когда удар того стоит, даже под ответ';
    case 'coverRetreat':
      return 'прикрываю отход: встаю между врагами и самым раненым из наших';
    case 'standoff':
      return 'держу дистанцию: бью с края своей дальности, ближе не подпускаю';
    case 'flank':
      return 'захожу во фланг и бью с двух сторон';
    case 'avoidLineOfFire':
      return 'держусь вне линии огня вражеских стрелков';
    case 'chokepoint':
      return 'встаю в узком месте: держу проход между камнями';
    case 'brace':
      return 'встаю в глухую оборону, когда до меня могут достать';
    case 'awayFrom':
      return `держусь подальше от ${p.ref.type === 'ally' ? allyRu(p.ref.id, nm) : SEL_RU[p.ref.sel]}`;
    case 'strikeOften':
      return 'бью часто и вполсилы: лучше три замаха, чем один';
    case 'strikeHard':
      return 'бью в полную силу, на мелкие замахи не размениваюсь';
    case 'strikeDesperate':
      return 'бью отчаянно: сильнее обычного, но открываюсь под ответ';
    case 'highGround':
      return 'держу высоту: забираюсь на холм — с него дальше видно и больнее бить';
    case 'behindCover':
      return 'держусь за укрытием: прячусь за камнем от вражеских стрелков';
    case 'avoidHazard':
      return 'обхожу опасное: на шипы и в огонь не встаю, а встав — ухожу';
    case 'roughEdge':
      return 'стерегу кромку: жду у труднопроходной земли, не ступая на неё, — пусть враг вязнет на подходе';
    case 'outflank':
      return 'обхожу из-за спин: захожу врагу сбоку, не выходя вперёд своих';
    case 'shove':
      return 'толкаю: сбиваю врага с места — в шипы, в огонь, из строя';
    case 'barrage':
      return 'накрываю скопление: бью по площади, где врагов двое и больше — своих зацепит тоже';
    case 'spread':
      return 'держу интервал: не встаю вплотную к своим, пока у врага есть чем накрыть';
    case 'preempt':
      return 'бью на упреждение: замахиваюсь туда, куда враг придёт, а не где стоит';
    case 'castRitual':
      return 'замахиваюсь ритуалом: трачу ход на большую зону, на мгновенный залп не размениваюсь';
    case 'wait':
      return 'выжидаю: сам не иду навстречу, берегу ход — пока бой не докатился до меня';
    case 'rage':
      return 'впадаю в ярость: бью сильнее, но и получаю больнее — до конца боя, назад пути нет';
    case 'heal':
      return 'лечу: трачу ход на исцеление того из наших, кому хуже всех';
    case 'bless':
      return 'благословляю: усиливаю удары самого ударного из наших до конца боя';
    case 'feint':
      return 'финчу: обманным выпадом открываю врага под удары своих';
    case 'douse':
      return 'сбиваю пламя: трачу движение, чтобы сбить огонь или зажать рану — себе или тому из наших, кто рядом';
    case 'finish':
      return 'добиваю: если удар может снять цель с поля — бью его, остальное подождёт';
    case 'focusFire':
      return 'бью туда же: наваливаюсь на того, кого уже бьют наши';
    case 'taunt':
      return 'вызываю на себя: маячу у врагов на виду и злю их — пусть идут ко мне, а не к нашим';
    case 'lure':
      return `увожу врагов от ${allyRu(p.ally, nm)}: держусь у них на виду, но тяну их в сторону`;
    case 'screen':
      return `заслоняю ${allyRu(p.ally, nm)} от стрелков: встаю телом на линию выстрела`;
    case 'regroup':
      return 'смыкаю строй: держусь плечом к плечу со своими';
    case 'swap':
      return `меняюсь местами с ${allyRu(p.ally, nm, 'ins')}: вытаскиваю из-под удара, встаю сам`;
    case 'mark':
      return 'мечу цель ударами: на ком мой удар — на том метка для всех наших';
    case 'fallback':
      return 'отхожу за спины: отступаю к своим, за живой заслон, а не куда глаза глядят';
    case 'clearLine':
      return 'своим не защу: не встаю на линию выстрела наших стрелков — пусть бьют мимо меня';
    case 'pin':
      return 'связываю боем: держу контакт с врагом, которого больше никто из наших не держит';
    case 'holdLine':
      return 'держу рубеж: встаю в зону задачи и не отдаю её';
    case 'evacuate':
      return 'ухожу к выходу: пробиваюсь в зону задачи — бой не главное';
    case 'carry':
      return 'несу трофей: поднимаю ношу и тащу её к выходу';
  }
}

/**
 * Человеческое описание площадного оружия носителя АОЕ — одна строка для
 * разведки врагов и карточки героя (игрок должен видеть носителя до того,
 * как возьмёт слово «накрыть скопление»).
 */
export function describeAoe(aoe: AoeSpec): string {
  const w: string[] = [];
  // тление зоны (план damage-types, волна 6): разведка обязана предупредить,
  // что залп не просто бьёт, а оставляет гореть
  const smolder = (form: { dmgType?: DamageType; persist?: { dmg: number; type?: DamageType } }): string =>
    form.persist
      ? `, ${persistRu(form.persist.type ?? form.dmgType ?? 'fire')} −${form.persist.dmg}/ход`
      : '';
  if (aoe.blast) {
    const limit = aoe.blast.usesPerBattle ? `, ${aoe.blast.usesPerBattle} на бой` : '';
    w.push(`заряд 3×3 (дальность ${aoe.blast.range}${limit}${smolder(aoe.blast)})`);
  }
  if (aoe.line) w.push(`волна 1×${aoe.line.len}${aoe.line.persist ? ` (${smolder(aoe.line).slice(2)})` : ''}`);
  if (aoe.ritual) {
    const limit = aoe.ritual.cooldown
      ? `, раз в ${aoe.ritual.cooldown} раунда`
      : aoe.ritual.usesPerBattle
        ? `, ${aoe.ritual.usesPerBattle} на бой`
        : '';
    const pulses = aoe.ritual.pulses && aoe.ritual.pulses > 1 ? `, жжёт ${aoe.ritual.pulses} хода` : '';
    w.push(`ритуал 5×5 (замах виден за ход${pulses}${limit}${smolder(aoe.ritual)})`);
  }
  return w.join(' · ');
}

/**
 * Строка одного оружия (план классов) — для разведки врага и карточки героя:
 * имя, урон, дальность, площадные формы. Игрок видит оружие до того, как
 * возьмёт слова под него («накрыть скопление» берут, зная носителя).
 */
/** Строка приёма кита: имя, урон (dmg × mult), дальность и райдеры в скобках. */
function describeMove(w: WeaponSpec, m: WeaponMove): string {
  const marks: string[] = [];
  const r = m.range ?? w.range;
  // тип урона приёма пишем, только если он спорит с оружейным: «щитом в
  // грудь — дробящий» у рубящего меча читается, а три «рубящих» подряд — нет
  if (m.dmgType && m.dmgType !== w.dmgType) marks.push(DAMAGE_TYPE_RU[m.dmgType]);
  if (r > 1) marks.push(`даль ${r}`);
  if (m.pierce !== undefined) marks.push('пробивает укрытия');
  else if (m.sure) marks.push('без рипоста');
  if (m.expose) marks.push('открывает');
  if (m.push) marks.push('толкает');
  if (m.gang !== undefined) marks.push('толпой больнее');
  if (m.stepBack) marks.push('с отходом');
  if (m.twin) marks.push('по двум');
  // тление приёма (волна 6): игрок обязан видеть, что удар оставляет в цели
  const rider = m.persist ?? w.persist;
  if (rider) marks.push(`${persistRu(rider.type ?? m.dmgType ?? w.dmgType ?? 'fire')} −${rider.dmg}/ход`);
  if (m.ap !== undefined) marks.push('весь ход');
  return `${m.name} ${Math.round(w.dmg * m.mult)}${marks.length > 0 ? ` (${marks.join(', ')})` : ''}`;
}

export function describeWeapon(w: WeaponSpec): string {
  const aoe = w.aoe ? ` · ${describeAoe(w.aoe)}` : '';
  // тип урона оружия (план damage-types) — рядом с именем: по нему игрок
  // выбирает, чем бить эту броню
  const type = w.dmgType ? `, ${DAMAGE_TYPE_RU[w.dmgType]}` : '';
  // кит приёмов (план weapon-moves): игрок видит виды атак оружия с числами
  if (w.moves && w.moves.length > 0) {
    return `${w.name}${type} (${w.moves.map((m) => describeMove(w, m)).join('; ')})${aoe}`;
  }
  const range = w.range > 1 ? `, даль ${w.range}` : '';
  const rider = w.persist
    ? `, ${persistRu(w.persist.type ?? w.dmgType ?? 'fire')} −${w.persist.dmg}/ход`
    : '';
  return `${w.name} (удар ${w.dmg}${range}${type}${rider})${aoe}`;
}

/**
 * Строка защит (план damage-types) — для разведки врага и карточки героя.
 * Слово об уязвимости бессмысленно, если игрок не может её узнать: сюда идут
 * и КБ со спасбросками, и слабости с сопротивлениями.
 */
/**
 * Как назвать тлеющий урон в логе (план damage-types, волна 6): огонь, яд,
 * кислота — своими именами, физика — кровью. Слово подобрано так, чтобы
 * годилось в любом падеже боевого лога: «кровь сходит на нет», «унял огонь».
 */
export function persistRu(t: DamageType): string {
  if (t === 'fire') return 'огонь';
  if (t === 'poison') return 'яд';
  if (t === 'acid') return 'кислота';
  if (t === 'bludgeoning' || t === 'piercing' || t === 'slashing') return 'кровь';
  return DAMAGE_TYPE_RU[t];
}

export function describeDefenses(d: Defenses): string {
  const parts: string[] = [];
  if (d.ac !== undefined) parts.push(`КБ ${d.ac}`);
  const saves = [
    d.fort !== undefined ? `стойкость ${d.fort}` : '',
    d.ref !== undefined ? `реакция ${d.ref}` : '',
    d.will !== undefined ? `воля ${d.will}` : '',
  ].filter(Boolean);
  if (saves.length > 0) parts.push(saves.join('/'));
  const names = (types: readonly DamageType[]): string => types.map((t) => DAMAGE_TYPE_RU[t]).join(', ');
  if (d.weak && Object.keys(d.weak).length > 0) {
    parts.push(
      `слабости: ${Object.entries(d.weak).map(([t, n]) => `${DAMAGE_TYPE_RU[t as DamageType]} +${n}`).join(', ')}`,
    );
  }
  if (d.resist && Object.keys(d.resist).length > 0) {
    parts.push(
      `сопротивления: ${Object.entries(d.resist).map(([t, n]) => `${DAMAGE_TYPE_RU[t as DamageType]} −${n}`).join(', ')}`,
    );
  }
  if (d.immune && d.immune.length > 0) parts.push(`иммунитет: ${names(d.immune)}`);
  return parts.join(' · ');
}

/**
 * Строка щита (план armor) — читается с карточки героя и из разведки: игрок
 * должен видеть и бонус, и то, сколько щит выдержит, прежде чем развалиться.
 */
export function describeShield(sh: ShieldSpec): string {
  return `щит +${sh.ac} к КБ · гасит ${sh.hardness} (раз в раунд) · запас ${sh.hp}`;
}

/** Строка оружейного набора: у мастера несколько — через «;». */
export function describeWeapons(weapons: readonly WeaponSpec[]): string {
  return weapons.map(describeWeapon).join('; ');
}

/**
 * Строка классового актива — цифры размена игрок видит до того, как возьмёт
 * слово-гейт (тот же контракт, что у оружия носителя АОЕ).
 */
export function describeActive(active: ActiveSpec): string {
  const parts: string[] = [];
  if (active.rage) {
    parts.push(`ярость (урон ×${active.rage.dmgMult}, входящий ×${active.rage.vulnMult}, до конца боя)`);
  }
  if (active.wall) {
    parts.push(`стена (прикрытие себе и смежным, ${active.wall.usesPerBattle} на бой)`);
  }
  if (active.heal) {
    parts.push(`исцеление (+${active.heal.amount} hp, дальность ${active.heal.range}, ${active.heal.usesPerBattle} на бой)`);
  }
  if (active.bless) {
    parts.push(`благословение (урон союзника ×${active.bless.dmgMult}, до конца боя, ${active.bless.usesPerBattle} на бой)`);
  }
  if (active.feint) {
    parts.push('финт (открывает врага под удары своих)');
  }
  return parts.join(' · ');
}

/** Строка классовых пассивов — читается с карточки героя и разведки. */
export function describePassives(p: PassiveSpec): string {
  const parts: string[] = [];
  if (p.shieldwall) parts.push(`щит союзнику +${p.shieldwall.ac} к КБ`);
  if (p.markOnHit) parts.push('метит цель ударом');
  if (p.steadfast) parts.push('глухая оборона за 2 очка');
  if (p.shadow) parts.push(`из тени урон ×${p.shadow.mult}`);
  if (p.sneak) parts.push(`фланг: −${p.sneak.offGuard} к КБ цели`);
  if (p.retribution) parts.push(`кара обидчикам своих ×${p.retribution.mult}`);
  // регенерацию гасят огонь и кислота (pf2e): без этой строки контр-тактика
  // против тролля остаётся тайной
  if (p.regen) parts.push(`зарастает +${p.regen.amount} в ход (огонь и кислота не дают)`);
  return parts.join(' · ');
}

/** Помечена ли строка искажением линзы (по пометкам marks) — для debug-карточки. */
function lensMark(rule: Rule): string {
  if (rule.marks?.some((m) => m.kind !== 'instinct')) return ' ⚠ понял по-своему';
  if (rule.marks?.some((m) => m.kind === 'instinct')) return ' ⚠ инстинкт';
  if (rule.source.startsWith('способность')) return ' · способность';
  return '';
}

/**
 * Реплика персонажа от первого лица — раскрытие искажения в журнале боя
 * (план линз). Имя линзы не называет: игрок выводит характер сам, полные
 * подписи — в debug. Реплика строится по последней пометке правила; rule —
 * само сработавшее правило: по его условию различаются контекстные прочтения
 * (расщепления одной фразы на честное и ситуационное правила).
 */
export function lensQuip(m: LensMark, names: Record<string, string> = {}, rule?: Rule): string {
  const nm = (id: string): string => names[id] ?? id;
  const from = m.kind === 'reword' ? m.from.kind : undefined;
  switch (m.lens) {
    case 'plain':
      return 'Понял как написано.';
    case 'coward':
      if (m.kind === 'instinct') return 'Всё, с меня хватит — я отсюда.';
      if (m.kind === 'recondition') return 'Прикрываю, прикрываю. Пока сам цел, конечно.';
      if (m.kind === 'reweight')
        return m.mult < 1 ? 'Нападать? Иду… но без охоты.' : 'Дистанция — это святое.';
      if (m.kind === 'reword' && m.from.kind === 'protect')
        return rule?.when.kind === 'hpBelow'
          ? `Прикрывать ${allyRu(m.from.ally, nm)}? Прикрывал, пока цел был. Теперь — из-за спины.`
          : `Прикрывать ${allyRu(m.from.ally, nm)}? Постою за спиной — оттуда тоже всё видно.`;
      if (from === 'bait') return 'Приманкой пусть смелые работают. Я просто отойду.';
      if (from === 'strikeDesperate') return 'Отчаянно не могу. В полную силу — куда ни шло.';
      if (from === 'rage') return 'В ярость? Уж лучше в глухую оборону.';
      break;
    case 'fanatic':
      if (m.kind === 'recondition') return 'Ярость не ждёт повода.';
      if (from === 'retreat') return 'Отступать? Отступлю, когда все лягут.';
      if (from === 'coverRetreat') return 'Отход не прикрывают — добивают!';
      if (from === 'avoidLineOfFire') return 'Под огонь — так под огонь. Вперёд!';
      if (from === 'standoff') return 'Моя дистанция — длина клинка.';
      if (from === 'brace') return 'Щиты — для трусов.';
      if (from === 'strikeOften' || from === 'strikeHard') return 'Бить — так со всей ярости!';
      break;
    case 'literalist':
      return 'Правила на это нет. Стою и защищаюсь.';
    case 'avenger':
      return 'Кто меня ударил — тот умрёт.';
    case 'duelist':
      if (from === 'attack')
        return rule?.when.kind === 'outnumbered'
          ? 'Нас меньше. Ладно — война есть война.'
          : 'Слабых не добиваю. Вызываю сильнейшего.';
      if (from === 'flank') return 'В спину не бью — только лицом к лицу.';
      if (from === 'finish') return 'Добивать? Бесчестье. Вызываю сильнейшего.';
      break;
    case 'gloryhound':
      return 'Достойная цель — только вожак.';
    case 'guardian':
      if (m.kind === 'instinct') return 'Самый раненый из наших — за мной.';
      if (m.kind === 'reword' && m.from.kind === 'protect')
        return `${allyRu(m.from.ally, nm, 'nom')} ранен(а)? Всё. Остальное подождёт.`;
      return 'Своих не бросаю.';
    case 'paranoid':
      return 'Стрелки. Везде стрелки. Я — в сторонку.';
    case 'hothead':
      if (from === 'strikeHard')
        return rule?.when.kind === 'battleDrags'
          ? 'Сколько можно возиться! Бью как бьётся.'
          : 'Пока ты примеряешься — я уже трижды ударил.';
      if (from === 'holdPosition') return 'Стоять на месте? Невыносимо.';
      if (from === 'bait') return 'Приманивать? Просто нападу.';
      if (from === 'brace') return 'Отсиживаться за щитом? Невыносимо.';
      break;
    case 'showman':
      return m.kind === 'instinct' ? 'Пусть весь их строй смотрит на меня.' : 'Эффектный заход — это по мне.';
  }
  return 'Понял по-своему.';
}

/** Реплика эмоционального сдвига (событие moodShift) — момент, когда характер защёлкнулся. */
export function driftQuip(lens: LensId): string {
  switch (lens) {
    case 'avenger':
      return 'Они убили нашего. Дальше я слушаю только ярость.';
    case 'coward':
      return 'Хватит с меня. Я хочу жить.';
    case 'hothead':
      return 'Кровь! Наконец-то. Понеслась!';
    case 'gloryhound':
      return 'Вожак пал… Ради чего теперь стараться.';
    default:
      return 'Что-то во мне переменилось.';
  }
}

/**
 * Механический перевод одного правила ПОСЛЕ линз — фактическое поведение.
 * Для интела врагов: source искажённого правила больше не описывает то, что
 * юнит будет делать, — переводим само правило.
 */
export function ruleRu(r: Rule, names: Record<string, string> = {}): string {
  const nm = (id: string): string => names[id] ?? id;
  return `${condRu(r.when, nm)}${prefRu(r.then, nm)}`;
}

/**
 * Строит карточку понимания: сырые правила героя → линзы → текст.
 * Та же applyLens, что и в бою — карточка не может разойтись с поведением.
 * uncertainty — заметки LLM-компилятора («не знает слова X»), тоже видны до боя.
 *
 * Карточка-эхо (план линз): до боя виден только ФАКТ искажения — понятые
 * дословно строки печатаются переводом, искажённые — формулировкой игрока с
 * пометкой «понял по-своему», инстинкт-правила линз скрыты вовсе. Содержание
 * искажений раскрывается в журнале боя. debug возвращает полную карточку.
 */
export function understandingCard(
  hero: { name: string; lenses: LensId[] },
  rawRules: Rule[],
  names: Record<string, string> = {},
  uncertainty: readonly string[] = [],
  debug = false,
): UnderstandingCard {
  const nm = (id: string): string => names[id] ?? id;
  const compiled = applyLens(hero.lenses, rawRules);
  const lines: string[] = [];
  if (debug) {
    for (const r of compiled.rules) lines.push(`${ruleRu(r, names)}${lensMark(r)}`);
    for (const u of uncertainty) lines.push(`⚠ ${u}`);
    if (hero.lenses.includes('literalist')) {
      lines.push('нет правила на ситуацию — стою и защищаюсь ⚠ буквалист');
    }
    return { heroName: hero.name, lenses: hero.lenses, lines };
  }
  // расщепление даёт из одной фразы пару правил (честное + ситуационное) —
  // фраза с хотя бы одним искажённым правилом печатается «понял по-своему» один раз
  const twistedSources = new Set(
    compiled.rules
      .filter((r) => r.marks?.length && !r.marks.some((m) => m.kind === 'instinct'))
      .map((r) => r.source),
  );
  const echoed = new Set<string>();
  for (const r of compiled.rules) {
    if (r.marks?.some((m) => m.kind === 'instinct')) continue; // характер, не приказ
    if (twistedSources.has(r.source)) {
      if (!echoed.has(r.source)) {
        echoed.add(r.source);
        lines.push(`${r.source} ⚠ понял по-своему`);
      }
      continue;
    }
    lines.push(`${ruleRu(r, names)}${r.source.startsWith('способность') ? ' · способность' : ''}`);
  }
  for (const u of uncertainty) lines.push(`⚠ не понял вообще: ${u}`);
  return { heroName: hero.name, lenses: hero.lenses, lines };
}
