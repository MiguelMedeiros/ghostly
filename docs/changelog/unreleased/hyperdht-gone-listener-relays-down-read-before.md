---
section: Fixed / Everywhere
---
- On the Desktop and the CLI, a chat whose contact had been away for 10 minutes keeps its HyperDHT listener while the discovery relays can't be reached, also when the contact's details were read earlier in the same run. Before, only a contact never read since the app started counted as unreadable, so a contact back over HyperDHT alone during a relay outage found no listener, and the chat stayed offline until the relays answered again. A chat that is not live also says it can't reach the relays while they are down, not only that it can't publish.
