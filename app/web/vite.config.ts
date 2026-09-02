import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API runs separately in dev; same-origin in production behind the proxy.
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: true } },
  },
  resolve: {
    alias: { '@outcome/shared': new URL('../shared/src/index.ts', import.meta.url).pathname },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test-setup.ts'],
  },
});
