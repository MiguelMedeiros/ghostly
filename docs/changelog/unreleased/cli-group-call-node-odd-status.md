---
section: Fixed / CLI
---
- `ghostly engine groupCallOccupancy`, `groupCallToken` and `groupCallModerate` answer at once when a group's call node replies with a status the CLI could not hold (205 with a body, or 600 and above). The daemon never answered the call, and a command without a daemon crashed.
