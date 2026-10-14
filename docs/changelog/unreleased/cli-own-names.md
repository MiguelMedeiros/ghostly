---
section: Fixed / CLI
---
- `ghostly settings set constructor 5` (or `toString`, `valueOf`, `hasOwnProperty`) is refused like any other name that is no setting. Before, it was accepted and the value stayed in the profile's settings for good. The same names are no longer taken for a transport (`chat transport bob constructor` handed the engine a function), for a command (`ghostly constructor bob hi` opened the profile and answered "No method undefined") or for a method of the daemon's socket, where `constructor` never got an answer.
