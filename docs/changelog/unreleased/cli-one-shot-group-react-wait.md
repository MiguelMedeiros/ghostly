---
section: Fixed / CLI
---
- A `group react` without a daemon now stays until a member's edge (a hub's, in a community) took the reaction, up to `--timeout` (30 s), as `group send --wait sent` does. Before, it answered done at once and could leave before the reaction went to anyone: the members saw it only with your next command that opened the group. The answer says `edges` and `sent`; `--wait none` answers at once.
