---
section: Fixed / CLI
---
- `ghostly chat wait <chat> --until live` returns only once a live session exists in this run of the daemon: the chat's link is open and the session authenticated on a transport, the rule the app's connection line follows. A chat that was live before a restart does not count until its contact answers again. The `live` field of `chat show` and `chat list`, the `live` count of `status`, `service peer` and the `chat.connection` event follow the same rule.
