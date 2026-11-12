---
section: Fixed / CLI
---
- `ghostly app verify` and `ghostly app serve` of a URL read the `ghostly-revoke.json` beside the app's sources only on the hosts the app reads from (raw.githubusercontent.com and cdn.jsdelivr.net), so an app's manifest can no longer make them call another host, a port or an address on your own network.
