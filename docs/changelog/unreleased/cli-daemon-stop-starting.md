---
section: Fixed / CLI
---
- `ghostly daemon stop` and `ghostly daemon restart` run while the profile's daemon is still starting now wait for it (up to `--timeout`) and stop it. Before, `stop` said no daemon ran and the daemon came up a moment later, and `restart` failed `busy` and left the old code running.
