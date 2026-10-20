---
section: Fixed / Chat
---
- A chat paired while all native connection slots belong to chats used in the last 2 minutes now goes live by itself once one of those chats has been quiet for 2 minutes, as its error says. Before, on a CLI daemon (or a Desktop where you left the new chat), it stayed on the DHT until someone sent a message in it. This applies for its first 10 minutes or until it has been live once.
