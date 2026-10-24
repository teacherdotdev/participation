import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  // The OAuth client lists exactly http://localhost:5173 as an Authorized JavaScript origin. Fail
  // loudly instead of drifting to 5174 when the port is busy, which Google rejects as origin_mismatch.
  server: { port: 5173, strictPort: true },
})
