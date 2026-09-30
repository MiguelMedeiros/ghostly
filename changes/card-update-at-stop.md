---
section: Fixed / Chat
---
- A bot's last card update (often "done" or "failed") no longer disappears when its daemon stops within 2.5 seconds of sending it: the update still waiting for its turn goes before the daemon ends, and `task update` no longer answers `confirmed: true` for an update that has not gone yet.
