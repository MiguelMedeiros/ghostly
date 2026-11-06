---
section: Fixed / CLI
---
- `chat wait --until text` now says what it waits for: "Timed out after 60 s waiting for chat <id> to carry text", and on a terminal "waiting for chat bob to carry text" and, after Ctrl-C, "chat bob could not carry text yet". Before, it read "to be text" and "was not text yet".
