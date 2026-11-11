---
section: Fixed / Relays (self-hosted)
---
- The push relay and the HyperDHT relay answer a monitor's health check the same way: `HEAD /healthz` and `/healthz` with a query string answer as `GET /healthz` on both. Before, the push relay refused a `HEAD` and logged it as a refused client, and the HyperDHT relay asked a check with a query string to connect with a WebSocket.
