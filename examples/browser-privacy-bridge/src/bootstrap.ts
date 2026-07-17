import { z } from 'zod';

// Zod otherwise probes dynamic-code support with Function(), which is both
// unnecessary for this reference app and rejected by its strict CSP.
z.config({ jitless: true });

await import('./main.js');
