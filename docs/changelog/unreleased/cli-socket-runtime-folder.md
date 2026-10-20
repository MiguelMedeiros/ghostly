---
section: Fixed / CLI
---
- A profile whose path is too long for a socket keeps the daemon's socket and its calls' audio sockets in the user's own runtime folder (`$XDG_RUNTIME_DIR`), which no other account of the machine can write in, instead of a `/tmp` folder whose name anyone could work out and make first, which kept the daemon, `listen` and calls of that profile from starting. Without a runtime folder the `/tmp` folder's name carries the user's id.
