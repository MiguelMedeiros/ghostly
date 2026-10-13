---
section: Fixed / Chat
---
- When both sides of a chat dial each other at once (two Desktops or CLIs with no WebRTC pairing for the first time, or both apps back after a restart) and one side's dial stalls, the connection that already worked carries the chat after half a second. Before, it waited up to 2 s more for the stalled dial to be made again (3 s at most).
