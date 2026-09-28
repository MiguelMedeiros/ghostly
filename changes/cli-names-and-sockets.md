---
section: Security / Everywhere
---
- The command line never takes a name a contact gave itself for someone else: a contact key finds only that contact's chat, a chat's own label wins over a contact's name, and `listen --from <key>` keeps the key. This holds for `listen`, `call auto`, `pay` and every command that names a chat.
- When a profile's path is too long for its daemon socket, the socket goes in a folder of the user's alone, and commands connect only to a socket of the user's.
- Hooks run without the backup passphrase in their environment, `settings` hides the wake-up push subscription, and an opened shared app answers only at 127.0.0.1 or localhost.
