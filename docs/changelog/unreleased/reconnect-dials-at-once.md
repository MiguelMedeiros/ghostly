---
section: Fixed / Chat
---
- Reconnect (and `ghostly chat connect`) dials at once when WebRTC can carry the chat, and Iroh and HyperDHT join as they come up. Before, it waited for every native listener first: 10 s or more a reconnect when Iroh's relay was out of reach. A chat that only goes live over Iroh or HyperDHT still waits for them.
