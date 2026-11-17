---
section: Fixed / CLI
---
- `ghostly daemon status`, `daemon stop` and `daemon restart` refuse `--detach`, `settings get` refuses `--force`, `settings set` refuses `--show-secret`, `engine --list` refuses the flags of an engine call and an engine call refuses `--verbose`, as an unknown option (exit 2) naming the command and its help. Each took the other form's flag and did nothing with it, exit 0. `daemon status --timeout` with a value that is no number of seconds above 0 is refused whether or not a daemon runs: it was refused only when one did.
