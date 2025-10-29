import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { reactiveReactPlugin } from './src/lib/plugin'

// https://vite.dev/config/
export default defineConfig({
  plugins: [reactiveReactPlugin(), react()],
})
