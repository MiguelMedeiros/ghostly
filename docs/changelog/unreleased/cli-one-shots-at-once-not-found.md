---
section: Fixed / CLI
---
- Several commands at once on one profile without a daemon (a script's `&`, two terminals) no longer end now and then with `not_found` on a file such as `daemon.lock.<pid>.start`. Each command checks the profile's files before it starts, and a file that another command removed during that check is now skipped.
