---
section: Fixed / CLI
---
- `identity add` on a daemon started before the update to 1.13.2 (not restarted since) still prints every in-app signer wait, as before; restart the daemon to see only its own.
