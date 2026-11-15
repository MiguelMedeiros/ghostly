---
section: For developers / Tests
---
- `node tools/scripts/test-bloat.mjs --weak` lists the unit and component tests that only check a mock was called, only that something exists, or assert nothing. The weak ones it found are rewritten to check what they promise, or deleted.
