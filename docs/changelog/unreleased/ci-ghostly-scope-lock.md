---
section: For developers / CI
---
- CI fails when package-lock.json brings an `@ghostly/*` package from anywhere but a workspace link, or resolves any package from a registry tarball in the `@ghostly` scope: that npm scope is not ours, and the workspaces depend on each other with `"*"`. `node tools/scripts/ghostly-scope-lock.mjs` names each such entry on one line.
