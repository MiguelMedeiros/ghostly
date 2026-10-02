---
section: Fixed / Chat
---
- **Iroh relays under one spelling.** Iroh compares relay addresses as text, and the desktop app names n0's relays with the trailing dot of a full domain name (`relay.n0.iroh.link.`) while the web app lists them without it. A browser and a desktop app on the same relay each took the other's for a second relay, and a dial opened a second connection to the server it was already on. Safari and the iPhone app open no address that ends in a dot, so there the web app could not open a desktop contact's relay at all. Every relay address now goes to Iroh in one spelling, without the dot in a browser, whichever way it is written in Settings or in a contact's record.
