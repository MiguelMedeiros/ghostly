---
section: Fixed / CLI
---
- `file list` in a chat or group with many files costs the daemon less: the history's file rows are read from the disk store in a few batches, not one read per file (1,600 files: about 19 ms down to 14 ms a call on a fast machine). The voice-time and group-file lookups go through the same read.
