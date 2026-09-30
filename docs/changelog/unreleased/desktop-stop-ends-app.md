---
section: For developers / Tests
---
- A Desktop end-to-end test that closes an app and opens it again no longer runs two apps on the same profile: `stop()` waits for the processes the app's driver started, by their own PIDs, to end (SIGTERM, then SIGKILL) instead of leaving one running with its window open.
