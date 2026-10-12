---
section: For developers / CLI
---
- A command run without a daemon, and a daemon that stops, no longer write the profile's whole store to disk again as they leave: the few rows they wrote are in the store's journal already, which now stays (up to 1 MiB) and is read back at the next start. With 100,000 stored messages that was 35 MB written and synced at every `ghostly status` or `ghostly chat list`, from 0.4 s to more than 2 s of each depending on the disk. A command that wrote nothing writes nothing as it leaves.
