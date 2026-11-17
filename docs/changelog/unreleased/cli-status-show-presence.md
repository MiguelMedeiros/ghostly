---
section: For developers / CLI
---
- `status show` also says whether this profile shows itself online: `presence` is `active` while a daemon runs it with `settings set daemonPresence true` (as its contacts see it), and null otherwise: a one-shot, presence off, or a profile restored with "Share when I'm online" off. A bot can check that its contacts see it online without `settings get` and guessing.
