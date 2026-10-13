---
section: Fixed / CLI
---
- `--help=true` shows the command's help as `--help` does; before, it ran the command (`chat remove <chat> --yes --help=true` removed the chat). `ghostly --no-pretty status` works as `ghostly status --no-pretty` does, instead of "Unknown command: --no-pretty status".
