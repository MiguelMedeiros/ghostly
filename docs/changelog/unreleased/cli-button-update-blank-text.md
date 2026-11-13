---
section: Fixed / CLI
---
- `ghostly button update --text` with only spaces (an empty variable with a space, `--text "$ANSWER "`) is refused (`bad_request`), and the question keeps its words. Before, it answered exit 0 and the question became the buttons' fallback line ("Reply: Yes / No") for everyone in the chat or group.
