---
section: Fixed / Devices
---
- On Linux, macOS and Android, moving a profile back to a device that already holds its videos and other files over 16 MB no longer copies each of them into the moved profile. The moved profile gets its own name for the file that is already there, so nothing is written, and the old copy stays as it was until the move is over. Each file is still checked where it is stored before it is kept, so one that changed on disk is not reused. In a test, a move back with three such files wrote none of them and passed none of their bytes to the page; before, it wrote 50 MB and read the same 50 MB back through the page. On Windows and in the browser these files are still copied as before.
