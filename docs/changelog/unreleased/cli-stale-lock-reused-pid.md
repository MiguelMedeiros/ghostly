---
section: Fixed / CLI
---
- A profile whose daemon or command was stopped without letting go of it (`kill -9`, Ctrl-C of a one-shot command, a crash or a reboot) opens again even when its old process id now belongs to another program. Before, every command, `ghostly daemon` and `ghostly daemon restart` answered `busy` for good while `ghostly daemon status` said no daemon ran, until someone deleted `daemon.lock` by hand.
