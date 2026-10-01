---
section: Fixed / Chat
---
- On an app with WebRTC (web, macOS Desktop, the extension), chats with a contact that has none (Ghostly Desktop on Linux, a CLI with WebRTC off) get the app's native connections first when it starts: those contacts can reach it no other way. Chats with contacts that have WebRTC take what is left, most recent first, as before.
- A chat that was live when the app last quit, and whose contact never came back, no longer tries to resume that connection at every start. After a minute of a run without it going live, the app treats that connection as over.
