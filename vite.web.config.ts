// Renderer-only Vite config for browser-based development (npm run dev:web).
// The backend runs in src/devserver/server.ts and is reached over a WebSocket.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = process.cwd();

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  resolve: {
    alias: {
      '@': resolve(root, 'src/renderer/src'),
      '@shared': resolve(root, 'src/shared')
    }
  },
  plugins: [react()],
  server: { port: 5174, strictPort: true }
});
