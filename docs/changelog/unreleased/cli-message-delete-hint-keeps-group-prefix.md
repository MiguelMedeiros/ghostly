---
section: Fixed / CLI
---
- `ghostly message delete group:<name> <message>` (without `--everyone`) now suggests `ghostly message delete group:<name> <message> --everyone`, keeping `group:`. Before, the suggestion dropped it, so pasted beside a chat with the same name it looked for the message in that chat and said there was no such message.
