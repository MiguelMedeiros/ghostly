---
section: Fixed / CLI
---
- `call pipe` whose reader goes away (`ghostly call pipe | head -c …`, or a player such as `aplay` closed during the call) now leaves with exit 0 and a line saying the call goes on, as `listen` does. It died with a Node stack trace about `EPIPE` and exit 1.
