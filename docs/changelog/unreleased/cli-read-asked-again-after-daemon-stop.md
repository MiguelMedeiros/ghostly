---
section: Fixed / CLI
---
- A read (`chat list`, `status` and the like) that reaches the daemon just as `daemon stop` or `daemon restart` does is now asked once more, through the daemon that runs then or on the profile itself, and answers. Before, it failed with `unavailable` (exit 1) "The daemon went away", or as a daemon of an older release (`refused`), and a script could not tell it from a real failure.
