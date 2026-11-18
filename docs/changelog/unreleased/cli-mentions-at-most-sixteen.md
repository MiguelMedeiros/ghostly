---
section: Fixed / CLI
---
- `group send` and `group edit` with more than 16 `--mention`s are refused with the limit, before any member is looked up. The engine dropped such a list whole, so the message went out mentioning no one, and each extra ref was looked up and searched for in the text first (50,000 took the daemon 4.4 s). A ref given twice counts once.
