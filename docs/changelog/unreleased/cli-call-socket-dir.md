---
section: For developers / CLI
---
- A daemon started with `GHOSTLY_CALL_SOCKET_DIR=<folder>` puts its calls' audio sockets in that folder, so a voice program running as another user (a Ghostly OS node's assistant) can open them. The folder is one you make, of the daemon's user, 0750 with the other user's group (`chmod 2750`, so the sockets take that group; on Linux the daemon refuses a folder of another group that is not setgid, whose sockets that group could never open); each socket is 0660, and a program must send the call's token first. A starting daemon removes only the sockets its crashed calls left there, so the folder may hold other files and several profiles' daemons may share it. Without it, nothing changes.
