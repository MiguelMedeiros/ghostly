import { createRequire } from 'node:module';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { maxWorkers } from '../../vitest.shared';

// OpenPGP.js publishes its lightweight build under a "browser" condition only. It
// runs in Node too, so tests load the very code the apps ship (WebCrypto and
// noble curves) rather than the Node build, which swaps in node:crypto.
const openpgp = join(createRequire(import.meta.url).resolve('openpgp'), '../../lightweight/openpgp.mjs');

export default defineConfig({
  resolve: { alias: [{ find: /^openpgp\/lightweight$/, replacement: openpgp }] },
  test: { maxWorkers },
});
