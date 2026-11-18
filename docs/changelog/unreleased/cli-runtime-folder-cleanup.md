---
section: Fixed / CLI
---
- A daemon whose profile's path is too long for a socket's now removes the folder it made for its socket when it stops (and a call's, when its last call ends), if nothing else is in it. One empty `ghostly-<hash>` folder per such profile stayed in the temp folder. WISP 1100 now says where that folder is: in `$XDG_RUNTIME_DIR`, else in the system temp folder (`$TMPDIR` on macOS), else in `/tmp`.
