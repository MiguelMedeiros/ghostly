---
section: Fixed / CLI
---
- `ghostly group join` run without a daemon now waits up to 60 s to be let in, then answers `"joined":true|false` and the stage it waits at; when it is not in, it says to keep the profile running (`ghostly daemon --detach`) and how to check later. A group that is full or waits for its members' updates says so, and that you get in once there is room while the profile runs; a link that was replaced says to ask for the current one. Before, it left at once with exit 0 and the group's id, and since the knock stops when the command does, nobody let it in, even with the community's admin online.
