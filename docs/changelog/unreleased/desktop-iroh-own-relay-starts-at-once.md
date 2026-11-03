---
section: Fixed / Everywhere
---
- In the Desktop and Android apps, a chat on an Iroh relay set in Settings, Network that isn't one of n0's (your own, or Ghostly's) starts listening in about 0.2 seconds instead of 3. The app used to wait for each relay to report the app's public address, and those relays don't offer that. With eight chats it took 24 seconds before all of them could be reached.
