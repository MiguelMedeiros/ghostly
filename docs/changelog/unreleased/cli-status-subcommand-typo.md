---
section: Fixed / CLI
---
- A typo after `ghostly status` (`status shwo`, `status clr`) names the command meant, or the ones `status` takes, as every other group does; it said "Too many arguments: ghostly status". `ghostly help status shwo` and `ghostly help daemon frob` are usage errors too, not the group's help with exit 0.
