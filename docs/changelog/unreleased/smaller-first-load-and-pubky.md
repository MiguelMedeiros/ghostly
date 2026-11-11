---
section: Fixed / Everywhere
---
- The app loads less code: about 14 KB less (compressed) at every start, where a Nostr library brought a second copy of the cryptography the app already has, and about 340 KB less the first time a Pubky identity is used, whose WebAssembly now comes as a file of its own instead of as text inside a script.
