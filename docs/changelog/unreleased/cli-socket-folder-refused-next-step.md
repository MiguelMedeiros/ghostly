---
section: Fixed / CLI
---
- When the daemon's socket goes to a folder outside the profile (a long home path) and that folder is open to other users or is not this user's, `ghostly daemon` answers `refused` and says what to do: remove the folder (ghostly makes it again) or `chmod 700` it. Before, it answered `engine` with no next step. A profile folder that is a link or another user's is `refused` too, as the profile's other checks are.
