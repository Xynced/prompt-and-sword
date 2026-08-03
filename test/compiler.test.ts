import { describe, expect, it, vi } from 'vitest';
import {
  type CompileRequest,
  type ModelCall,
  anthropicModelCall,
  compileFreeText,
} from '../src/compiler/compile.js';
import { buildCompileSchema, validateOutput } from '../src/compiler/schema.js';
import { memoryCache } from '../src/compiler/cache.js';
import { compilePhrase } from '../src/constructor.js';
import { understandingCard } from '../src/cards.js';
import { STARTING_VOCAB } from '../src/vocab.js';

/** Все тесты компилятора — на моках ModelCall; живой API не нужен. */

const req: CompileRequest = {
  text: 'Прикрывай Лию, а если врагов больше — отступай',
  heroId: 'grom',
  heroName: 'Гром',
  character: 'fanatic',
  vocab: STARTING_VOCAB,
  allies: { lia: 'Лия', dart: 'Дарт' },
  maxPhrases: 2,
};

const goodOutput = {
  phrases: [
    { condition: { id: 'always' }, preference: { id: 'act.protect', ally: 'lia' }, weight: 1 },
    { condition: { id: 'cond.outnumbered' }, preference: { id: 'act.retreat' }, weight: 1 },
  ],
  uncertainty: [],
};

const mock = (raw: unknown, model = 'mock-model'): ModelCall =>
  Object.assign(
    vi.fn(async () => raw),
    { model },
  );

describe('buildCompileSchema', () => {
  it('закрытые концепты не попадают в схему', () => {
    const s = JSON.stringify(buildCompileSchema(STARTING_VOCAB, ['lia']));
    expect(s).not.toContain('sel.leader'); // не в стартовом словаре
    expect(s).not.toContain('space.behind');
    expect(s).not.toContain('cond.allyInDanger');
    expect(s).toContain('sel.nearest');
    expect(s).toContain('act.retreat');
  });

  it('id союзников — enum, чужих не бывает', () => {
    const s = JSON.stringify(buildCompileSchema(STARTING_VOCAB, ['lia', 'dart']));
    expect(s).toContain('"enum":["lia","dart"]');
  });
});

