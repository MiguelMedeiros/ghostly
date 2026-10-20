---
section: Fixed / CLI
---
- On a full disk, the CLI now says `unavailable` "No room left for <file>: free some space, then try again", naming the file where it knows it. Before, it gave Node's bare "ENOSPC: no space left on device, write" as an `engine` error (or `bad_request` from `profile backup`). `listen --cursor` now stops with that error when it can no longer write its cursor. Before, it ran on with exit 0, printed one error line per event, and a restart handed the same events again.
