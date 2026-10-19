---
section: Fixed / CLI
---
- A command whose daemon stops while the command waits on it (a `listen` that served the profile and whose reader left) fails with `unavailable` "The daemon went away", as JSON. Before, when the daemon left the command's request unread, the command crashed with a Node.js `ECONNRESET` stack trace and no JSON answer.
