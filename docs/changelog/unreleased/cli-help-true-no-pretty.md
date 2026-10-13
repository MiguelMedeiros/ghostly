---
section: Fixed / CLI
---
- `--help=true` shows the command's help as `--help` does, and `--help=false` runs the command. Before, `--help=true` ran it, even `chat remove --yes`.
- A global option's `--no-` form may come before the command, as the option itself may: `ghostly --no-pretty status` answered "Unknown command".
