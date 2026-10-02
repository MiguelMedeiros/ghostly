---
section: Fixed / Everywhere
---
- A backup that runs out of room on the device now fails and says so ("This device has no room left for this backup"). Before, it could leave the file it was writing out, say the backup was made, and produce a file that no restore would open.
- A restore that runs out of room while it writes a large file says so too, instead of "File write out of order".
