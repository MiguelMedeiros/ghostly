---
section: Fixed / CLI
release: 1.11
---
- `ghostly listen --print --exec` keeps its stdout to the JSON events: what the hook prints goes to stderr instead of
  landing between the event lines. A hook killed by a signal is said as such ("--exec was killed by SIGKILL on event
  4") instead of as an exit 1.
