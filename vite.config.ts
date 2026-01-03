import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',  // Required for Electron - makes asset paths relative
  publicDir: 'public',  // Serve static files like AudioWorklet from public/
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true
  },
  server: {
    port: 5173
  }
})

