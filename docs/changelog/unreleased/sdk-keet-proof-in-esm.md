---
section: Fixed
---
- `@ghostlytools/sdk/core` verifies a Keet identity proof. Its `verifyPeerProof` threw "Calling `require` for "b4a"" on every Keet proof, valid or not, because the bundled Keet library asked for its packages with a `require` an ES module does not have.
