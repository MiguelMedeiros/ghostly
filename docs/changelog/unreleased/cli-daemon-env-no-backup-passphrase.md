---
section: Fixed / CLI
---
- The CLI's daemon (`ghostly daemon`, with or without `--detach`) and what it runs (ffmpeg for a voice note, the translator) no longer carries `GHOSTLY_BACKUP_PASSPHRASE` from the shell that started it. Only `profile backup` and `profile restore` read it, in their own process; `listen --exec` hooks already ran without it.
