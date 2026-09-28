---
section: Security / Everywhere
---
- On the command line, `wallet redeem` reads the Cashu token from stdin when none is given, and `wallet create --stdin` takes secret fields and the API key as `name=value` lines, so they never show in `ps` to other users of the machine or in the shell's history. A token or API key still given as an argument works, with a warning.
