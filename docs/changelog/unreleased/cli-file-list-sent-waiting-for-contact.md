---
section: Fixed / CLI
---
- `ghostly file list` now shows a file sent to a contact who is away (`file send --wait none`, or a `--wait sent` that timed out) as waiting for them: its `transfer` says `state: "transferring"`, how far it went, `stage: "waiting"` and `waitingFor: "contact"`. It showed `transfer: null` until the contact came online, as if it were an old file that had finished.
