---
section: Fixed / CLI
---
- A contact's typing (`typing.*` and `group.typing.*`) no longer fills the event journal: a `listen --cursor` bot that was down, or `events --since`, got far fewer messages back than the journal keeps, and typing starts from hours before. Typing events now go to the listeners live only, as a contact's app frames do.
