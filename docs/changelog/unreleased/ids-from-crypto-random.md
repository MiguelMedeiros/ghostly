---
section: For developers
---
- Chat folder ids, call line ids, wallet swap and payment ids, and a new chat's random ghost name are drawn from `crypto.getRandomValues` / `crypto.randomUUID` instead of `Math.random`. Nothing they name was guessable to an attacker before; this closes 27 CodeQL "insecure randomness" alerts at their source.
