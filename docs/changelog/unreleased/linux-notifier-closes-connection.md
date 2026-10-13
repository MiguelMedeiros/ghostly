---
section: Fixed / Desktop
---
- On Linux, each notification given up on a notification server that stopped answering no longer leaves a D-Bus connection and a thread behind for good: the connection given up on is closed, and its click listener ends with it.
