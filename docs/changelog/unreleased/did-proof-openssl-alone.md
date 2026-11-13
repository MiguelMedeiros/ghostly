---
section: Fixed / Everywhere
---
- Identities: the OpenSSL command in a DID proof's steps needs only OpenSSL and prints the signature in base64. It piped the signature through `xxd`, which many Linux systems don't have, and then printed nothing to paste.
