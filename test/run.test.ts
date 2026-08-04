import { describe, expect, it } from 'vitest';
import {
  MAX_SLOTS,
  type RunState,
  advance,
  battleSeed,
  chooseInEvent,
  chooseInScriptorium,
  claimReward,
  currentNode,
  eventOffer,
  foesForNode,
  generateMap,
  heroSpecs,
  intelVisible,
  playFight,
  rest,
  scriptoriumOffer,
  setPhrases,
  startRun,
} from '../src/run.js';
import { CORE_WORDS, DEEP_WORDS, STARTING_VOCAB } from '../src/vocab.js';
import { runBattle } from '../src/battle.js';

/** Кайт-переформулировка (стартовый словарь), выигрывающая урок на большинстве костей. */
function lessonRewrite(state: RunState): void {
  for (const h of state.heroes) {
    if (!h.alive) continue;
    setPhrases(
      state,
      h.id,
      h.stats.range === 1
        ? [{ condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.nearest' }, weight: 2 }]
        : [
            { condition: { id: 'always' }, preference: { id: 'act.retreat' } },
            { condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.nearest' }, weight: 2 },
          ],
    );
  }
}

/** Прогоняет забег до конца: первый выход из каждого узла, простые выборы. */
function autoplay(seed: number, maxLessonTries = 3): RunState {
  const state = startRun(seed);
  let tries = 0;
  while (state.status === 'ongoing') {
    const node = currentNode(state);
    switch (node.kind) {
      case 'lesson':
      case 'fight':
      case 'elite':
      case 'boss': {
        const r = playFight(state);
        if (node.kind === 'lesson' && r.winner !== 'party') {
          if (++tries >= maxLessonTries) return state; // не зациклиться
          lessonRewrite(state);
        }
        if (state.pendingReward?.[0]) {
          claimReward(state, { kind: 'concept', id: state.pendingReward[0] });
        }
        break;
      }
      case 'scriptorium': {
        const offer = scriptoriumOffer(state);
        chooseInScriptorium(
          state,
          offer.concepts[0]
            ? { kind: 'concept', id: offer.concepts[0] }
            : offer.slotHero
              ? { kind: 'slot', heroId: offer.slotHero }
              : { kind: 'skip' },
        );
        break;
      }
      case 'event': {
        const offer = eventOffer(state);
        chooseInEvent(
          state,
          offer.mercenary
            ? { kind: 'hire' }
            : offer.concept || offer.slotHero
              ? { kind: 'take' }
              : { kind: 'skip' },
        );
        break;
      }
      case 'rest':
        rest(state);
        break;
    }
    if (state.status === 'ongoing' && state.resolved) {
      advance(state, currentNode(state).next[0]!);
    }
  }
  return state;
}

describe('карта забега', () => {
  it('12–15 узлов, старт — урок, финал — босс, все узлы достижимы', () => {
    for (const seed of [1, 2, 3, 7]) {
      const map = generateMap(seed);
      expect(map.length).toBeGreaterThanOrEqual(12);
      expect(map.length).toBeLessThanOrEqual(15);
      expect(map[0]!.kind).toBe('lesson');
      expect(map.at(-1)!.kind).toBe('boss');
      // достижимость: BFS от старта покрывает все узлы
      const seen = new Set([0]);
      const queue = [0];
      while (queue.length) {
        for (const n of map[queue.shift()!]!.next) {
          if (!seen.has(n)) {
            seen.add(n);
            queue.push(n);
          }
        }
      }
      expect(seen.size).toBe(map.length);
      // рёбра ведут только в следующий слой
      for (const node of map) {
        for (const n of node.next) expect(map[n]!.layer).toBe(node.layer + 1);
        if (node.kind !== 'boss') expect(node.next.length).toBeGreaterThan(0);
      }
    }
  });

  it('карта детерминирована сидом и содержит все типы узлов', () => {
    expect(generateMap(5)).toEqual(generateMap(5));
    const kinds = new Set(generateMap(5).map((n) => n.kind));
    for (const k of ['lesson', 'fight', 'elite', 'event', 'rest', 'scriptorium', 'boss']) {
      expect(kinds).toContain(k);
    }
  });

  it('advance: только по рёбрам и только после прохождения узла', () => {
    const state = startRun(1);
    expect(advance(state, currentNode(state).next[0] ?? 99).ok).toBe(false); // узел не пройден
    state.resolved = true;
    expect(advance(state, 99).ok).toBe(false); // нет такого ребра
    const to = currentNode(state).next[0]!;
    expect(advance(state, to).ok).toBe(true);
    expect(state.at).toBe(to);
    expect(state.resolved).toBe(false);
  });
});

describe('забег', () => {
  it('детерминирован: тот же seed — тот же результат и лог', () => {
    const a = autoplay(5);
    const b = autoplay(5);
    expect(a.status).toBe(b.status);
    expect(a.log).toEqual(b.log);
  });

  it('заканчивается победой или поражением', () => {
    let ends = 0;
    for (const seed of [1, 2, 3, 4]) {
      const s = autoplay(seed);
      if (s.status !== 'ongoing') ends++;
    }
    expect(ends).toBeGreaterThan(0);
  });

  it('урок: поражение не кончает забег, кости те же, переформулировка переворачивает бой', () => {
    // ищем сид, где дефолт проигрывает урок, а кайт переворачивает (по симу ~8% и 75% из них)
    for (let seed = 1; seed <= 80; seed++) {
      const state = startRun(seed);
      const seedBefore = battleSeed(state);
      const r = playFight(state);
      if (r.winner === 'party') continue;
      expect(state.status).toBe('ongoing'); // забег жив
      expect(state.resolved).toBe(false); // узел не пройден
      expect(battleSeed(state)).toBe(seedBefore); // кости те же
      lessonRewrite(state);
      const r2 = playFight(state);
      if (r2.winner === 'party') {
        expect(state.resolved).toBe(true);
        return;
      }
    }
    throw new Error('не нашлось сида, где урок проигрывается и переигрывается');
  });

  it('hp переносится в спеки следующего боя и в сам бой', () => {
    const state = startRun(1);
    const wounded = state.heroes[1]!;
    wounded.hp = 12;
    const spec = heroSpecs(state).find((s) => s.id === wounded.id)!;
    expect(spec.hp).toBe(12);
    // бой честно стартует с перенесённым hp: юниты вне досягаемости — hp не меняется
    const idle = { ...spec, rules: [], move: 0, range: 1, spawn: { x: 0, y: 0 } };
    const dummy = {
      ...spec,
      id: 'dummy',
      side: 'foe' as const,
      hp: undefined,
      rules: [],
      move: 0,
      range: 1,
      spawn: { x: 7, y: 7 },
    };
    const r = runBattle(1, [idle, dummy]);
    expect(r.units.find((u) => u.id === wounded.id)!.hp).toBe(12);
    expect(r.units.find((u) => u.id === 'dummy')!.hp).toBe(spec.maxHp);
  });

  it('после победы в бою герой получает перевязку, но не сверх максимума', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const state = startRun(seed);
      const r = playFight(state);
      if (r.winner !== 'party') continue;
      for (const h of state.heroes) {
        if (!h.alive) continue;
        expect(h.hp).toBeGreaterThan(0);
        expect(h.hp).toBeLessThanOrEqual(h.stats.maxHp);
        const inBattle = r.units.find((u) => u.id === h.id)!;
        expect(h.hp).toBeGreaterThanOrEqual(inBattle.hp);
      }
      return;
    }
    throw new Error('дефолт не выиграл урок ни на одном сиде 1..20');
  });

  it('пермасмерть: погибший не попадает в спеки следующего боя', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const state = autoplay(seed);
      const dead = state.heroes.filter((h) => !h.alive);
      if (dead.length > 0 && state.status !== 'ongoing') {
        const specs = heroSpecs(state);
        for (const d of dead) expect(specs.find((s) => s.id === d.id)).toBeUndefined();
        return;
      }
    }
    throw new Error('не нашлось сида с пермасмертью');
  });

  it('разведка видна на уроке, элитках и боссе', () => {
    const map = generateMap(1);
    expect(intelVisible(map[0]!)).toBe(true);
    expect(intelVisible(map.at(-1)!)).toBe(true);
    const elite = map.find((n) => n.kind === 'elite')!;
    expect(intelVisible(elite)).toBe(true);
    const fight = map.find((n) => n.kind === 'fight')!;
    expect(intelVisible(fight)).toBe(false);
  });

  it('боевые составы заданы для всех боевых узлов и растут по слоям', () => {
    const map = generateMap(2);
    for (const node of map) {
      if (['lesson', 'fight', 'elite', 'boss'].includes(node.kind)) {
        expect(foesForNode(node).length).toBeGreaterThanOrEqual(2);
      }
    }
    const boss = foesForNode(map.at(-1)!);
    expect(boss.some((f) => f.id === 'warlord')).toBe(true);
  });
});

