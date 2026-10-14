---
section: Fixed / Everywhere
---
- A chat whose Iroh listener could not start (its relay out of reach, or no network when the app started) starts it again by itself, and at once when the network is back. It stayed without Iroh until you opened the chat, and a CLI daemon's chats never got it back: a contact with no WebRTC could not reach them over Iroh until the daemon restarted. Groups already did this.
