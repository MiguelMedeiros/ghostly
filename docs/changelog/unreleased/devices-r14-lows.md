---
section: Fixed
---
- One profile on several devices (WISP 06): "It wasn't me" on a replaced device takes the turn above the one that
  replaced it even after that device's record expired, instead of writing inside that turn.
- A handoff that failed no longer leaves a list of Breez databases behind for the next handoff to delete.
- Ecash and swaps that move in a handoff are no longer marked as restored from a backup, so the new device does not
  check every proof with its mint again.
- The old copy of a profile that a handoff replaces now goes with its wallets' own databases, never one the profile
  still uses.
