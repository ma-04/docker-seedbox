import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Dev-only: `MOCK=1 npx vite` serves a tiny in-memory API (never part of the production bundle). */
function mockApi(): Plugin {
  return {
    name: 'seedbox-mock-api',
    apply: 'serve',
    async configureServer(server) {
      if (!process.env.MOCK) return;
      const { mockMiddleware } = await import('./mock/server');
      server.middlewares.use('/api', mockMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [react(), mockApi()],
  server: {
    proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: true } },
  },
});
