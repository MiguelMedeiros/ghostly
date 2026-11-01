---
section: Fixed
---
- HyperDHT relay (self-hosted): `/healthz` answers 503 (`ok: false`) while the relay's HyperDHT node reaches no other node, as with no outgoing UDP behind a tunnel or a firewall, and reports the node's routing table size, `firewalled` and how long ago another node answered. The start log says `bootstrap reached no node` then. Before, it always answered healthy.
