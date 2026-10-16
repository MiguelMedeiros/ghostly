---
section: Fixed / Everywhere
---
- CLI: a second `events.subscribe` on a daemon socket connection that is subscribed already is refused (`bad_request`). Before, every later event came once per subscribe, and each replay got past the connection's 8 MiB bound for unread data.
