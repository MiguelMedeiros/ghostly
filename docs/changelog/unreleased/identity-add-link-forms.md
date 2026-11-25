---
section: Fixed / Identities
---
- Adding an identity now takes the link a wallet or app copies for it: a `bitcoin:` address link (its amount and label are ignored), a `nostr:npub1…` link, an `openpgp4fpr:` fingerprint link, `_@example.com` or `http://example.com` for a domain, a GitHub or GitLab profile address, and an `at://` account link. Before, Ghostly refused them with a message that blamed the wrong thing.
