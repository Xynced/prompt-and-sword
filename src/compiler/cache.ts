import type { ConceptId } from '../vocab.js';
import type { CharacterId } from '../types.js';
import type { CompilerOutput } from './schema.js';
import { PROMPT_VERSION } from './prompt.js';

/**
 * Кэш компиляций. Ключ — полный (текст + словарь + характер + союзники +
 * версия промпта): без хэша нет и коллизий. TTL не нужен — компиляция
 * детерминированно зависит только от ключа.
 */

export interface CompilerCache {
  get(key: string): CompilerOutput | undefined;
  set(key: string, value: CompilerOutput): void;
}

export function cacheKey(args: {
  text: string;
  vocab: readonly ConceptId[];
  character: CharacterId;
  allyIds: readonly string[];
  maxPhrases: number;
}): string {
  return JSON.stringify([
    PROMPT_VERSION,
    args.text.trim(),
    [...args.vocab].sort(),
    args.character,
    [...args.allyIds].sort(),
    args.maxPhrases,
  ]);
}

export function memoryCache(): CompilerCache {
  const map = new Map<string, CompilerOutput>();
  return {
    get: (k) => map.get(k),
    set: (k, v) => void map.set(k, v),
  };
}
