import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: './dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/chat': 'http://localhost:3000',
      '/config': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/architecture': {
        target: 'http://localhost:3000',
        timeout: 600_000,
        proxyTimeout: 600_000,
      },
      '/projects': 'http://localhost:3000',
      '/slides': {
        target: 'http://localhost:3000',
        timeout: 600_000,
        proxyTimeout: 600_000,
      },
      '/video': 'http://localhost:3000',
    },
  },
})
