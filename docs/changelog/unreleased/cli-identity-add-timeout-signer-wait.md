---
section: Fixed / CLI
---
- `ghostly identity add` with a Nostr remote signer (`nostr --signer nip46`, `domain --signer nip05-nip46`) now waits as long as `--timeout` (300 s by default) for the approval. It gave up after 2 minutes whatever `--timeout` said, as an engine failure (exit 1). An approval that does not come, from either the signer or Pubky, is now `timeout` (exit 4) naming the approval it waited for, and Pubky refuses a `--timeout` over 300 s, as long as its relay keeps the request.
