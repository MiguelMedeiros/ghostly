---
section: Fixed / CLI
---
- `ghostly chat connect` to a contact whose app is closed answers `unavailable` with what happens next: the daemon dials again by itself, and `chat wait <chat> --until live` waits for it. It answered `engine` with HyperDHT's own words, "PEER_NOT_FOUND: Peer not found", as if the CLI had failed, or "Could not connect to the peer" with no next step. HyperDHT's words are in `details.reason`.
