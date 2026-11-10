---
section: Fixed / CLI
---
- `file list` now reads only the chat's or group's messages that carry a file. Before, each call read the whole history: in a chat of 9,000 texts a bot polling it cost the daemon 56-75 ms a call, with its other calls waiting behind it, now under 1 ms whatever the chat's length. A profile opened for the first time after the update indexes its files once (about 90 ms for 9,000 messages).
