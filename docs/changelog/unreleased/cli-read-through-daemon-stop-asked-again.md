---
section: Fixed / CLI
---
- A read such as `ghostly chat list` started just as the daemon stops or restarts now answers. On a busy machine, it could fail with "The daemon went away before it answered chat.list, twice" when it asked again before the stopping daemon had closed its socket.
