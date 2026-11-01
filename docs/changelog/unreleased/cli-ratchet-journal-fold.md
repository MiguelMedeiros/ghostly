---
section: Fixed / CLI
---
- The CLI no longer keeps a chat's used forward secrecy keys in its journal for days: a journal that holds them is folded once the snapshot is an hour old, so a copy of the profile folder cannot open older envelopes.
