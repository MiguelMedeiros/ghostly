---
section: Fixed / Chat
---
- A chat moved back to WebRTC a moment after leaving it (Iroh or HyperDHT tried, then WebRTC again) no longer sometimes takes 28 s to get there: the contact's app, closing the WebRTC session the chat had left, also closed the new one it was answering, and the move gave up and waited for its next try. Now it goes in about 3 s every time.
