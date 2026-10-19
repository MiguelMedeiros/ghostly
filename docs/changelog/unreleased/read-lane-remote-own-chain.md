---
section: For developers / Apps
---
- A mini-app's `ghostly.remote.read` and `remote.stat` wait for the contact only: while one waits, the app's own `file`, `files.read`, `files.list` and `files.serve` answer as before. A contact that never answered a range held every file read of the app until it closed. The contact's reads still go one at a time and count in the app's 16 MiB a second.
