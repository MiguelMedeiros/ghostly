---
section: Fixed / CLI
---
- `ghostly identity add nostr --field bunker=...` uses the remote signer (NIP-46) without `--signer nip46`. Before, the CLI picked the browser extension signer (NIP-07) first and failed with "No NIP-07 signer in this window". `identity providers` no longer marks NIP-07 and AT Protocol as `headless`; asking for them says to make the proof in the app. A subject the provider cannot read, or more days than it allows, is now a `bad_request`, not an `engine` error.
