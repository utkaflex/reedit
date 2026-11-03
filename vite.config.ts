import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { randomUUID } from 'node:crypto';
import { pwaPlugin } from './build/pwa';
import { compressionPlugin } from './build/compression';
// Never reuse an active shell cache, even when a deployment is rebuilt from identical sources.
const build = randomUUID();

export default defineConfig({
  server: { proxy: { '/api/catalog': 'http://127.0.0.1:4174' } },
  define: { __REEDIT_BUILD__: JSON.stringify(build) },
  plugins: [react(), tailwindcss(), pwaPlugin(build), compressionPlugin()],
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup.ts'] },
});
