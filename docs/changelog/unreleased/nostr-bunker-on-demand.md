---
section: Fixed / Everywhere
---
- The app starts with about 42 KiB less JavaScript to load and parse: the Nostr bunker (NIP-46) signer is loaded when a proof or a post is first signed with a bunker, not at every start.
