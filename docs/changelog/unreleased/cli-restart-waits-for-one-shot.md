---
section: Fixed / CLI
---
- `ghostly daemon restart` (and `daemon --detach`) while a bot keeps running one-shot commands on the profile no longer stops the daemon and then fails `busy` (or "The daemon did not start"), leaving no daemon at all: a command that holds the profile for a moment is waited for, within `--timeout`. When the start does fail after the stop, the error says the daemon was stopped and to start it again with `ghostly daemon --detach`.
