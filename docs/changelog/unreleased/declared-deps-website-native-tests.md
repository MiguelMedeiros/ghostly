---
section: For developers / Dependencies
---
- The website declares sharp, which its app-icon route and brand scripts import, instead of getting it as Next's optional dependency; the translation runtime declares bare-fs and bare-path instead of getting them through its addon; packages/cli, packages/browser and apps/extension declare the packages their tests and build config import (openpgp, bip39-mnemonic, noise-curve-ed, fake-indexeddb, @cashu/cashu-ts). Every lock keeps the versions it already held. The test that holds every workspace's `src` imports to its own package.json now reads imports from TypeScript's syntax tree (`require.resolve` included) and also checks the workspaces' tests and config (against their own package.json or the root's), the website and the native runtimes.
