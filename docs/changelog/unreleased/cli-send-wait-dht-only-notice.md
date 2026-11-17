---
section: Fixed / CLI
---
- `ghostly send --wait sent` (or `delivered`) of a text longer than the 256 bytes the DHT carries, in a chat kept on the DHT only, now says on the terminal why the text waits and what ends that (`ghostly chat transport <chat> auto`, or shorten it), while it waits and when Ctrl-C stops the wait. It said "it still goes" and that the text would go by itself while the profile is online, or with its next command, which it does not while the chat stays on the DHT only. Same `interrupted` code and exit 130.
