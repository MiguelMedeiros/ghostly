---
section: Fixed / CLI
---
- `ghostly engine updateSettings` (and the socket's `engine.call`) refuses a setting of the wrong kind, such as `mints` as a text or `nick` as an object, before anything is saved. Before, it answered with exit 0 and the profile no longer opened: every later command, the one meant to repair it included, failed with `this.settings.mints.filter is not a function`.
