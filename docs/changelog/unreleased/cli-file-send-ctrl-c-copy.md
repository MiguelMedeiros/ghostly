---
section: Fixed / CLI
---
- Ctrl-C on `ghostly file send` through a daemon, while a large file was still being copied into the profile, said the command stopped before the daemon answered, but the daemon went on and sent the file a moment later (sent again, it went twice). The send now stops there: nothing is kept and nothing goes. `file send --wait sent` says so while it waits: a Ctrl-C before the file is copied in stops the send, one after it leaves the file to go.
