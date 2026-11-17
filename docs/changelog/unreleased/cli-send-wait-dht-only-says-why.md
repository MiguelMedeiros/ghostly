---
section: Fixed / CLI
---
- `ghostly send --wait sent` (or `delivered`) of a text longer than the 256 bytes the DHT carries, in a chat kept on the DHT only, still waits as asked, but its timeout now says why the text waits and what ends that (`ghostly chat transport <chat> auto`, or shorten it), also as `details.note`. It said the text still goes by itself while the profile is online, or with its next command, and neither happens while the chat stays on the DHT only. Same `timeout` code and exit 4.
