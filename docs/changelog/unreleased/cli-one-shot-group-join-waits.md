---
section: Fixed / CLI
---
- `ghostly group join` run without a daemon now waits up to 60 s to be let in, then answers `"joined":true|false` and the stage it waits at; when it is not in, it says to keep the profile running (`ghostly daemon --detach`) and how to check later, and for a full group, one waiting for its members' updates or a replaced link, it says so and that stage's next step. Before, it left at once with exit 0 and the group's id, and since the knock stops when the command does, nobody let it in, even with the community's admin online.
