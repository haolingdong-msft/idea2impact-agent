import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: './dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/chat': apiTarget,
      '/config': apiTarget,
      '/health': apiTarget,
      '/auth': apiTarget,
      '/architecture': {
        target: apiTarget,
        timeout: 600_000,
        proxyTimeout: 600_000,
      },
      '/projects': apiTarget,
      '/slides': {
        target: apiTarget,
        timeout: 600_000,
        proxyTimeout: 600_000,
      },
      '/editable-pptx': {
        target: apiTarget,
        timeout: 1_200_000,
        proxyTimeout: 1_200_000,
      },
      '/video': apiTarget,
      '/slide-video': {
        target: apiTarget,
        timeout: 1_800_000,
        proxyTimeout: 1_800_000,
      },
    },
  },
})
