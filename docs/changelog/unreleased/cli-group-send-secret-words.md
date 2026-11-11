---
section: Fixed / CLI
---
- `ghostly group send` says what a refused text looks like, as `ghostly send` does. A Cashu token in a group was refused as "a secret or a Cashu token", without saying that anyone who reads it can take the money, and a login to a node (an LND macaroon, a Core Lightning rune, a bitcoind cookie) read as a Cashu token or a seed. It now says "a Cashu token (money anyone who reads it can take)", "a secret (a seed or a private key)" or "a secret (a login to a node …)", the same words as a send to a contact.
