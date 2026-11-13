---
section: Fixed / CLI
---
- `ghostly identity add` with a NIP-46 link that is not a valid `bunker://` URL (`nostr`, or `domain --signer nip05-nip46`) is refused as `bad_request`, naming the `bunker` field, before the signer starts. It ended as `engine`, so a script read its own mistake as a Ghostly failure.
