import { describe, expect, it } from 'vitest';
import { mulberry32, shuffle } from '../src/rng.js';

describe('mulberry32', () => {
  it('тот же seed — та же последовательность', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('разные сиды — разные последовательности', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('значения в [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('shuffle', () => {
  it('детерминирован по сиду и не теряет элементы', () => {
    const items = [1, 2, 3, 4, 5];
    const a = shuffle(items, mulberry32(3));
    const b = shuffle(items, mulberry32(3));
    expect(a).toEqual(b);
    expect(a.slice().sort()).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5]); // исходный не мутирует
  });
});
