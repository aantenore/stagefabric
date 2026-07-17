import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const exampleRoot = fileURLToPath(new URL('.', import.meta.url));
const packageMetadata = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { readonly version: string };

export default defineConfig({
  root: exampleRoot,
  base: './',
  define: {
    __STAGEFABRIC_VERSION__: JSON.stringify(packageMetadata.version),
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('../../dist/browser-demo', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
});
