---
section: Fixed / CLI
---
- When the disk fills under a running daemon, a change it could not save (`settings set`, for one) is now refused with code `unavailable` (exit 1) and "No room left on the disk of <profile folder>: free some space, then try again", instead of answering done and being gone after the next restart. Once there is room again, `ghostly daemon stop` and `restart` finish in their usual time, where they waited 20 seconds, answered `timeout` and left the profile with no daemon.
