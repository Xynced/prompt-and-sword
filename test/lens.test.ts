import { describe, expect, it } from 'vitest';
import type { Rule } from '../src/ir.js';
import { applyLens } from '../src/lens.js';

const attack = (w = 2): Rule => ({
  when: { kind: 'always' },
  then: { kind: 'attack', target: 'nearest' },
  weight: w,
  scope: 'self',
  source: 'бей ближайшего',
});
const protect = (): Rule => ({
  when: { kind: 'always' },
  then: { kind: 'protect', ally: 'mage' },
  weight: 2,
  scope: 'self',
  source: 'прикрывай мага',
});
const retreat = (): Rule => ({
  when: { kind: 'hpBelow', who: 'self', frac: 0.5 },
  then: { kind: 'retreat' },
  weight: 2,
  scope: 'self',
  source: 'ранен — отходи',
});

describe('линза: plain', () => {
  it('ничего не меняет', () => {
    const rules = [attack(), protect(), retreat()];
    const c = applyLens('plain', rules);
    expect(c.rules).toEqual(rules);
    expect(c.instincts).toMatchObject({ aggression: 1, survival: 1, ignoreZoC: false, gapFill: true });
  });
});

describe('линза: трус', () => {
  it('«прикрывать» превращается в «стоять позади»', () => {
    const c = applyLens('coward', [protect()]);
    const r = c.rules[0]!;
    expect(r.then).toEqual({ kind: 'behind', ref: { type: 'ally', id: 'mage' } });
    expect(r.source).toContain('трус');
  });

  it('атакующие правила получают штраф веса', () => {
    const c = applyLens('coward', [attack(2)]);
    expect(c.rules[0]!.weight).toBeCloseTo(1.4);
  });

  it('добавляется правило бегства при hp<30%', () => {
    const c = applyLens('coward', [attack()]);
    const flee = c.rules.find((r) => r.then.kind === 'retreat')!;
    expect(flee.when).toEqual({ kind: 'hpBelow', who: 'self', frac: 0.3 });
    expect(flee.weight).toBe(100);
  });

  it('инстинкты: самосохранение выше, агрессия ниже', () => {
    const c = applyLens('coward', []);
    expect(c.instincts.survival).toBeGreaterThan(1);
    expect(c.instincts.aggression).toBeLessThan(1);
  });
});

describe('линза: фанатик', () => {
  it('«отступай» превращается в «атакуй ближайшего»', () => {
    const c = applyLens('fanatic', [retreat()]);
    const r = c.rules[0]!;
    expect(r.then).toEqual({ kind: 'attack', target: 'nearest' });
    expect(r.when).toEqual(retreat().when); // условие сохраняется
    expect(r.source).toContain('фанатик');
  });

  it('игнорирует зоны контроля, агрессия выше', () => {
    const c = applyLens('fanatic', []);
    expect(c.instincts.ignoreZoC).toBe(true);
    expect(c.instincts.aggression).toBeGreaterThan(1);
    expect(c.instincts.survival).toBeLessThan(1);
  });
});

describe('линза: буквалист', () => {
  it('правила не трогает, но не достраивает пропуски', () => {
    const rules = [attack(), retreat()];
    const c = applyLens('literalist', rules);
    expect(c.rules).toEqual(rules);
    expect(c.instincts.gapFill).toBe(false);
  });
});

describe('детерминизм линз', () => {
  it('одинаковый вход — одинаковый выход', () => {
    const rules = [attack(), protect(), retreat()];
    expect(applyLens('coward', rules)).toEqual(applyLens('coward', rules));
    expect(applyLens('fanatic', rules)).toEqual(applyLens('fanatic', rules));
  });

  it('исходный массив правил не мутирует', () => {
    const rules = [attack(2)];
    applyLens('coward', rules);
    expect(rules[0]!.weight).toBe(2);
  });
});
