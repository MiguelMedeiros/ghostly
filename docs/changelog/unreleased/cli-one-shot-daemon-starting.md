---
section: Fixed / CLI
---
- A command run while the profile's daemon is still starting (`ghostly daemon --detach && ghostly send …`, a service restarted under a bot) now goes through the daemon once it answers. Before, it failed `busy` after 5 s, called the daemon "another ghostly command" and said to start the daemon that was already running.
