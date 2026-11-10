---
section: For developers / Dependencies
---
- HyperDHT moves from 6.34.1 to 6.36.0 in every copy at once: the packages, the Desktop's sidecar and the relay for browsers, with `tools/patches/hyperdht+6.36.0.patch` renamed to match (6.36.0 does not carry our open-NAT fix yet). Upstream: an announcer prefers the lowest-RTT relays of the closest ones, retries an announce that committed to no relay, stops without waiting on unresponsive relays when suspended or closed, and keeps a handshake alive while a LAN route can still win the NAT analysis. The relay's ws moves to 8.22.1 in the same change (one fix: IPC URL paths are no longer cut at `:`).
