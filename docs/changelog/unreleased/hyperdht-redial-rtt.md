---
section: Fixed / Chat
---
- On a slow connection (a round trip of more than about 0.7 seconds), the Desktop app and the CLI no longer drop a HyperDHT connection that is only slow and dial it again. The wait for a silent HyperDHT connection now follows the connection's measured round trip, from 2 to 8 seconds: on a 3-second path a chat goes live with one dial, 2 seconds sooner. Fast paths still dial again after 2 seconds.
