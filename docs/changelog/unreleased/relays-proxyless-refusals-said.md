---
section: Fixed / Relays
---
- Push relay and HyperDHT relay (self-hosted): behind a proxy that writes no `X-Forwarded-For` and with no proxy setting, the first client refused at one address's limit (the 17th browser on the HyperDHT relay, the 31st request a minute on the push relay) logs, once per start, that the refused clients come from a loopback or private address, with the header the proxy must write and `GHOSTLY_RELAY_PROXIES` (or `GHOSTLY_RELAY_CLOUDFLARE`) to set. Before, the log only said `refused address` or `refused rate`, and nothing said every user was counted as the proxy.
