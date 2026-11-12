---
section: Fixed / CLI
---
- A CLI daemon that shows its contacts no online dot no longer tells their closed apps, by a push notice 30 seconds after each start, that it came online. It does so only with `ghostly settings set daemonPresence true`, and a one-shot command never does.
