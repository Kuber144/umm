import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The backend listens on a unix socket. UMM_SOCK overrides it for a private dev backend.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')  // an empty prefix includes process.env, so HOME is there
  const socketPath = env.UMM_SOCK || `${env.HOME}/Library/Application Support/umm/umm.sock`
  return { plugins: [react()], server: { fs: { allow: ['..'] }, proxy: { '/api': { target: { socketPath } } } } }
})
