---
section: Fixed / CLI
---
- `app open`, `app send` and `app close` without a daemon now tell you to start one with `ghostly daemon --detach`. Before, they said `ghostly daemon start`, a command that does not exist.
