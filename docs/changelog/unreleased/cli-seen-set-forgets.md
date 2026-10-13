---
section: Fixed / CLI
---
- A long-running daemon no longer keeps a note in memory for every message of its history: the record of what `listen` reported forgets a message 30 days after its last activity (its arrival, an edit, a reaction), unless it is one of yours not delivered yet. An edit or a reaction to an older message is still reported. The first start after the upgrade reads each chat's history once.
