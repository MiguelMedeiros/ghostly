---
section: For developers / CLI
---
- A daemon that crashed during a call no longer leaves the call's audio socket file behind for good: the files piled up in the profile's `calls` folder (or its folder in `/tmp`) with every crash. The daemon now clears that folder's sockets when it starts, since no call outlives it.
