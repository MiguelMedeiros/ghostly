---
section: Fixed / CLI
---
- `ghostly message delete <chat> <message>` (no `--everyone`) on a waiting text of yours answers `"everyone": true` when it went for everyone: a text that was just being retried may already be out, so the app deletes it for everyone. Before, the answer said `"everyone": false` and the help said the contact keeps theirs. The help and the README now say that a waiting text is cancelled, as the app's Cancel sending.
