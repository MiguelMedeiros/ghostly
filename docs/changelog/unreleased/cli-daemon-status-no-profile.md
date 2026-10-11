---
section: For developers / CLI
---
- `ghostly daemon status` and `ghostly daemon stop` on a profile that does not exist answer `not_found`, "No profile <name>: make it with `ghostly profile create <name>`" (exit 3), as `daemon restart` and `status` do. Before, `daemon status -p <a mistyped name>` answered `running: false` with exit 0, so a supervisor read a typo as a daemon that is down. `default`, which is made on first use, still answers `running: false`.
