import { describe, expect, it } from 'vitest';
import { berserker, foeIntel, hunter, shaman, warlord } from '../src/foes.js';
import { runBattle } from '../src/battle.js';
import { makeIrSets } from '../src/scenarios.js';

describe('поздние враги', () => {
  it('разведка: у каждого врага читаемые принципы', () => {
    const intel = foeIntel([warlord(), shaman('warlord'), berserker(1), hunter(1)]);
    expect(intel.map((i) => i.name)).toEqual(['Вождь орды', 'Шаман', 'Берсерк 1', 'Охотник 1']);
    for (const i of intel) {
      expect(i.lines.length).toBeGreaterThan(0);
      for (const line of i.lines) expect(line.length).toBeGreaterThan(5);
    }
  });

  it('разведка показывает поведение ПОСЛЕ линзы (фанатик-берсерк без искажений отступления — их нет)', () => {
    // у босса-фанатика правила агрессивные — линза их не трогает, intel совпадает с источником
    const intel = foeIntel([warlord()])[0]!;
    expect(intel.lines).toEqual(['вождь орды: ломать самых опасных', 'вождь орды: крови не жалеть']);
  });

  it('бой против свиты босса детерминирован и завершается', () => {
    const party = makeIrSets()[3]!.party; // guard-mage
    const foes = [warlord(), shaman('warlord'), berserker(1), berserker(2)];
    const a = runBattle(7, [...party, ...foes]);
    const b = runBattle(7, [...party, ...foes]);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(['party', 'foe', 'draw']).toContain(a.winner);
  });

  it('шаман действительно держится позади щита', () => {
    const party = makeIrSets()[0]!.party; // rush
    const foes = [warlord(), shaman('warlord')];
    const r = runBattle(3, [...party, ...foes]);
    const sham = r.units.find((u) => u.id === 'shaman')!;
    const lord = r.units.find((u) => u.id === 'warlord')!;
    // к концу боя (пока оба живы) шаман не лезет вперёд вождя к партии (партия слева, x меньше)
    if (sham.alive && lord.alive) {
      expect(sham.pos.x).toBeGreaterThanOrEqual(lord.pos.x - 1);
    }
  });
});
