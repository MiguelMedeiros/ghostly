---
section: Fixed / CLI
---
- `ghostly message delete <group> <message>` on a message another member sent now says that only its author deletes a group's message, for everyone. Before, it suggested the same command with `--everyone`, which was then refused because the message is not yours.
