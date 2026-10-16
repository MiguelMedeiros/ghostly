---
section: Fixed / CLI
---
- `chat accept <chat> <method> --networks ""` (or `","`) is now refused like an unknown network, and says to use `--off` to stop taking the method. It exited 0 and left the method on no network while `methods` still said it was on.
