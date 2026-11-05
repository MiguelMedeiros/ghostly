---
section: Fixed / CLI
---
- A `pin <group> <message>` or a `forward … --to <group>` without a daemon now reaches the group's members: it starts the group's connections and stays until a member's edge (a hub's, in a community) took the pin or the forwarded message, up to `--timeout` (30 s), as `group send` and `group react` do. Before, a pin answered done at once and went nowhere until your next daemon started, and a forward's `--wait sent` could only time out. A group pin's answer says `edges` and `sent`, a forward's group result `edges`; `--wait none` answers at once.
