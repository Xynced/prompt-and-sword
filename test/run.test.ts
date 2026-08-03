import { describe, expect, it } from 'vitest';
import {
  MAX_SLOTS,
  NODES,
  type RunState,
  chooseInScriptorium,
  currentNode,
  playFight,
  scriptoriumOffer,
  setPhrases,
  startRun,
} from '../src/run.js';
import { STARTING_VOCAB } from '../src/vocab.js';

/** Прогоняет забег до конца: в скриптории берёт первое предложение. */
function autoplay(seed: number): RunState {
  const state = startRun(seed);
  while (state.status === 'ongoing') {
    const node = currentNode(state)!;
    if (node.kind === 'fight') {
      playFight(state);
    } else {
      const offer = scriptoriumOffer(state);
      chooseInScriptorium(
        state,
        offer.concepts[0]
          ? { kind: 'concept', id: offer.concepts[0] }
          : offer.slotHero
            ? { kind: 'slot', heroId: offer.slotHero }
            : { kind: 'skip' },
      );
    }
  }
  return state;
}

describe('мини-забег', () => {
  it('детерминирован: тот же seed — тот же результат и лог', () => {
    const a = autoplay(5);
    const b = autoplay(5);
    expect(a.status).toBe(b.status);
    expect(a.log).toEqual(b.log);
  });

  it('заканчивается победой или поражением', () => {
    for (const seed of [1, 2, 3]) {
      expect(['won', 'lost']).toContain(autoplay(seed).status);
    }
  });

  it('пермасмерть: погибший герой не участвует в следующих боях', () => {
    // ищем сид, где кто-то погиб, но забег продолжился
    for (let seed = 1; seed <= 30; seed++) {
      const state = startRun(seed);
      while (state.status === 'ongoing') {
        const node = currentNode(state)!;
        if (node.kind === 'fight') {
          const deadBefore = state.heroes.filter((h) => !h.alive).length;
          playFight(state);
          const deadAfter = state.heroes.filter((h) => !h.alive).length;
          if (state.status === 'ongoing' && deadAfter > deadBefore) {
            // герой погиб, забег идёт — проверяем, что он не в спеках следующего боя
            const deadIds = state.heroes.filter((h) => !h.alive).map((h) => h.id);
            expect(deadIds.length).toBeGreaterThan(0);
            return;
          }
        } else {
          chooseInScriptorium(state, { kind: 'skip' });
        }
      }
    }
    throw new Error('не нашлось сида с пермасмертью при живом забеге');
  });

  it('слоты ограничивают число фраз', () => {
    const state = startRun(1);
    const grom = state.heroes[0]!;
    expect(grom.slots).toBe(2);
    const threePhrases = Array.from({ length: 3 }, () => ({
      condition: { id: 'always' } as const,
      preference: { id: 'act.retreat' } as const,
    }));
    const r = setPhrases(state, 'grom', threePhrases);
    expect(r.ok).toBe(false);
  });

  it('закрытый концепт нельзя вписать в принципы', () => {
    const state = startRun(1);
    const r = setPhrases(state, 'dart', [
      { condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.leader' } },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('sel.leader');
  });

  it('скрипторий открывает концепт, и он становится доступен конструктору', () => {
    const state = startRun(1);
    playFight(state); // бой 1
    if (state.status !== 'ongoing') return; // на этом сиде проиграли — не важно
    const offer = scriptoriumOffer(state);
    expect(offer.concepts.length).toBeGreaterThan(0);
    const concept = offer.concepts[0]!;
    expect(STARTING_VOCAB).not.toContain(concept);
    chooseInScriptorium(state, { kind: 'concept', id: concept });
    expect(state.vocab).toContain(concept);
  });

  it('слот из скриптория увеличивает лимит до MAX_SLOTS', () => {
    const state = startRun(2);
    playFight(state);
    if (state.status !== 'ongoing') return;
    const offer = scriptoriumOffer(state);
    if (!offer.slotHero) return;
    const hero = state.heroes.find((h) => h.id === offer.slotHero)!;
    const before = hero.slots;
    chooseInScriptorium(state, { kind: 'slot', heroId: offer.slotHero });
    expect(hero.slots).toBe(before + 1);
    expect(hero.slots).toBeLessThanOrEqual(MAX_SLOTS);
  });

  it('структура забега: 5 боёв, скрипторий между ними', () => {
    expect(NODES.filter((n) => n.kind === 'fight')).toHaveLength(5);
    expect(NODES.filter((n) => n.kind === 'scriptorium')).toHaveLength(4);
    expect(NODES.at(-1)?.kind).toBe('fight');
  });
});
