---
section: Fixed / CLI
---
- `ghostly listen` now refuses an empty `--webhook`, `--exec`, `--cursor`, `--from` or `--group`, such as a unit file's `--webhook "$URL"` with the variable unset, before the profile opens. An empty `--webhook`, `--exec` or `--cursor` ran a plain listen without a word: no hook, no POST, no cursor kept. An empty `--from` or `--group` failed later as "chat is required".
