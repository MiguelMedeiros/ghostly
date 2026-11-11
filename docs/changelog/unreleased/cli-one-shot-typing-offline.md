---
section: Fixed / CLI
---
- `ghostly typing` and `ghostly group typing` without a daemon and without `--for` reach nobody: typing is said on a live session, and a one-shot has none. They answered `live: false` with exit 0, and the command still waited for the relays before it ended (about 3 s with a slow relay, 10 s with one that does not answer). They now answer at once, without going online, and a `note` says the typing reached nobody and how to make it reach the contact (`ghostly daemon --detach`, or `--for`).
