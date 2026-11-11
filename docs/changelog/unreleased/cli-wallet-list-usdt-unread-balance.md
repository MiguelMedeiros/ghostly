---
section: Fixed / CLI
---
- `ghostly wallet list` no longer answers `"balance": "0"` for a USDT wallet whose balance is not read yet. Until its RPC answered (a slow one takes a minute, one that is down never does) it said "0" with no status, where the app shows "?". Such a balance is now `null`, with `status` `locked` or `reading`.
