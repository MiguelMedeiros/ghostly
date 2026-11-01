---
section: Fixed / CLI
---
- `ghostly listen` through a daemon that had handed it no event yet now follows a daemon restart from where it left off. Before, it went on from the new daemon's present, skipping the restart's `daemon.started` and whatever came in its first second (contacts' queued messages, delivered just then), with nothing said on stderr.
