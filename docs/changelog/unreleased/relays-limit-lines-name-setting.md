---
section: Fixed / Relays
---
- Push relay and HyperDHT relay (self-hosted): the first log line of a limit reached names the limit and the setting that moves it (`refused address: 16 clients from one address (GHOSTLY_RELAY_CLIENTS_PER_ADDRESS)`, `refused full: 512 clients (GHOSTLY_RELAY_CLIENTS)`, `dropped idle: no listen and no dial for 30 s (GHOSTLY_RELAY_IDLE_MS)`, `refused rate (30 requests a minute from one address)`); the lines after it stay short. Before, the log said a bare `refused address` or `dropped room`, and the HyperDHT relay's README listed none of these words: it now has a table of them with what to change.
