import { describe, expect, it } from 'vitest';
import { type BattleEvent, type UnitSpec, runBattle } from '../src/battle.js';
import { bonesetter, duelist, foeIntel, ogre, pyro, raider, rat, sergeant, shaman, slinger, soldier, thug, troll, wolf } from '../src/foes.js';
import { PARTY_SPAWNS, heroArchetype } from '../src/heroes.js';
import type { Rule } from '../src/ir.js';
import { posEq } from '../src/grid.js';

/**
 * Паттерны боёв плана врагов: каждый состав — задача на переформулировку.
 * Смоуки парные: формулировка-до против контр-формулировки на общих сидах.
 */

const r = (rule: Omit<Rule, 'scope'>): Rule => ({ ...rule, scope: 'self' });
const atkNearest = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'nearest' }, weight: 2, source: 'бей ближайшего' });
const barrage = r({ when: { kind: 'always' }, then: { kind: 'barrage' }, weight: 2, source: 'накрой скопление' });
const focusWeak = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 2, source: 'добивай раненых' });

/** Герой из пула (оружие/активы/пассивы/способность) с заданными приказами. */
function hero(archId: string, slot: number, rules: Rule[]): UnitSpec {
  const a = heroArchetype(archId);
  return {
    id: a.id,
    name: a.name,
    side: 'party',
    lenses: ['plain'],
    rules: [...rules, ...a.innate],
    maxHp: a.stats.maxHp,
    speed: a.stats.speed,
    move: a.stats.move,
    weapons: a.weapons,
    active: a.active,
    passives: a.passives,
    spawn: { ...PARTY_SPAWNS[slot]! },
  };
}

const partyWith = (extra: Rule[]): UnitSpec[] => [
  hero('grom', 0, [atkNearest]),
  hero('lia', 1, [atkNearest, ...extra]),
  hero('zhalo', 2, [atkNearest, ...extra]),
];

interface SweepStats {
  wins: number;
  hpFrac: number;
  foeBites: number;
}

function sweep(party: () => UnitSpec[], foes: () => UnitSpec[], arena: 'early' | 'late', seeds = 20): SweepStats {
  let wins = 0;
  let hpFrac = 0;
  let foeBites = 0;
  for (let s = 1; s <= seeds; s++) {
    const res = runBattle(s * 17 + 3, [...party(), ...foes()], arena);
    if (res.winner === 'party') wins++;
    const pu = res.units.filter((u) => u.side === 'party');
    hpFrac += pu.reduce((a, u) => a + (u.alive ? u.hp : 0), 0) / pu.reduce((a, u) => a + u.maxHp, 0);
    foeBites += res.events.filter((e): e is Extract<BattleEvent, { t: 'attack' }> => e.t === 'attack')
      .filter((e) => e.unit.startsWith('rat') || e.unit.startsWith('wolf')).length;
  }
  return { wins, hpFrac: hpFrac / seeds, foeBites: foeBites / seeds };
}

const rats = () => Array.from({ length: 9 }, (_, i) => rat(i + 1));
const wolves = () => Array.from({ length: 4 }, (_, i) => wolf(i + 1));

describe('масса: крысиная стая', () => {
  it('спеки: дешёвое тело, фанатик (страху нет), уникальные точки спавна кучей', () => {
    const pack = rats();
    expect(pack).toHaveLength(9);
    for (const p of pack) {
      expect(p.maxHp).toBe(10);
      expect(p.weapons![0]!.name).toBe('зубы');
      expect(p.lenses).toEqual(['fanatic']);
    }
    for (const [i, a] of pack.entries()) {
      for (const b of pack.slice(i + 1)) expect(posEq(a.spawn!, b.spawn!)).toBe(false);
    }
  });

  it('масса доходит и кусает: без линзы фанатика стая черепашилась под обстрелом', () => {
    const st = sweep(() => partyWith([]), rats, 'early');
    expect(st.foeBites).toBeGreaterThan(12);
  });

  it('смоук: наив истощается, «накрыть скопление» переворачивает', () => {
    const naive = sweep(() => partyWith([]), rats, 'early');
    const aoe = sweep(() => partyWith([barrage]), rats, 'early');
    // наив выживает (не стена), но платит около половины hp партии
    expect(naive.wins).toBeGreaterThanOrEqual(12);
    expect(naive.hpFrac).toBeLessThan(0.55);
    // контр: побед не меньше, hp на выходе ощутимо выше
    expect(aoe.wins).toBeGreaterThanOrEqual(naive.wins);
    expect(aoe.hpFrac).toBeGreaterThan(naive.hpFrac + 0.1);
  });
});

