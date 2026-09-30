---
section: Fixed / CLI
---
- The echo bot in the CLI's README, docs/CLI.md, `examples/echo-bot.sh` and the site's CLI page works on Debian and Ubuntu. `listen --exec` runs its script with `/bin/sh`, which is dash there, and the example used bash's `<<<`: every message failed with "Syntax error: redirection unexpected".
