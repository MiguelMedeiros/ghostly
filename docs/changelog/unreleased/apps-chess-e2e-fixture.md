---
section: For developers / Apps
release: 1.2
---
- The Chess end-to-end tests and the store-keys test run a pinned build of Chess (`e2e/fixtures/chess`) instead of building it on the fly. `node tools/scripts/refresh-chess-fixture.mjs` writes it from `apps/mini/chess`, or with `--bundle` from a Chess bundle signed by its publisher key (a file, or a URL pinned to a commit), and a test fails while the fixture is older than `apps/mini/chess`.
