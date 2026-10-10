---
section: For developers / CLI
---
- Calls: a program's audio stays at real time while the daemon is busy for a long stretch, such as sending a large file during the call. Every frame that is due goes out when the daemon gets to it, and after a stall of more than a second what the program wrote during it is dropped. Before, the contact heard the program about 2 s late for the rest of the call after a 200 MiB file.
