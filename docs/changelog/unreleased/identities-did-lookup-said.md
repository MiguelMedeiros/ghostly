---
section: Fixed / Identities
---
- Adding a DID now tells a screen reader what the lookup is doing: "Looking it up…" while it runs (a did:dht can wait up to 10 s on a slow relay), then "Found:" with the DID's method once the details show and Continue can be pressed. Before, nothing was said until a refusal, so the form seemed dead behind a disabled Continue.
