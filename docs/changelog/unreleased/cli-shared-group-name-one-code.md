---
section: Fixed / CLI
release: 1.14
---
- A name more than one group has now gets one answer from every command: exit 1, `bad_request`, as `group show`, `pin`, `file send`, `saved add`, `listen --group` and `message delete --everyone` gave it. `send`, `react`, `edit`, `typing`, `chat show`, `message delete`, `listen --from`, `call start`, `chat verify`, `group auto on --from` and the other commands that take a chat answered it `not_found`, exit 3, as if nothing had that name. A name nothing has still answers `not_found`. With `message delete --purge`, that refusal no longer folds the store, as for any `bad_request`.
