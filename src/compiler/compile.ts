import type { PhraseDraft } from '../constructor.js';
import { compilePhrase } from '../constructor.js';
import type { Rule } from '../ir.js';
import type { ConceptId } from '../vocab.js';
import type { CharacterId } from '../types.js';
import { type CompilerCache, cacheKey } from './cache.js';
import { buildCompileSchema, validateOutput } from './schema.js';
import { buildSystemPrompt } from './prompt.js';

/**
 * Свободный текст принципа → те же PhraseDraft/IR, что и у конструктора.
 * LLM только до боя; бой бежит на IR. Вызов модели инжектируется (ModelCall),
 * тесты работают на моках, оффлайн-режим — конструктор без этого модуля.
 */

export interface CompileRequest {
  text: string;
  heroId: string;
  heroName: string;
  character: CharacterId;
  vocab: readonly ConceptId[];
  /** id → имя живых союзников (без самого героя). */
  allies: Readonly<Record<string, string>>;
  /** Слоты героя = максимум фраз. */
  maxPhrases: number;
}

/** Один вызов модели: system + текст игрока + строгая схема → сырой JSON. */
export type ModelCall = (system: string, userText: string, schema: object) => Promise<unknown>;

export type FreeCompileResult =
  | { ok: true; phrases: PhraseDraft[]; rules: Rule[]; uncertainty: string[]; cached: boolean }
  | { ok: false; error: string };

export async function compileFreeText(
  req: CompileRequest,
  call: ModelCall,
  cache?: CompilerCache,
): Promise<FreeCompileResult> {
  const text = req.text.trim();
  if (text.length === 0) return { ok: false, error: 'пустой текст принципа' };
  const allyIds = Object.keys(req.allies);
  const key = cacheKey({
    text,
    vocab: req.vocab,
    character: req.character,
    allyIds,
    maxPhrases: req.maxPhrases,
  });

  const cachedOutput = cache?.get(key);
  let output = cachedOutput;
  if (!output) {
    const schema = buildCompileSchema(req.vocab, allyIds);
    const system = buildSystemPrompt({
      heroName: req.heroName,
      character: req.character,
      vocab: req.vocab,
      allies: req.allies,
      maxPhrases: req.maxPhrases,
    });
    let raw: unknown;
    try {
      raw = await call(system, text, schema);
    } catch (e) {
      return { ok: false, error: `вызов компилятора не удался: ${e instanceof Error ? e.message : e}` };
    }
    const v = validateOutput(raw, req.vocab, allyIds, req.maxPhrases);
    if (!v.ok) return { ok: false, error: v.error };
    output = v.output;
    cache?.set(key, output);
  }

  // Финальный гейт — тот же compilePhrase, что у конструктора: то же IR.
  const names = { ...req.allies, [req.heroId]: req.heroName };
  const rules: Rule[] = [];
  for (const draft of output.phrases) {
    const r = compilePhrase(draft, req.vocab, names);
    if (!r.ok) return { ok: false, error: `закрытые концепты в выходе компилятора: ${r.missing.join(', ')}` };
    rules.push(r.rule);
  }
  return {
    ok: true,
    phrases: output.phrases,
    rules,
    uncertainty: output.uncertainty,
    cached: !!cachedOutput,
  };
}

/** Живой ModelCall через Anthropic API (strict tool use, claude-sonnet-5). */
export function anthropicModelCall(client: import('@anthropic-ai/sdk').default): ModelCall {
  return async (system, userText, schema) => {
    const resp = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 2048,
      thinking: { type: 'disabled' },
      system,
      messages: [{ role: 'user', content: userText }],
      tools: [
        {
          name: 'compile_principle',
          description: 'Скомпилированный принцип: фразы IR и заметки о неуверенности.',
          strict: true,
          input_schema: schema as import('@anthropic-ai/sdk').Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: 'compile_principle' },
    });
    const block = resp.content.find((b) => b.type === 'tool_use');
    if (!block) throw new Error('модель не вызвала инструмент compile_principle');
    return block.input;
  };
}
