---
section: Fixed / Chat
---
- Checking a long message made of seed words (one that is not a seed) for a secret took up to a quarter of a second, and forwarding 30 of them held the CLI daemon or the app for several seconds; it now takes a few tens of milliseconds.
