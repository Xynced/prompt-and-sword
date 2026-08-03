import { defineConfig } from 'vite';

// PORT задаёт окружение (например, превью Claude Code); иначе дефолт Vite.
export default defineConfig({
  server: { port: Number(process.env.PORT) || 5173 },
});