describe('compileFreeText', () => {
  it('валидный выход модели → те же правила, что у конструктора', async () => {
    const r = await compileFreeText(req, mock(goodOutput));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules).toHaveLength(2);
    const names = { ...req.allies, grom: 'Гром' };
    const viaConstructor = goodOutput.phrases.map((d) => {
      const c = compilePhrase(d as never, STARTING_VOCAB, names);
      return c.ok ? c.rule : null;
    });
    expect(r.rules).toEqual(viaConstructor);
    expect(r.uncertainty).toEqual([]);
  });

  it('концепт вне открытого словаря в выходе — ошибка, не догадка', async () => {
    const bad = {
      phrases: [{ condition: { id: 'always' }, preference: { id: 'act.attack', target: 'sel.leader' }, weight: 1 }],
      uncertainty: [],
    };
    const r = await compileFreeText(req, mock(bad));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('словаря');
  });

  it('инъекция через веса/поля отбивается: weight вне {1,2} приводится к 1, мусорные поля не проходят', async () => {
    const inject = {
      phrases: [
        { condition: { id: 'always' }, preference: { id: 'act.retreat' }, weight: 999, damage: 999 },
      ],
      uncertainty: [],
    };
    const r = await compileFreeText(req, mock(inject));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules[0]!.weight).toBe(1.5); // weight 1 × 1.5 конструктора, не 999
    expect(JSON.stringify(r.rules)).not.toContain('999');
  });

  it('frac зажимается в [0.1, 0.9]', () => {
    const raw = {
      phrases: [
        { condition: { id: 'cond.hpBelow', who: 'self', frac: 9.9 }, preference: { id: 'act.retreat' }, weight: 1 },
      ],
      uncertainty: [],
    };
    const v = validateOutput(raw, STARTING_VOCAB, ['lia'], 2);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.output.phrases[0]!.condition).toEqual({ id: 'cond.hpBelow', who: 'self', frac: 0.9 });
  });

  it('чужой id союзника — ошибка', () => {
    const raw = {
      phrases: [{ condition: { id: 'always' }, preference: { id: 'act.protect', ally: 'boss' }, weight: 1 }],
      uncertainty: [],
    };
    const v = validateOutput(raw, STARTING_VOCAB, ['lia'], 2);
    expect(v.ok).toBe(false);
  });

  it('фраз больше слотов — ошибка', async () => {
    const many = {
      phrases: Array.from({ length: 3 }, () => ({
        condition: { id: 'always' },
        preference: { id: 'act.retreat' },
        weight: 1,
      })),
      uncertainty: [],
    };
    const r = await compileFreeText(req, mock(many));
    expect(r.ok).toBe(false);
  });

  it('неуверенность доносится до результата и карточки', async () => {
    const withNote = {
      phrases: [{ condition: { id: 'always' }, preference: { id: 'space.nearTo', ref: { ally: 'lia' } }, weight: 1 }],
      uncertainty: ['Гром не знает слова «засада». Понял как: держаться рядом с Лией.'],
    };
    const r = await compileFreeText(req, mock(withNote));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const card = understandingCard(
      { name: 'Гром', character: 'fanatic' },
      r.rules,
      { lia: 'Лия' },
      r.uncertainty,
    );
    expect(card.lines.some((l) => l.includes('⚠') && l.includes('засада'))).toBe(true);
  });

  it('кэш: повторный запрос не зовёт модель', async () => {
    const cache = memoryCache();
    const call = mock(goodOutput);
    const r1 = await compileFreeText(req, call, cache);
    const r2 = await compileFreeText(req, call, cache);
    expect(r1.ok && !r1.cached).toBe(true);
    expect(r2.ok && r2.cached).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    if (r1.ok && r2.ok) expect(r2.rules).toEqual(r1.rules);
  });

  it('другой словарь — другой ключ кэша (модель зовётся снова)', async () => {
    const cache = memoryCache();
    const call = mock(goodOutput);
    await compileFreeText(req, call, cache);
    await compileFreeText({ ...req, vocab: [...STARTING_VOCAB, 'sel.leader'] }, call, cache);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('другая модель — другой ключ кэша (смена провайдера не отдаёт чужой кэш)', async () => {
    const cache = memoryCache();
    const deepseek = mock(goodOutput, 'deepseek-chat');
    const sonnet = mock(goodOutput, 'claude-sonnet-5');
    await compileFreeText(req, deepseek, cache);
    await compileFreeText(req, sonnet, cache);
    expect(deepseek).toHaveBeenCalledTimes(1);
    expect(sonnet).toHaveBeenCalledTimes(1); // кэш deepseek не подошёл
  });

  it('универсальный провайдер: без tool_use JSON вынимается из текста, thinking чужим моделям не шлётся', async () => {
    const create = vi.fn(async (_params: unknown) => ({
      content: [{ type: 'text', text: 'Вот результат:\n```json\n' + JSON.stringify(goodOutput) + '\n```' }],
    }));
    const fakeClient = { messages: { create } } as unknown as Parameters<typeof anthropicModelCall>[0];
    const call = anthropicModelCall(fakeClient, 'deepseek-chat');
    expect(call.model).toBe('deepseek-chat');
    const r = await compileFreeText(req, call);
    expect(r.ok).toBe(true);
    const params = create.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(params.model).toBe('deepseek-chat');
    expect('thinking' in params).toBe(false); // параметр Claude — чужой провайдер может на нём упасть
  });

  it('ошибка вызова модели — ok:false, не исключение', async () => {
    const failing: ModelCall = Object.assign(
      async () => {
        throw new Error('нет сети');
      },
      { model: 'mock-model' },
    );
    const r = await compileFreeText(req, failing);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('нет сети');
  });
});
