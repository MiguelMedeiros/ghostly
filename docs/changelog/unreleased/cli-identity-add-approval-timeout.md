---
section: Fixed / CLI
---
- `identity add` with a signer you approve in another app (Pubky, a Nostr remote signer) ends with a timeout (exit 4) when nobody approves in time, naming the approval it waited for and `--timeout`, now in the usage line. Before, after 5 minutes it failed as an engine error, "The operation was aborted due to timeout".
