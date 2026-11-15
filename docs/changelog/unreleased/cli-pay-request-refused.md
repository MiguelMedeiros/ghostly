---
section: Fixed / CLI
release: 1.12
---
- `chat pay-request` answers `refused` (not `engine`) for a request already paid or with a payment of yours still on its way, and `unavailable` for one paid only through the app's review (Ark, Spark, on-chain Bitcoin, USDT), naming the way of paying and saying to pay it in the app. `payment check` answers `refused` (not `engine`) for a request no other wallet can pay. The exit code stays 1.
