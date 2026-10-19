---
section: For developers / Apps
---
- `ghostly.files.serve(id)` looks up the one file it serves, not every file the app keeps: in a library of 100,000 files one serve no longer spends the app's 16 MiB a second of reads, so the next serve and the app's own reads answer in the same second.
