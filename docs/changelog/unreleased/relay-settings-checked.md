---
section: Fixed / Self-hosting
---
- The push relay and the HyperDHT relay (`infra/services`) stop at start with one line naming a setting that is there but empty or not of its kind (`PORT=`, `GHOSTLY_RELAY_PROXIES=one`, a limit of `0` or `lots`, `GHOSTLY_RELAY_CLOUDFLARE=true`), instead of quietly using a default: an empty `PORT` listened on a random port, and a mistyped proxy count counted every user as the proxy's one address (the push relay then also listened on all addresses, not loopback). The start line now says how clients are counted and each limit set away from its default.
