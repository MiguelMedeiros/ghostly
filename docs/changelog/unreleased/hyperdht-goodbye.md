---
section: Fixed / Everywhere
---
- When Ghostly closes or its CLI daemon stops, a contact connected over HyperDHT hears that it is going, as a contact over WebRTC already did, and looks for it to come back. Before, the goodbye was dropped unsent and the contact found out only when the connection closed.
