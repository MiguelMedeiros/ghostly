---
section: Fixed / CLI
---
- `task send`, `task update`, `routine send` and `usage send` with a card past 8 KiB in all (20 `--item`s of 200 characters of non-Latin text, where each flag is within its own bound) now answer a usage error (exit 2) with the card's size and the flags to shorten, instead of `bad_request` (exit 1) with the whole card echoed back. `--item`'s help says the card holds at most 8 KiB in all.
