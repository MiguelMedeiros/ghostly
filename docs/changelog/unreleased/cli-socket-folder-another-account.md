---
section: Fixed / CLI
---
- When a long profile path puts the daemon's socket (or a call's audio) in a folder under `/tmp` that another account made first, the refusal now says what works: set `XDG_RUNTIME_DIR` to a folder only you can enter, or use a shorter `--home`. Before, it said to remove the folder or `chmod 700` it, which another account's folder refuses.
