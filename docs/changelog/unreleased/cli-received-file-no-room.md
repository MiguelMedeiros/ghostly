---
section: Fixed / CLI
release: 1.11
---
- A received file that stops because the disk is full now says so like every other full disk: `file wait` answers `unavailable` with "No room left on the disk for this file: free some space, then ask for it again" and `details.reason: "no_space"`, and `file list`, `file resume`, `file save` and the `file.failed` event carry the same words with `reason: "no_space"`. Before, it was `engine` with Node's raw "ENOSPC: no space left on device, write".
