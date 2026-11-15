import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The simagent server listens on 127.0.0.1:7410. In dev, Vite proxies the API,
// hook and WebSocket paths there so the UI runs on its own port with hot reload.
const target = 'http://127.0.0.1:7410';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': { target, ws: true, changeOrigin: true },
      '/api': { target, changeOrigin: true },
      '/hooks': { target, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
