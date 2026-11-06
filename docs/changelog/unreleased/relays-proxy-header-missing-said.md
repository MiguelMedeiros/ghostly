---
section: Fixed / Relays
---
- Push relay and HyperDHT relay (self-hosted): set up behind a proxy (`GHOSTLY_RELAY_PROXIES`, or `GHOSTLY_RELAY_CLOUDFLARE` for the HyperDHT relay) whose requests come without that header, the first one logs `requests arrive without X-Forwarded-For though GHOSTLY_RELAY_PROXIES is set`, once per start. Before, every user behind such a proxy (nginx without `proxy_set_header X-Forwarded-For`, a plain pass-through) counted as the proxy: 16 browsers at most on the HyperDHT relay and 30 wake-ups a minute for all of them on the push relay, and the log only said `refused address` or `refused rate`.
