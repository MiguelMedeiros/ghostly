---
section: Fixed / CLI
---
- A `ghostly chat rename` or `ghostly chat remove` run with no daemon running now says its change on `listen` and `events`, as a daemon does (`chat.renamed`, `chat.removed`). The one-shot ended before the change reached its event list, so a listener started later never heard of it, and a removed chat's events stayed in the list.
