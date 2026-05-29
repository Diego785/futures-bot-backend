import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite es el tooling del Trading Cockpit (SPA cliente). No es maqueta: es el shell final.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
