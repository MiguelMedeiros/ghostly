---
section: Fixed / CLI
---
- The commands the CLI suggests with a chat or group's name in them (`ghostly group send …` when `send` is given a group, `ghostly group accept …`, `ghostly listen --group …`, `ghostly file list …`) now quote the name for the shell, so pasting one names the same chat or group. Before, a name in double quotes like `"$5 lunch"` lost its `$5` when pasted, and a backtick in a name ran a command.
