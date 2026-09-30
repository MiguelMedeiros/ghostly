---
section: For developers
---
- The full E2E run pulls only the images it cannot build: `docker compose pull` stopped at the two it builds itself (the HyperDHT relay and the AT Protocol server), so every nightly since 2026-09-27 failed before a test ran.
