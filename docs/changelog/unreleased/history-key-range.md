---
section: For developers / CLI
---
- A long chat no longer makes every send slower in the `ghostly` CLI: its history is read by the chat's own key range, not through an index that looked each message up again. At about 3,000 messages a send went from about 1 s to under 0.5 s of the daemon's time.
