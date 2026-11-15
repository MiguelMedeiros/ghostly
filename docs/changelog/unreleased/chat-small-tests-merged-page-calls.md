---
section: For developers / Tests
---
- The chat page's, the call window's and the emoji panel's small component test files are merged into one file per screen under `apps/ui/src/test/chat/` (23 files fewer, the same 50 tests); files that share a mock (the session sync left on, the fake IndexedDB, an emoji set that fails to load) stay together and apart from the rest.
