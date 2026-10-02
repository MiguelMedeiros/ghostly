---
section: Fixed / Chat
---
- On a network that blocks UDP (a VPN, a firewall), chats and groups took longer to connect with every saved chat: each chat's Iroh listener, the one that still works there through a relay, waited about 6 seconds per chat ahead of it for a HyperDHT listener that could not reach its network. Each transport's listeners now start in their own line, so Iroh is ready for every chat at once. This also shortens the start of an app with many chats on any network.
