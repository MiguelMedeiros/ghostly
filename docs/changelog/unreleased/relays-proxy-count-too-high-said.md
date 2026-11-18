---
section: Fixed / Relays
---
- A push relay or HyperDHT relay with `GHOSTLY_RELAY_PROXIES` set above the number of proxies in front of it (`2` behind
  a single nginx) now logs how many `X-Forwarded-For` entries arrive and to set it to the number of proxies that write
  the header. It said the requests arrived without `X-Forwarded-For`, though the proxy wrote it, and to leave the
  setting out, which would count every client as the proxy.
