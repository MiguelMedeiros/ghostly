---
section: For developers / Apps
---
- On Desktop, `ghostly.files.serve(id)` looks up the one file it serves, not every file the app keeps: in a library of 100,000 files one serve no longer looks at every file on disk or spends the app's 16 MiB a second of reads, so the app's own reads right after it answer.
