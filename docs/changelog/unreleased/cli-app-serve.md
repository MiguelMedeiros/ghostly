---
section: For developers / CLI
release: 1.3
---
- `ghostly app serve <bundle|url> --grant chat [--grant name]` serves an app as a bot: the signed bundle is checked as a client checks it, each permission it asks needs its `--grant`, and the profile then offers apps/1 to its contacts, with no app running and no store. `app served` lists them and `app unserve` removes one.
