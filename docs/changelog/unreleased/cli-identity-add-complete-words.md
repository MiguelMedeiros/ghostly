---
section: Fixed / CLI
---
- `identity add` with a remote signer (Nostr NIP-46, NIP-05 with a remote signer) whose relay cannot be reached now answers `unavailable`, naming the relay, with the way out: check the relay in the bunker link, or make a new link in your signer. A signer that refuses the link (a wrong secret) answers `refused`: approve Ghostly in the signer, or make a new link there. The signer's own words are in `details.rawError`. Before, both were `engine` in the library's or the signer's raw words ("nostr-tools/nip46: subscription to the remote signer was closed", "Not authorized"). The exit code stays 1.
- A second `identity complete` of a draft that was just finished now says "This draft is already finished: its proof is <id> (ghostly identity list)". Before, it said the draft had expired or belonged to another daemon.
- `identity complete` with nothing to finish the draft with now reads "Missing the output of the signing step (Sign with a key of the DID): …", not "Missing what Sign with a key of the DID printed". `identity add ssh` without a subject no longer nests its parentheses.
