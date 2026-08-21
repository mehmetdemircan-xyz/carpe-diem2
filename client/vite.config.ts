import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // The shared protocol lives outside the client root.
    fs: { allow: ['..'] },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    // hls.js is large and deliberately kept in its own chunk, loaded only when
    // somebody actually plays a stream. The warning would be about a file that
    // most sessions never download.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Keep the socket client out of the main chunk: the landing page does
        // not need it, so first paint stays small.
        manualChunks: {
          react: ['react', 'react-dom'],
          signaling: ['socket.io-client'],
        },
      },
    },
  },
});
