---
section: Fixed / CLI
---
- `ghostly app publish` and `ghostly store sign` given an `--out` they cannot write (a folder you may not write to) no longer leave the new key file behind. The next run read it as a key you already had and never said to back it up.