describe('стая: волчья охота', () => {
  it('спеки: фланговый укус вдвое больнее (sneak), «сбить с ног» в правилах', () => {
    for (const w of wolves()) {
      expect(w.passives?.sneak?.flankMult).toBe(2.0);
      expect(w.rules.some((rl) => rl.then.kind === 'shove')).toBe(true);
      expect(w.rules.some((rl) => rl.then.kind === 'attack' && rl.then.target === 'weakest')).toBe(true);
    }
  });

  it('волки охотятся на хрупких: укусы доходят до мага за спинами', () => {
    let liaBites = 0;
    for (let s = 1; s <= 20; s++) {
      const res = runBattle(s * 17 + 3, [...partyWith([]), ...wolves()], 'late');
      liaBites += res.events.filter((e) => e.t === 'attack' && e.target === 'lia').length;
    }
    expect(liaBites).toBeGreaterThan(20);
  });

  it('смоук: стая стоит дорого, фокус-огонь окупается', () => {
    const naive = sweep(() => partyWith([]), wolves, 'late');
    const focus = sweep(
      () => [hero('grom', 0, [focusWeak]), hero('lia', 1, [focusWeak]), hero('zhalo', 2, [focusWeak])],
      wolves,
      'late',
    );
    expect(naive.hpFrac).toBeLessThan(0.55); // стая кусает всерьёз
    expect(focus.wins).toBeGreaterThanOrEqual(naive.wins); // фокус не хуже, стая тает быстрее
  });

  it('разведка новых врагов читается: правила, оружие, пассив', () => {
    const intel = foeIntel([rat(1), wolf(1)]);
    expect(intel[0]!.lines).toContain('крыса: вцепиться в ближайшего');
    expect(intel[0]!.lines.some((l) => l.startsWith('оружие: зубы'))).toBe(true);
    expect(intel[1]!.lines.some((l) => l.includes('фланг ×2'))).toBe(true);
  });
});

describe('умная элита: латники и сержант', () => {
  const elite = () => [soldier(1, 'soldier2'), soldier(2, 'soldier1'), sergeant()];
  const atkWeakest = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 2, source: 'добивай раненых' });
  const atkLeader = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'leader' }, weight: 2, source: 'вали вожака' });
  const mkParty = (rules: Rule[]) => () => [hero('grom', 0, rules), hero('lia', 1, rules), hero('zhalo', 2, rules)];

  it('спеки: латник о двух оружиях держит строй, сержант — вожак с кличем', () => {
    const s1 = soldier(1, 'soldier2');
    expect(s1.weapons!.map((w) => w.name)).toEqual(['меч и щит', 'метательное копьё']);
    expect(s1.rules.some((rl) => rl.then.kind === 'nearTo')).toBe(true);
    const sgt = sergeant();
    expect(sgt.tags).toContain('leader');
    expect(sgt.active?.bless?.usesPerBattle).toBe(1);
    expect(sgt.rules.some((rl) => rl.when.kind === 'allyFallen' && rl.then.kind === 'bless')).toBe(true);
  });

  it('разведка выдаёт головоломку: условие клича видно до боя', () => {
    const intel = foeIntel(elite());
    const sgtLines = intel.find((i) => i.name === 'Сержант')!.lines;
    expect(sgtLines).toContain('сержант: клич мести, когда падает латник');
    expect(sgtLines.some((l) => l.startsWith('актив:'))).toBe(true);
  });

  it('смоук: жадное добивание будит клич мести, фокус вожака глушит его навсегда', () => {
    let cries = 0;
    let criesLeader = 0;
    let hpWeakest = 0;
    let hpLeader = 0;
    for (let s = 1; s <= 20; s++) {
      const w = runBattle(s * 17 + 3, [...mkParty([atkWeakest])(), ...elite()], 'elite');
      const l = runBattle(s * 17 + 3, [...mkParty([atkLeader])(), ...elite()], 'elite');
      cries += w.events.filter((e) => e.t === 'bless').length;
      criesLeader += l.events.filter((e) => e.t === 'bless').length;
      const frac = (res: typeof w): number => {
        const pu = res.units.filter((u) => u.side === 'party');
        return pu.reduce((a, u) => a + (u.alive ? u.hp : 0), 0) / pu.reduce((a, u) => a + u.maxHp, 0);
      };
      hpWeakest += frac(w);
      hpLeader += frac(l);
    }
    expect(cries).toBeGreaterThanOrEqual(15); // добивание латников почти всегда будит клич
    expect(criesLeader).toBe(0); // мёртвый сержант не кличет
    expect(hpLeader).toBeGreaterThan(hpWeakest); // и порядок целей окупается
  });
});

