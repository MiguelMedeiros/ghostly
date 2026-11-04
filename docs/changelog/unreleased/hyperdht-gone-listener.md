---
section: Fixed / Everywhere
---
- A chat whose contact has been away for 10 minutes no longer keeps a HyperDHT listener announced on the Desktop and the CLI (about 62 requests a minute each, for nobody). It listens again as soon as the contact is back, so that contact may take up to about half a minute longer to go live. While the discovery relays can't be reached, it listens as before, so a contact back over HyperDHT alone still reconnects.
