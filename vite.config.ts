import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/client',
  base: './',
  publicDir: '../../public',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8765'
    }
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true
  }
});
