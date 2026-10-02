---
section: Fixed / Chat
---
- **Iroh relays under one spelling.** Iroh compares relay addresses as text, and the web app listed n0's relays without the trailing dot that Iroh and the desktop app write (`relay.n0.iroh.link` against `relay.n0.iroh.link.`). A browser and a desktop app on the same relay each took the other's for a second relay, and a dial opened a second connection to the server it was already on. Every relay address now goes to Iroh in the same spelling, whichever way it is written in Settings or in a contact's record.
