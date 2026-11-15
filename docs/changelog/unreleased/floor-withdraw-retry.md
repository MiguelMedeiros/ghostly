---
section: Fixed / Chat
---
- A text you delete while it waits on the DHT floor no longer stays readable there for a few minutes when the network was down at the moment of deleting: the envelope that replaces it is tried again within seconds, not at the next keep-alive four minutes later, and with a text's backoff even when this device cannot save or seal it.
