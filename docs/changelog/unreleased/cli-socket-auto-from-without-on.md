---
section: Fixed / CLI
---
- Over the daemon's socket, `call.auto` and `group.auto` refuse `from` (and `call.auto`'s `rate`) unless `on` is true (`bad_request`), as `call auto` and `group auto` refuse `--from` without `on`. Before, `on: false` with `from` emptied the whole list (a bot dropping one chat dropped them all) and `from` with no `on` only read the setting, each answered as done.
