---
section: Fixed / CLI
---
- A one-shot `ghostly group send`, `group edit`, `group react` or `group typing` with no daemon running connects only in the group it names, not in every group the profile is in. Each other group's member connections put their records on the relays and read the members', so with a few groups shared with the same people one command asked the relays about three times as often, and a `group react` could time out after 60 s, exit 4, behind them.
