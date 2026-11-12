---
section: Fixed / CLI
---
- `ghostly app publish` and `ghostly store sign` that make a new key but then cannot write the bundle or the index where `--out` says (a file where its folder goes, no room) no longer leave that key file behind. Before, the next run with a good `--out` read it as an existing key: `keyCreated: false`, and no "new … key written to …; back it up" note.
