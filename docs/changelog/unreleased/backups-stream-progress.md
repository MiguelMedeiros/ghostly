---
section: For users / Everywhere
---
- A profile backup now holds files of any size. Before, files over 16 MiB were left out.
- Backups are made and restored a piece at a time: a profile with hundreds of megabytes of files no longer has to fit in memory, and the app stays usable while it works.
- A backup and a restore show a progress bar (what is being done, which file, how many bytes) and can be cancelled. A cancelled backup leaves no file, and a cancelled or failed restore leaves no half-made profile.
- A backup can be made without a passphrase. It is a choice you make each time, after a warning: the file then holds your keys, chats and wallet secrets in the clear. A restore tells you when a file was not protected.
- A file the device can no longer read is left out of the backup and counted, instead of failing the whole backup.
- Backups made by earlier versions still restore.
