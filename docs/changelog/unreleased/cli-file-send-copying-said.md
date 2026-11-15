---
section: Fixed / CLI
---
- `ghostly file send` through a running daemon now says on a terminal, after a second, that the file is being copied into the profile before it goes, and that Ctrl-C there stops the send (nothing goes). It said nothing for the 6-30 s a 1 GiB file takes to copy, so a slow copy looked like a daemon that had hung. A script's pipe still gets nothing on stderr.
