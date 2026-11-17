---
section: Fixed / CLI
release: 1.14
---
- `ghostly engine <call>` given less than the call takes now says so as a usage error (exit 2) before the profile opens, and before `--yes` is asked. Before, `ghostly engine switchGroup` or `removeLink` with no parameters first asked to confirm the deletion (exit 5), and only after `--yes` said the parameters were missing (exit 1). Over the socket, `engine.call` also answers `bad_request` before asking for `yes`.
