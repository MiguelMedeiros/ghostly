---
section: Fixed / Chat
---
- The app, and the CLI's daemon, no longer do more work for every file a chat ever sent or received. Each update of the app's state carried a finished entry for every one of them, again after every start: at 10,000 files 1 MB an update, and most of a daemon's busy time while it only texted. A file that finished before the app started now shows no transfer and reads as done from what the device keeps of it, as a group's file does; the CLI's `file list` reads it the same way.
