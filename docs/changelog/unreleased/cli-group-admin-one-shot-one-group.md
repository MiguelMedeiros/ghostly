---
section: Fixed / CLI
---
- A one-shot `ghostly group rename`, `group picture`, `group hub` or `group rotate` with no daemon running connects only in the group it names, as `group send` does, not in every saved chat and group. Each of those put its records on the relays first, so with a dozen saved invites one command took the relays' whole minute of requests.
