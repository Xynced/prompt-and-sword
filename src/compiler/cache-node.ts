import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CompilerCache } from './cache.js';
import type { CompilerOutput } from './schema.js';

/** Дисковый кэш для CLI/скриптов: один JSON-файл в .cache/. Только Node. */
export function fileCache(path = '.cache/compiler.json'): CompilerCache {
  const load = (): Record<string, CompilerOutput> => {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, CompilerOutput>;
    } catch {
      return {};
    }
  };
  return {
    get: (key) => load()[key],
    set: (key, value) => {
      const data = load();
      data[key] = value;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(data, null, 2));
    },
  };
}
