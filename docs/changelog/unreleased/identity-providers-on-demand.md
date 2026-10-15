---
section: Fixed / Everywhere
---
- The app's first load has about 78 KiB less JavaScript: the identity proof providers (Nostr, Pubky, a domain, OpenPGP, Bitcoin, SSH, OpenID Connect, DID, AT Protocol) load on their own once the app has started, when the profile's proofs load or something about identities is first shown.
