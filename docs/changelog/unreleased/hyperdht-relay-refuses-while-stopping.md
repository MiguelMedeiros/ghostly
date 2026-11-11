---
section: Fixed / Relays (self-hosted)
---
- While the HyperDHT relay stops, it refuses new connections (503, retry after a second) and its health check reads 503, so an app that reconnects at once on the relay's going-away notice goes to another instance instead of being let in and cut a second later as if the relay had crashed.
