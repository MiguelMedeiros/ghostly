---
section: Fixed / CLI
---
- A chat or group named with extra spaces, a zero-width or direction mark, or a decomposed accent (`chat rename X "bot "`, `group create "Team  "`, `invite create --label "my  bot"`) is now found by that same string in `chat show`, `send`, `group show` and every command that takes a chat or group. The name is stored cleaned, and the name you type is now cleaned the same way before it is compared, so the command no longer answers `not_found`. Ids, contact keys and id prefixes still match only exactly.
