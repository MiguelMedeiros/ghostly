---
section: Fixed / Files
---
- A large file's progress is kept as it was at a cut: the newest progress is written once its 2 s are up, and at once when the chat's connection goes. Before, only the first progress of each 2 s was written, so an app restarted soon after a cut showed the file where it stood before (a whole resumed stretch on a fast link).
