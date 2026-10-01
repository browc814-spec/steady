import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the same build works on Netlify (/) and GitHub Pages (/steady/).
  base: './',
  plugins: [react()],
})