describe('ближники + лекарь: налётчики и костоправ', () => {
  const gang = () => [raider(1), raider(2), bonesetter('raider1')];
  const atkWeakest = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'weakest' }, weight: 2, source: 'добивай раненых' });

  it('спеки: налётчик-свитч-хиттер (лук и топор), костоправ с исцелением за спинами', () => {
    const rd = raider(1);
    expect(rd.weapons!.map((w) => w.name)).toEqual(['костяной лук', 'щербатый топор']);
    const bs = bonesetter('raider1');
    expect(bs.active?.heal).toEqual({ amount: 12, range: 4, usesPerBattle: 4 });
    expect(bs.rules.some((rl) => rl.then.kind === 'heal')).toBe(true);
    expect(bs.rules.some((rl) => rl.then.kind === 'behind')).toBe(true);
  });

  it('лекарь работает: заряды льются в бою, бой с ним длиннее', () => {
    let heals = 0;
    let rounds = 0;
    let roundsNoHealer = 0;
    for (let s = 1; s <= 20; s++) {
      const seed = s * 17 + 3;
      const withHealer = runBattle(seed, [...partyWith([]), ...gang()], 'late');
      const without = runBattle(seed, [...partyWith([]), raider(1), raider(2)], 'late');
      heals += withHealer.events.filter((e) => e.t === 'heal' && e.unit === 'bonesetter').length;
      rounds += withHealer.rounds;
      roundsNoHealer += without.rounds;
    }
    expect(heals).toBeGreaterThan(40); // ~2+ лечения за бой
    expect(rounds).toBeGreaterThan(roundsNoHealer); // лекарь — налог на время
  });

  it('смоук: перелечка глушит мету добивания — «руби ближайшего» дешевле', () => {
    const chop = sweep(() => partyWith([]), gang, 'late');
    const pick = sweep(
      () => [hero('grom', 0, [atkWeakest]), hero('lia', 1, [atkWeakest]), hero('zhalo', 2, [atkWeakest])],
      gang,
      'late',
    );
    expect(chop.hpFrac).toBeGreaterThan(pick.hpFrac); // добивание вязнет в перелечке
  });
});

