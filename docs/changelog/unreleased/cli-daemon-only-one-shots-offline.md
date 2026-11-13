---
section: Fixed / CLI
---
- `ghostly call start`, `service open`, `app open`, `app close` and `app send` need a running daemon. Without one, they waited for the relays before they said so: about 3.5 s with a slow relay, and 10 s with one that does not answer. They now answer at once with the same words, and the profile does not go online for them.
