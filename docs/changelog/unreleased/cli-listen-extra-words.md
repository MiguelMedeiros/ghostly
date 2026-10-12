---
section: Fixed / CLI
---
- `ghostly listen` refuses words it does not take (`ghostly listen bob`, `ghostly listen message.received`) with "Too many arguments" and its usage, exit 2, as the other commands do. It started a listener of every chat's events.
