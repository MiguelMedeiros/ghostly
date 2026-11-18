---
section: Fixed / CLI
---
- The app's words for a message action name the command that does it, instead of "Unknown command (ghostly help)": `ghostly reply` points to `send <chat> --reply <message>`, `unpin` to `pin <chat> --remove`, `unreact` to `react <chat> <message> --remove` (it said "did you mean react?", which adds a reaction), `delete` to `message delete`, `history` to `chat history`, and `message edit`/`react`/`pin`/`forward` to the top-level command. `ghostly search` and `chat search` say the CLI has no search yet and how to find a message with `chat history` and `jq`.
