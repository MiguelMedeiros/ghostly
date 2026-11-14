---
section: Fixed / CLI
---
- `ghostly file send --voice` takes an AAC, FLAC, `.oga`, `.weba` or `.mp4` recording. They were refused as "not audio" (the AAC and MP4 ones while the message named both as accepted), unless `--mime` was given. Sent without `--voice`, an AAC or FLAC file now goes with its audio type, so the contact's app shows it with a player and not as a plain file.
