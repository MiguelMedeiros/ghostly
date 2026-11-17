---
section: Fixed / CLI
---
- `chat wait --until live` that times out on a chat on DHT only (this side's choice or hold, or the contact's) now says why it never went live and what ends it, in the words `chat connect` uses. Before, it ended "Timed out after N s waiting for chat <id> to be live" like a slow network, after the whole timeout (up to a day). A `chat wait` timeout also names the chat as it was given (`bob`), as its waiting notice does, not by its id. Still `timeout`, exit 4.
