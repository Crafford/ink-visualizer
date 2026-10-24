import { defineConfig } from 'vite';

// base './' so the build works from any static path (GitHub Pages, S3, a subfolder).
export default defineConfig({
  base: './',
  // three.js alone is ~500 kB minified; the warning is expected for a single-page visualizer.
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 800 },
});
