---
section: Fixed
---
- Push relay and HyperDHT relay (self-hosted): behind a proxy they were not told about, the first request that carries `X-Forwarded-For` logs `requests carry X-Forwarded-For but GHOSTLY_RELAY_PROXIES is not set: every client counts as the proxy` (the HyperDHT relay names `GHOSTLY_RELAY_CLOUDFLARE` when `CF-Connecting-IP` is there), once per start. Before, every user behind the proxy shared one address's limit (30 wake-ups a minute for all of them on the push relay) and nothing said why.