describe('танк + кастеры: огр и поджигатель', () => {
  const crew = () => [ogre(), pyro(1), shaman('ogre')];
  const spread = r({ when: { kind: 'always' }, then: { kind: 'spread' }, weight: 1.5, source: 'держи интервал' });

  it('спеки: огр-пробка (проход, туша, вышвырнуть), поджигатель-стекло за его спиной', () => {
    const og = ogre();
    expect(og.maxHp).toBe(100);
    expect(og.rules.some((rl) => rl.then.kind === 'chokepoint')).toBe(true);
    expect(og.rules.some((rl) => rl.then.kind === 'shove')).toBe(true);
    const py = pyro(1);
    expect(py.weapons![0]!.aoe?.blast).toBeDefined();
    expect(py.rules.some((rl) => rl.then.kind === 'barrage')).toBe(true);
    expect(py.rules.some((rl) => rl.then.kind === 'behind')).toBe(true);
  });

  it('смоук: залпы жгут кучную партию, «держать интервал» бережёт и глушит касты', () => {
    let hpNaive = 0;
    let hpSpread = 0;
    let castsNaive = 0;
    let castsSpread = 0;
    for (let s = 1; s <= 20; s++) {
      const seed = s * 17 + 3;
      const n = runBattle(seed, [...partyWith([]), ...crew()], 'elite');
      const sp = runBattle(seed, [...partyWith([spread]), ...crew()], 'elite');
      const frac = (res: typeof n): number => {
        const pu = res.units.filter((u) => u.side === 'party');
        return pu.reduce((a, u) => a + (u.alive ? u.hp : 0), 0) / pu.reduce((a, u) => a + u.maxHp, 0);
      };
      hpNaive += frac(n);
      hpSpread += frac(sp);
      castsNaive += n.events.filter((e) => e.t === 'aoeCast').length;
      castsSpread += sp.events.filter((e) => e.t === 'aoeCast').length;
    }
    expect(hpNaive / 20).toBeLessThan(0.45); // артиллерия за пробкой — дорогой бой
    expect(hpSpread).toBeGreaterThan(hpNaive); // интервал бережёт
    expect(castsSpread).toBeLessThan(castsNaive); // и обесценивает залпы
  });
});

describe('засада: душегуб с волками', () => {
  const ambush = () => [thug(), wolf(1), wolf(2)];
  const protectLia = r({ when: { kind: 'always' }, then: { kind: 'protect', ally: 'lia' }, weight: 1.5, source: 'прикрывай Лию' });

  it('спеки: быстрый охотник на тыл с фланговым пассивом', () => {
    const t = thug();
    expect(t.move).toBe(3);
    expect(t.passives?.sneak?.flankMult).toBe(1.75);
    expect(t.rules.some((rl) => rl.then.kind === 'attack' && rl.then.target === 'weakest')).toBe(true);
  });

  it('смоук: фокус тает засаду, нянька-телохранитель — ловушка темпа', () => {
    const naive = sweep(() => partyWith([]), ambush, 'late');
    const focus = sweep(
      () => [hero('grom', 0, [focusWeak]), hero('lia', 1, [focusWeak]), hero('zhalo', 2, [focusWeak])],
      ambush,
      'late',
    );
    const nanny = sweep(
      () => [hero('grom', 0, [atkNearest, protectLia]), hero('lia', 1, [atkNearest]), hero('zhalo', 2, [atkNearest])],
      ambush,
      'late',
    );
    expect(focus.hpFrac).toBeGreaterThanOrEqual(naive.hpFrac); // фокус не хуже
    expect(nanny.hpFrac).toBeLessThan(naive.hpFrac - 0.15); // нянчиться дороже, чем бить
  });
});

describe('таймер: тролль', () => {
  const timer = () => [troll(), slinger(1), slinger(2)];

  it('спеки: единственный носитель regen, фанатик с когтями', () => {
    const t = troll();
    expect(t.passives?.regen).toEqual({ amount: 8 });
    expect(t.lenses).toEqual(['fanatic']);
    expect(t.rules.some((rl) => rl.then.kind === 'trade')).toBe(true);
  });

  it('тролль зарастает в бою по-настоящему', () => {
    let regenHp = 0;
    for (let s = 1; s <= 20; s++) {
      const res = runBattle(s * 17 + 3, [...partyWith([]), ...timer()], 'elite');
      regenHp += res.events
        .filter((e): e is Extract<BattleEvent, { t: 'regen' }> => e.t === 'regen')
        .reduce((a, e) => a + e.amount, 0);
    }
    expect(regenHp).toBeGreaterThan(400); // ~20+ hp зарастания за бой
  });

  it('смоук: распыление урона по свите кормит реген — добивание не лучше фокуса строем', () => {
    const naive = sweep(() => partyWith([]), timer, 'late');
    const pick = sweep(
      () => [hero('grom', 0, [focusWeak]), hero('lia', 1, [focusWeak]), hero('zhalo', 2, [focusWeak])],
      timer,
      'late',
    );
    expect(naive.hpFrac).toBeLessThan(0.6); // тролль стоит дорого
    expect(naive.wins).toBeGreaterThanOrEqual(pick.wins); // добивание свиты не окупается
  });
});

