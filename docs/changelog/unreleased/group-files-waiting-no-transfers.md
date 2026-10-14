---
section: Fixed / Groups
---
- Texting in a group no longer costs more with every file the group has had that this device did not download. Each update the app made carried a waiting entry for every such file (with automatic downloads off, every file of every group; with them on, every file over 8 MiB and every one past the group's 256 MiB): with 5,000 of them a CLI daemon used 30% more CPU for the same texts, with 20,000 over twice as much. A group file waiting for its Download now shows no transfer once the app has heard of it, and its bubble reads it from what the device keeps of it, with its Download as before; the CLI's `file list` reads it the same way, and `file.offered` still comes when the file is announced.
