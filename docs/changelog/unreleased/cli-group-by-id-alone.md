---
section: Fixed / CLI
---
- A CLI group command that names the group by its id (as a bot does, from the `group` of an event) builds only that group, not the list of every chat: a `group send` or `group typing` from a `listen --exec` bot spent about 47 ms of the daemon's time on it at 2,000 chats, and `group send --wait sent` again each time it checked.