describe('дуэль: орк-поединщик', () => {
  const duel = () => [duelist(), soldier(1, 'soldier2'), soldier(2, 'soldier1')];
  const atkDanger = r({ when: { kind: 'always' }, then: { kind: 'attack', target: 'mostDangerous' }, weight: 2, source: 'вали опасных' });

  it('спеки: клеймор и чекан с зеркальной аффинностью, линза дуэлянта', () => {
    const d = duelist();
    expect(d.weapons!.map((w) => w.name)).toEqual(['клеймор', 'чекан']);
    expect(d.weapons![0]!.affinity).toEqual({ attack: 1, weakAttack: -1 });
    expect(d.weapons![1]!.affinity).toEqual({ weakAttack: 1 });
    expect(d.lenses).toEqual(['duelist']);
    expect(d.rules.some((rl) => rl.then.kind === 'attack' && rl.then.target === 'mostDangerous')).toBe(true);
  });

  it('смоук: наив теряет керри, «принять вызов» всем строем спасает', () => {
    let gromDeadNaive = 0;
    let gromDeadAnswer = 0;
    let hpNaive = 0;
    let hpAnswer = 0;
    for (let s = 1; s <= 20; s++) {
      const seed = s * 17 + 3;
      const n = runBattle(seed, [...partyWith([]), ...duel()], 'elite');
      const a = runBattle(
        seed,
        [...[hero('grom', 0, [atkDanger]), hero('lia', 1, [atkDanger]), hero('zhalo', 2, [atkDanger])], ...duel()],
        'elite',
      );
      if (!n.units.find((u) => u.id === 'grom')!.alive) gromDeadNaive++;
      if (!a.units.find((u) => u.id === 'grom')!.alive) gromDeadAnswer++;
      const frac = (res: typeof n): number => {
        const pu = res.units.filter((u) => u.side === 'party');
        return pu.reduce((acc, u) => acc + (u.alive ? u.hp : 0), 0) / pu.reduce((acc, u) => acc + u.maxHp, 0);
      };
      hpNaive += frac(n);
      hpAnswer += frac(a);
    }
    expect(gromDeadNaive).toBeGreaterThanOrEqual(5); // дуэлянт всерьёз охотится на керри
    expect(gromDeadAnswer).toBeLessThan(gromDeadNaive); // принятый вызов спасает
    expect(hpAnswer).toBeGreaterThan(hpNaive);
  });
});

describe('застрельщики: кобольды-пращники', () => {
  const slingers = () => Array.from({ length: 4 }, (_, i) => slinger(i + 1));

  it('спеки: праща и нож (два оружия), из-за камней, без линзы труса', () => {
    const k = slinger(1);
    expect(k.weapons!.map((w) => w.name)).toEqual(['праща', 'кривой нож']);
    expect(k.lenses).toEqual(['plain']); // трус срезан: бегун наматывал круги до ничьей
    expect(k.rules.some((rl) => rl.then.kind === 'standoff')).toBe(true);
    expect(k.rules.some((rl) => rl.then.kind === 'behindCover')).toBe(true);
    expect(k.rules.some((rl) => rl.then.kind === 'attack' && rl.then.target === 'weakest')).toBe(true);
  });

  it('погонь до ничьей нет: каждый бой решается до 30-го раунда', () => {
    for (let s = 1; s <= 20; s++) {
      const res = runBattle(s * 17 + 3, [...partyWith([]), ...slingers()], 'late');
      expect(res.winner).not.toBe('draw');
    }
  });

  it('смоук: перестрелка наказывает раненую партию заметно больнее полной', () => {
    const wounded = (): UnitSpec[] =>
      partyWith([]).map((h) => ({ ...h, hp: Math.ceil(h.maxHp * 0.6) }));
    const full = sweep(() => partyWith([]), slingers, 'late');
    const hurt = sweep(wounded, slingers, 'late');
    expect(full.hpFrac).toBeGreaterThan(0.65); // полной партии перестрелка почти бесплатна
    expect(hurt.hpFrac).toBeLessThan(0.45); // раненая платит по-настоящему
    expect(hurt.wins).toBeGreaterThanOrEqual(17); // но это давление, не стена
  });
});