describe('трофеи боя', () => {
  it('победа в бою даёт на выбор 3–4 разных слова (простые и глубокие); взятое — открывается', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const state = startRun(seed);
      const r = playFight(state);
      if (r.winner !== 'party') continue; // урок можно и проиграть — реварда нет
      expect(state.pendingReward).not.toBeNull();
      const reward = state.pendingReward!;
      expect(reward.length).toBeGreaterThanOrEqual(3);
      expect(reward.length).toBeLessThanOrEqual(4);
      expect(new Set(reward).size).toBe(reward.length);
      expect(reward.some((c) => CORE_WORDS.includes(c))).toBe(true);
      expect(reward.some((c) => DEEP_WORDS.includes(c))).toBe(true);
      for (const c of reward) expect(state.vocab).not.toContain(c);
      const picked = reward[1]!;
      expect(claimReward(state, { kind: 'concept', id: picked }).ok).toBe(true);
      expect(state.vocab).toContain(picked);
      expect(state.pendingReward).toBeNull();
      return;
    }
    throw new Error('урок не выигран ни на одном сиде 1..30');
  });

  it('пока трофей не решён — advance заблокирован; поражение реварда не даёт', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const state = startRun(seed);
      const r = playFight(state);
      if (r.winner !== 'party') {
        expect(state.pendingReward).toBeNull();
        continue;
      }
      expect(advance(state, currentNode(state).next[0]!).ok).toBe(false);
      expect(claimReward(state, { kind: 'skip' }).ok).toBe(true);
      expect(state.vocab).toEqual(STARTING_VOCAB);
      expect(advance(state, currentNode(state).next[0]!).ok).toBe(true);
      return;
    }
    throw new Error('урок не выигран ни на одном сиде 1..30');
  });

  it('трофей детерминирован сидом и не предлагает открытых слов', () => {
    const offers = [1, 2].map(() => {
      const state = startRun(9);
      let guard = 0;
      while (state.pendingReward === null && guard++ < 3) {
        const r = playFight(state);
        if (r.winner !== 'party') lessonRewrite(state);
      }
      return state.pendingReward;
    });
    expect(offers[0]).toEqual(offers[1]);
  });
});

