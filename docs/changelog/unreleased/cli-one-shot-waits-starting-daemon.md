---
section: Fixed / CLI
---
- A command run while the profile's daemon is starting waits up to 30 s for it, not 5 s, and a daemon that is still not up then is named as the one holding the profile. Before, a daemon whose start took longer than 5 s (a large profile) made the command fail as if "another ghostly command" held the profile.
