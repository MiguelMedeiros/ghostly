---
section: Fixed / Groups
---
- Opening a group no longer reads its whole history from the store each time: its first open asks the engine for it once, and the engine keeps it current on the page with what changes. Before, every open read it whole, and the group's next message read it whole again.
