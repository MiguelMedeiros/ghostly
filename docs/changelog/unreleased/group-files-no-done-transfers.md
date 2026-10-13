---
section: Fixed / Groups
---
- While a file moves, the app no longer does more work for every group file the device already has. Each update it made of a transfer's progress (about 24 a second) carried a finished entry for every group file kept on the device: 0.4 ms and 36 KB an update with one file, 3 ms and 2.4 MB with 20,000. A group file that is all here now shows no transfer, and reads as done from what the device keeps of it, as before; the CLI's `file list` and `file accept` read it the same way.
