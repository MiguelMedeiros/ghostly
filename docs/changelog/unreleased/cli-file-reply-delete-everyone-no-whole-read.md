---
section: Fixed / CLI
---
- `ghostly file send --reply` to an older message (or one the chat or group does not have) and `ghostly message delete --everyone` naming a message by the id both sides know (or one that is not there) no longer read the chat's whole history at every call. In a chat of 100,000 messages each such call held the daemon for about a second, and its other commands waited. A `--reply` to a message that is not there is still refused before the file is copied in, and the answers, error codes and exit statuses are unchanged.
