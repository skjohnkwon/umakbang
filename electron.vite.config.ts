import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // No `define` here. There used to be one, injecting a GitHub token for a private update
    // feed - the releases are public now and nothing in the bundle needs a credential. See
    // the note at the top of `src/main/updater.ts` before adding one back.
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Forked by the main process; scanning must not share the window's thread.
          scanner: resolve(__dirname, 'src/main/scanner-process.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    // The analysis worker loads Essentia's WebAssembly build through a dynamic import, so
    // that a couple of megabytes are only fetched when that engine is actually selected.
    // A dynamic import is a code split, and Vite's default IIFE worker output cannot be
    // split — so the workers are ES modules, which Chromium has supported for years.
    worker: { format: 'es' },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    }
  }
})
