---
section: Fixed / CLI
---
- `task send`, `routine send` and `usage send` in a chat without a daemon now stay until the card went out, and `task update`, `routine update` and a later `usage send` until the contact confirmed it, up to `--timeout` (30 s; past it, exit 4 and the card goes with your next command). Before, they answered in under a second and left with the card or its update unsent: the contact saw it only with a later command that stayed long enough, and `task send --help` said it waited. `--wait none` answers at once, and a group's card still answers at once by default.
