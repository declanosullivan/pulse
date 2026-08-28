import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 45321,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 45321,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    cssCodeSplit: true,
  },
});
