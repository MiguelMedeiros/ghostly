---
section: Fixed / CLI
---
- `ghostly profile backup` reads each file's size once, while it lists the profile's files: it read every size a second time, all at once, and a profile with 20,000 files held the daemon ~100 ms before the backup started writing.
