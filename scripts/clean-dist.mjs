import { rm } from 'node:fs/promises';

await rm(new URL('../dist/', import.meta.url), {
  force: true,
  recursive: true,
  maxRetries: 3,
  retryDelay: 100,
});
