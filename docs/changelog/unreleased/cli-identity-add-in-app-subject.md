---
section: Fixed / CLI
---
- `ghostly identity add` no longer drops the subject given to a signer that runs here: `identity add domain example.com --signer nip05-nip46` takes the domain from it instead of asking for `--field domain`, and `identity add nostr <npub>` with a remote signer that holds another key fails before anything is signed, naming both keys, instead of making a proof of the signer's key.
