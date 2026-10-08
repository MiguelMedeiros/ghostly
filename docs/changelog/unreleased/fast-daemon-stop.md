---
section: Fixed / Chat
---
- `ghostly daemon stop` (and quitting the app) publishes nothing after saying goodbye to your contacts except the packet that says the app left. Before, a chat could start a new connection offer and publish it about 3 seconds after the goodbye. A daemon stopped soon after it started is also done in about 0.1 s instead of 3 to 5 s: it no longer waits for a HyperDHT or Iroh connection that is still starting.
