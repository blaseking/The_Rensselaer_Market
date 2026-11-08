import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { evidenceUploadsPlugin } from './vite-plugin-evidence-uploads.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), evidenceUploadsPlugin()],
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  resolve: {
    alias: {
      buffer: 'buffer',
    },
  },
})
