---
section: Fixed / Chat
---
- Choosing a connection (WebRTC, Iroh, HyperDHT) right after choosing WebRTC no longer moves the chat twice. A move back to WebRTC waits a few seconds for the old WebRTC connection to close; a choice made in that wait now replaces it, where before the chat went to WebRTC first and then moved again.
