import { createRequire } from 'node:module';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { maxWorkers } from '../../tools/vitest.shared.ts';

// OpenPGP.js publishes its lightweight build under a "browser" condition only. It
// runs in Node too, so tests load the very code the apps ship (WebCrypto and
// noble curves) rather than the Node build, which swaps in node:crypto.
const openpgp = join(createRequire(import.meta.url).resolve('openpgp'), '../../lightweight/openpgp.mjs');
// The store the website's build fetched (apps/website/lib/store-snapshot.json) is written by its build and not kept in
// the repository: its tests read a snapshot of their own.
const storeSnapshot = join(import.meta.dirname, 'test/fixtures/website-store-snapshot.json');

export default defineConfig({
  resolve: {
    alias: [
      { find: /^openpgp\/lightweight$/, replacement: openpgp },
      { find: /^\.\/store-snapshot\.json$/, replacement: storeSnapshot },
    ],
  },
  test: { maxWorkers },
});
