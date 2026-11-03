---
section: For developers
---
- The HyperDHT relay (`infra/services/hyperdht-relay`) answers a listen it refuses (the key is already listened on through it): the client gets `listening` at no address (0.0.0.0:0), then `closed`, where it used to get nothing and waited for its own timeout. Deploy it only after the web app that reads this answer.
