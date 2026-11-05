---
section: Fixed / CLI
---
- A `message delete <group> <message> --everyone` without a daemon now reaches the group's members: it starts the group's connections and stays until a member's edge (a hub's, in a community) took the removal, up to `--timeout` (30 s), as `group react` does. Before, it answered done at once with the group's connections never started, and the members kept the message until your next daemon started. The answer says `edges` and `sent`; `--wait none` answers at once.
