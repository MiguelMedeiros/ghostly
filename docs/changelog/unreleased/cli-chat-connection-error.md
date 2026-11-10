---
section: Fixed / CLI
---
- `chat list` and `chat show` say why a chat's pairing is `error` in a new `connectionError` field, as the app's connection panel does: a DHT-only chat whose relays refuse its publishes reads "Could not publish DHT delivery: no relay took it (127.0.0.1:58894)". Before, it showed `pairing: "error"` beside `stage: "live"` with no reason anywhere, and the field's description listed values ("failed") the engine never gives.
