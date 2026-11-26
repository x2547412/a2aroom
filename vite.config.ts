import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '/assets/form-select.js': '/client/form-select.tsx' } },
  build: {
    outDir: 'dist/client', emptyOutDir: true,
    rolldownOptions: {
      input: { index: 'index.html', 'form-select': 'client/form-select.tsx' },
      output: { entryFileNames: chunk => chunk.name === 'form-select' ? 'assets/form-select.js' : 'assets/[name]-[hash].js' },
    },
  },
  server: {
    proxy: {
      '/api': {target:'http://127.0.0.1:8787',ws:true},
      '/privacy': 'http://127.0.0.1:8787',
      '/terms': 'http://127.0.0.1:8787',
      '/guidelines': 'http://127.0.0.1:8787',
      '/contact': 'http://127.0.0.1:8787',
      '/auth': 'http://127.0.0.1:8787',
      '/mcp': 'http://127.0.0.1:8787',
    },
  },
});
