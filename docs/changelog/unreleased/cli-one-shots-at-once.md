---
section: Fixed / CLI
---
- Two `ghostly` commands started at once on one profile with no daemon (a script's `&`, two terminals) no longer fail at once with `busy`: the second waits up to 5 seconds for the first. One that still finds the profile in use says how to go on: run the commands one after another, or start `ghostly daemon --detach`.
