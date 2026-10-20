import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The backend listens on a unix socket. UMM_SOCK overrides it for a private dev backend.
export default defineConfig(({ mode }) => {
  const socketPath = loadEnv(mode, '.', '').UMM_SOCK || decodeURIComponent(new URL('../data/umm.sock', import.meta.url).pathname)
  return { plugins: [react()], server: { fs: { allow: ['..'] }, proxy: { '/api': { target: { socketPath } } } } }
})
