---
section: Fixed / CLI
---
- A global option before the command (`--pretty`, `--profile bot`, `--home dir`) no longer changes an option whose value is `--`. Before, `ghostly --pretty profile set --name --` set the name contacts see to `--pretty`, and `ghostly --pretty edit <chat> <message> --text --` sent `--pretty` as the new text.
