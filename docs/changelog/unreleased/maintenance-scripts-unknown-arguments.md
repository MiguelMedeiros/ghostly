---
section: For developers / Tests
---
- `npm run coverage`, `npm run test:map`, `npm run locales:sort` and `node tools/scripts/changes.mjs` refuse an argument they do not take with their usage and exit 2, before doing anything. Before, `npm run coverage -- cor` ran nothing and exited 0, `npm run test:map -- --wirte` wrote no map, and `npm run locales:sort -- --check` sorted the files instead of checking them. Coverage names the packages it knows.
