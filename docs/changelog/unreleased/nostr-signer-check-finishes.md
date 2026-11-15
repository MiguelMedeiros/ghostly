---
section: Fixed / Identities
---
- A Nostr or NIP-05 proof signed with a remote signer or a browser extension is no longer reported as cancelled or timed out ("Your Ghostly identity is unchanged") when the two minutes, a Cancel or the CLI's `--timeout` come while the app is still checking the signed statement: that check now finishes and says the real outcome. Before, the proof was saved anyway, and trying again made a second one.
