---
section: Fixed
---
- Push relay and HyperDHT relay (self-hosted): a stop or restart (SIGTERM) ends within a few seconds whatever clients do, and the log says `Ghostly … relay stopping (N clients)` then `stopped`. Before, a client holding a half-sent request kept the push relay running until it was killed, and the HyperDHT relay cut every WebSocket as a crash would; it now closes them as going away (1001) first.
