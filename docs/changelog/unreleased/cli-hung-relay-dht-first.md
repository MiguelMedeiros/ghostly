---
section: Fixed / Chat
---
- The CLI no longer waits 10 seconds on a discovery relay that takes requests and never answers. A publish counts as out once the DHT took it, and a read the relays have not answered within 1.5 seconds asks the DHT too, so `ghostly invite create` and a pairing right after start take what they take with the relays down, not 10 to 12 seconds.
