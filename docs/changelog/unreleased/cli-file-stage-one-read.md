---
section: For developers / CLI
---
- Files: `ghostly file send` (to a chat or a group) reads the file once while it copies it into the profile, not a second time for its digest. Staging a 512 MiB file reads 512 MiB instead of 1 GiB and takes about 40% less CPU.
