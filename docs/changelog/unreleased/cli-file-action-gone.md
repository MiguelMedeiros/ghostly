---
section: Fixed / CLI
---
- `ghostly file request`, `resend`, `pause`, `resume`, `cancel`, `accept` and `decline` of a file that is no longer here (its sender deleted it for everyone while it was arriving, or its message was deleted here) answer `not_found` (exit 3) as `file save` and `file wait` do. `file request` said "Nothing to ask for: the file is all here", `file resend` "it arrived whole", and the others the engine's own "No such file transfer".
