---
section: Fixed / CLI
---
- `""` given where a chat or a group is named (an unset variable in a script) names nothing: `forward … --to ""` and `call auto on --from ""` are a usage error before the profile opens (`--to "" names no chat or group`, exit 2), and so is `--to "group:"`. `""` was a prefix of every id: with one chat it forwarded to that chat or put it on auto-answer, and `--to "group:"` forwarded a chat's message into the only group. A daemon's API callers get `bad_request` for the same.