describe('скрипторий и события', () => {
  it('слоты ограничивают число фраз', () => {
    const state = startRun(1);
    const lead = state.heroes[0]!;
    expect(lead.slots).toBe(2);
    const threePhrases = Array.from({ length: 3 }, () => ({
      condition: { id: 'always' } as const,
      preference: { id: 'act.retreat' } as const,
    }));
    expect(setPhrases(state, lead.id, threePhrases).ok).toBe(false);
  });

  it('закрытый концепт нельзя вписать в принципы', () => {
    const state = startRun(1);
    const r = setPhrases(state, state.heroes[1]!.id, [
      { condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.leader' } },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('sel.leader');
  });

  it('скрипторий открывает концепт, и он доступен конструктору', () => {
    const state = startRun(1);
    const scriptNode = state.map.find((n) => n.kind === 'scriptorium')!;
    state.at = scriptNode.id;
    const offer = scriptoriumOffer(state);
    expect(offer.concepts.length).toBeGreaterThan(0);
    const concept = offer.concepts[0]!;
    expect(STARTING_VOCAB).not.toContain(concept);
    chooseInScriptorium(state, { kind: 'concept', id: concept });
    expect(state.vocab).toContain(concept);
    expect(state.resolved).toBe(true);
  });

  it('событие: наёмник встаёт на место погибшего с чужим характером и теми же фразами', () => {
    const state = startRun(3);
    const fallen = state.heroes[2]!;
    fallen.alive = false;
    fallen.hp = 0;
    const phrasesBefore = JSON.stringify(fallen.phrases);
    const lensesBefore = [...fallen.lenses].sort();
    state.at = state.map.find((n) => n.kind === 'event')!.id;
    const offer = eventOffer(state);
    expect(offer.mercenary?.heroId).toBe(fallen.id);
    expect([...offer.mercenary!.lenses].sort()).not.toEqual(lensesBefore);
    chooseInEvent(state, { kind: 'hire' });
    expect(fallen.alive).toBe(true);
    expect(fallen.lenses).toEqual(offer.mercenary!.lenses);
    expect(fallen.name).toBe(offer.mercenary!.name);
    expect(JSON.stringify(fallen.phrases)).toBe(phrasesBefore); // принципы те же — читаются иначе
    expect(fallen.hp).toBeGreaterThan(0);
  });

  it('герои получают 1–3 случайные линзы, детерминировано сидом забега', () => {
    const a = startRun(5);
    for (const h of a.heroes) {
      expect(h.lenses.length).toBeGreaterThanOrEqual(1);
      expect(h.lenses.length).toBeLessThanOrEqual(3);
      expect(new Set(h.lenses).size).toBe(h.lenses.length);
    }
    expect(startRun(5).heroes.map((h) => h.lenses)).toEqual(a.heroes.map((h) => h.lenses));
    expect(startRun(6).heroes.map((h) => h.lenses)).not.toEqual(a.heroes.map((h) => h.lenses));
  });

  it('событие без погибших: книжник или тайник, наёмника нет', () => {
    const state = startRun(4);
    state.at = state.map.find((n) => n.kind === 'event')!.id;
    const offer = eventOffer(state);
    expect(offer.mercenary).toBeUndefined();
    expect(offer.concept || offer.slotHero).toBeTruthy();
    chooseInEvent(state, { kind: 'take' });
    expect(state.resolved).toBe(true);
  });

  it('слот из тайника/скриптория не превышает MAX_SLOTS', () => {
    const state = startRun(2);
    for (const h of state.heroes) h.slots = MAX_SLOTS;
    state.at = state.map.find((n) => n.kind === 'scriptorium')!.id;
    const offer = scriptoriumOffer(state);
    expect(offer.slotHero).toBeUndefined();
  });

  it('привал лечит долю недостающего hp', () => {
    const state = startRun(1);
    const grom = state.heroes[0]!;
    grom.hp = 10;
    state.at = state.map.find((n) => n.kind === 'rest')!.id;
    const r = rest(state);
    expect(r.ok).toBe(true);
    expect(grom.hp).toBe(10 + Math.ceil((grom.stats.maxHp - 10) * 0.6));
    expect(rest(state).ok).toBe(false); // второй раз нельзя
  });
});
