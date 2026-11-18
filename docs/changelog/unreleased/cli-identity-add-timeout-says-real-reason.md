---
section: Fixed / CLI
---
- `identity add` with a remote signer (Nostr NIP-46, NIP-05 with a remote signer, Pubky) now says why a proof was refused when the signer approved in time but the check ended after `--timeout`: the refusal keeps its own words and code (for example a domain whose `nostr.json` does not list the key). Before, it answered `timeout` (exit 4), "waiting to approve, --timeout waits longer", and a retry asked for a new signature only to fail the same way. A signer that never answers is still `timeout`.
