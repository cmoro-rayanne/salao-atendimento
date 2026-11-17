import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // Em desenvolvimento, a API roda em `npm run dev` (porta 3000).
    proxy: { '/admin/api': 'http://localhost:3000' },
  },
});
