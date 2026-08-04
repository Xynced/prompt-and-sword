import { defineConfig } from 'vite';

// PORT задаёт окружение (например, превью Claude Code); иначе дефолт Vite.
// base './' — относительные пути ассетов: сборка работает из любого подкаталога
// (itch.io отдаёт html5-игры из iframe со своим путём).
export default defineConfig({
  base: './',
  server: { port: Number(process.env.PORT) || 5173 },
});
