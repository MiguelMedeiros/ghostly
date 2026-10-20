---
section: Fixed / CLI
---
- `GHOSTLY_DHT`, `GHOSTLY_STUN`, `GHOSTLY_WEBRTC` and `GHOSTLY_HUB` now accept `false`, `off` and `no` (any case, spaces trimmed) as well as `0`. Any other value stops the command with a usage error that names the variable. Before, only the exact value `0` turned them off. `GHOSTLY_DHT=false` silently kept the profile on the public DHT, and `GHOSTLY_STUN=off` kept using Google's STUN servers.
