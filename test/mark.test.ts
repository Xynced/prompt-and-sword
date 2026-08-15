import { describe, expect, it } from 'vitest';
import { type Rule, type Selector, resolveSelector } from '../src/ir.js';
import { compilePhrase } from '../src/constructor.js';
import { CONCEPTS, STARTING_VOCAB, type ConceptId } from '../src/vocab.js';
import { understandingCard } from '../src/cards.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import { type UnitSpec, runBattle } from '../src/battle.js';
import { HERO_STATS } from '../src/scenarios.js';
import { advance, foeSpecs, playFight, setMark, startRun } from '../src/run.js';
import { archer, berserker, shaman, warChief } from '../src/foes.js';
import type { CombatUnit, Pos } from '../src/types.js';

/**
 * Метка — суррогат фокус-огня без party-scope: игрок помечает врага до боя,
 * правила «атаковать: помеченный» целятся в него.
 */

const FULL_VOCAB = Object.keys(CONCEPTS) as ConceptId[];

function unit(id: string, side: 'party' | 'foe', pos: Pos, over: Partial<CombatUnit> = {}): CombatUnit {
  return {
    id,
    name: id,
    side,
    maxHp: 20,
    hp: 20,
    atk: 5,
    range: 1,
    speed: 5,
    move: 3,
    pos,
    startPos: { ...pos },
    alive: true,
    guard: 0,
    exposed: false,
    tags: [],
    lenses: ['plain'],
    ...over,
  };
}

describe('селектор marked', () => {
  it('выбирает помеченного независимо от дистанции; без метки — ближайший', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const near = unit('e1', 'foe', { x: 1, y: 0 });
    const far = unit('e2', 'foe', { x: 7, y: 7 }, { tags: ['marked'] });
    expect(resolveSelector('marked', self, [self, near, far])?.id).toBe('e2');
    far.tags = [];
    expect(resolveSelector('marked', self, [self, near, far])?.id).toBe('e1');
  });

  it('помеченный пал — снова ближайший', () => {
    const self = unit('a', 'party', { x: 0, y: 0 });
    const near = unit('e1', 'foe', { x: 1, y: 0 });
    const dead = unit('e2', 'foe', { x: 3, y: 3 }, { tags: ['marked'], alive: false });
    expect(resolveSelector('marked', self, [self, near, dead])?.id).toBe('e1');
  });
});

describe('конструктор, карточка и LLM-схема', () => {
  it('фраза «атаковать помеченного» компилируется при открытом словаре и закрыта в стартовом', () => {
    const draft = {
      condition: { id: 'always' },
      preference: { id: 'act.attack', target: 'sel.marked' },
    } as const;
    const ok = compilePhrase(draft, FULL_VOCAB);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.rule.then).toEqual({ kind: 'attack', target: 'marked' });
    const closed = compilePhrase(draft, STARTING_VOCAB);
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.missing).toEqual(['sel.marked']);
  });

  it('карточка читает «атакую помеченного»', () => {
    const rule: Rule = {
      when: { kind: 'always' },
      then: { kind: 'attack', target: 'marked' },
      weight: 2,
      scope: 'self',
      source: 'тест',
    };
    const card = understandingCard({ name: 'Дарт', lenses: ['plain'] }, [rule]);
    expect(card.lines[0]).toContain('помеченного');
  });

  it('sel.marked в схеме и валидации только при открытом словаре', () => {
    expect(JSON.stringify(buildCompileSchema(FULL_VOCAB, []))).toContain('sel.marked');
    expect(JSON.stringify(buildCompileSchema(STARTING_VOCAB, []))).not.toContain('sel.marked');
    const raw = {
      phrases: [
        { condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.marked' }, weight: 1 },
      ],
      uncertainty: [],
    };
    expect(validateOutput(raw, FULL_VOCAB, [], 4).ok).toBe(true);
    expect(validateOutput(raw, STARTING_VOCAB, [], 4).ok).toBe(false);
  });
});

