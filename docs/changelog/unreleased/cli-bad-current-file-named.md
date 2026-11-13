---
section: Fixed / CLI
---
- A name in `<home>/current` that is not a profile's (the file edited by hand or written by a script) no longer blocks every command: `profile list`, `profile use` and `profile create` run anyway, and the other commands are refused naming the file and how to replace it (`profile use <name>`, `profile create <name> --use`, or deleting the file). Before, every command answered a usage error (exit 2) about a name nobody typed, without saying where it came from, and only `-p` got past it.
