---
section: Fixed / CLI
---
- `ghostly chat history` and `group history` take an agent turn's `messageId` (`t_…`) in `--before` and `--after`, as every other option that takes a message does. They answered `not_found` (exit 3), so an agent could not read the messages around the one it was answering.