describe('метка в забеге', () => {
  it('setMark: только существующий враг текущего боевого узла', () => {
    const state = startRun(1);
    expect(setMark(state, 'boss').ok).toBe(true);
    expect(state.marked).toBe('boss');
    expect(setMark(state, 'нет-такого').ok).toBe(false);
    expect(setMark(state, null).ok).toBe(true);
    expect(state.marked).toBeNull();
    state.at = state.map.find((n) => n.kind === 'scriptorium')!.id;
    expect(setMark(state, 'boss').ok).toBe(false);
  });

  it('foeSpecs вешает тег на помеченного; бой с меткой детерминирован; advance снимает метку', () => {
    const state = startRun(1);
    setMark(state, 'grunt1');
    const marked = foeSpecs(state).find((f) => f.id === 'grunt1')!;
    expect(marked.tags).toContain('marked');
    expect(foeSpecs(state).filter((f) => f.tags?.includes('marked'))).toHaveLength(1);

    // спарринг «те же кости»: метка живёт на узле, бой воспроизводится побайтово
    const s2 = startRun(1);
    setMark(s2, 'grunt1');
    const a = playFight(state);
    const b = playFight(s2);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(state.marked).toBe('grunt1'); // поражение/победа метку не трогают

    if (a.winner === 'party') {
      const next = state.map[state.at]!.next[0]!;
      if (state.pendingReward) state.pendingReward = null;
      advance(state, next);
      expect(state.marked).toBeNull();
    }
  });
});

describe('критерий: метка бьёт focus-leader на элитке с шаманом', () => {
  const rule = (target: Selector): Rule => ({
    when: { kind: 'always' },
    then: { kind: 'attack', target },
    weight: 2,
    scope: 'self',
    source: `атк:${target}`,
  });
  const party = (target: Selector): UnitSpec[] => [
    { id: 'grom', name: 'Гром', side: 'party', lenses: ['fanatic'], rules: [rule(target)], ...HERO_STATS.grom },
    { id: 'dart', name: 'Дарт', side: 'party', lenses: ['literalist'], rules: [rule(target)], ...HERO_STATS.dart },
    { id: 'lia', name: 'Лия', side: 'party', lenses: ['coward'], rules: [rule(target)], ...HERO_STATS.lia },
  ];
  /** Элитка с шаманом и свитой; метка — на берсерке (игрок выбирает цель сам). */
  const elite = (markId: string | null): UnitSpec[] => {
    const foes = [warChief(), shaman('chief'), berserker(1), archer(1)];
    for (const f of foes) if (f.id === markId) f.tags = [...(f.tags ?? []), 'marked'];
    return foes;
  };
  const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);

  /** Концентрация: доля урона партии в юнит id, пока тот жив (после смерти цели огонь честно уходит дальше). */
  const dmgShare = (r: ReturnType<typeof runBattle>, id: string): number => {
    const partyIds = new Set(r.units.filter((u) => u.side === 'party').map((u) => u.id));
    let into = 0;
    let total = 0;
    for (const e of r.events) {
      if (e.t === 'die' && e.unit === id) break;
      if (e.t !== 'attack' || !partyIds.has(e.unit)) continue;
      total += e.dmg;
      if (e.target === id) into += e.dmg;
    }
    return total > 0 ? into / total : 0;
  };

  it('winrate выше, урон концентрируется в помеченного', () => {
    let markWins = 0;
    let leaderWins = 0;
    let markShare = 0;
    let rushShare = 0;
    for (const seed of SEEDS) {
      const mark = runBattle(seed, [...party('marked'), ...elite('berserk1')]);
      const leader = runBattle(seed, [...party('leader'), ...elite(null)]);
      const rush = runBattle(seed, [...party('nearest'), ...elite(null)]);
      if (mark.winner === 'party') markWins++;
      if (leader.winner === 'party') leaderWins++;
      // концентрацию меряем на тыловой цели: на поле 18×18 раш и сам фокусит
      // берсерка (move 3 добегает первым и долго остаётся ближайшим), а вот
      // лучника за спинами свиты «бей ближайшего» не выберет никогда
      markShare += dmgShare(runBattle(seed, [...party('marked'), ...elite('archer1')]), 'archer1');
      rushShare += dmgShare(rush, 'archer1');
    }
    expect(markWins).toBeGreaterThan(leaderWins);
    // концентрация видима: огонь уходит в помеченного, куда раш сам не стреляет
    expect(markShare / SEEDS.length).toBeGreaterThan(0.6);
    expect(markShare / SEEDS.length).toBeGreaterThan(rushShare / SEEDS.length + 0.3);
  });
});
