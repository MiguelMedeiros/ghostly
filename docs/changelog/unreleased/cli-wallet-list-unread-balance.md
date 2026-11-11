---
section: Fixed / CLI
---
- `ghostly wallet list` no longer answers `"balance": 0` for a Spark, Arkade, Bark or Fedimint wallet whose balance is not read yet. Right after start, or while a wallet opens, it said 0 with no status, where the app shows "?". Such a balance is now `null`, with `status` `locked` (Spark before its wallet opens), `reading`, or `error` (a federation that did not connect).
