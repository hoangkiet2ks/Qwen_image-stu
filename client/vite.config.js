import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Tailscale Serve forwards the HTTPS hostname to this local-only Vite
    // server. Allow that Host header so a second Tailnet device is not
    // rejected with Vite's default 403 protection.
    allowedHosts: process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS ? [process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS] : [],
    // Proxy /api/* requests to the Express proxy server during development
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
