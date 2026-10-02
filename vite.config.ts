import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {legacyCss} from './vite.legacyCss';

export default defineConfig(() => {
  return {
    // legacyCss: a copy of the stylesheet for older browsers (old Windows
    // laptops' Chrome among them), loaded only where it's needed.
    plugins: [react(), tailwindcss(), legacyCss()],
    // Stamped into the bundle so the running build can identify itself. A
    // phone quietly serving a superseded bundle cost several rounds of
    // debugging symptoms that had already been fixed; now every terminal log
    // says which build produced it.
    define: {
      __BUILD_STAMP__: JSON.stringify(new Date().toISOString().replace(/\.\d+Z$/, "Z")),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
