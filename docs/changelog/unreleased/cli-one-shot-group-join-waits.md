---
section: Fixed / CLI
---
- `ghostly group join` run without a daemon now waits up to 60 s to be let in, then answers `"joined":true|false` and the stage it waits at; when it is not in, it says to keep the profile running (`ghostly daemon --detach`) and how to check later. A group with no room yet answers at once, and says the same: the knock goes on until there is room, but only while the profile runs. Before, it left at once with exit 0 and the group's id, and since the knock stops when the command does, nobody let it in, even with the community's admin online.
