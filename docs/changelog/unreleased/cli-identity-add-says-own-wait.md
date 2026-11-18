---
section: Fixed / CLI
---
- `identity add` with an in-app signer (Nostr NIP-46, NIP-05 with a remote signer, Pubky) now says what it waits on in words on a terminal (`ghostly: Approve the Ghostly identity statement in your signer.`), with the link or code to approve on its own line. On a pipe it still writes the JSON events. It shows only its own proof's wait: before, two `identity add` runs on one daemon each printed the other's prompt and approval link. The `identity.approval` and `identity.progress` events now carry the `request` id that the `identity.add` call gave.
