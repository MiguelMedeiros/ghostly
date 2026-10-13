---
section: Fixed / Desktop
---
- On Desktop (and Android), a chat over Iroh no longer drops its connection when the app hands it frames faster than the link carries them (a file or a mini-app sending to a contact on a slow link): each frame now waits for room on the connection instead of being refused once 32 were queued, and the chat's send budget counts it until it is written, so files and apps see the real queue and keep to their share.
