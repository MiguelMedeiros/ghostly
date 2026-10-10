---
section: For developers / Apps
release: 1.2
---
- An end-to-end test plays Chess between two web apps: built and signed by the CLI, installed from a signed store and from the card, a full game, close and reopen on each side, the game back after a reload, and a tampered bundle, a lower sequence, a removed and a revoked version refused. On Desktop, a test installs an app from a store and opens it in a window of its own, which reaches the broker and nothing else. They run a pinned build of Chess (`e2e/fixtures/chess`, refreshed by `node tools/scripts/refresh-chess-fixture.mjs`).
- The compatibility e2e runs a real v1.1.4 beside the current app: an app card reaches it as its text with the bundle link, no `apps/1` is offered and the chat goes on. The accessibility test (axe) covers every Apps screen.
