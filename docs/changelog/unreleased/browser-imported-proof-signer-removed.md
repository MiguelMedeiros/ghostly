---
section: For developers / Identities
---
- packages/browser no longer carries the Keet mnemonic signer (`proofs/imported.ts`) and its test: nothing has imported it since the dialog that used it was removed. Keet proofs already given still verify in core.
