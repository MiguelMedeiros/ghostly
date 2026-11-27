---
section: Fixed / CLI
---
- `ghostly app publish` also refuses an app folder holding a wallet's secret the CLI already asks about in a message (a seed phrase, an nsec, an xprv or WIF key, a Cashu token, a hex private key under a key's name), a publisher or store key file that opens with a byte order mark or blank lines, or any of these in `ghostly-app.json` itself, its description or release notes included: such a secret went out in the public bundle.
