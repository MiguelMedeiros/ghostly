---
section: Fixed / CLI
---
- The CLI answers the engine's known errors with the code a bot can act on: a mint, a Lightning address or the network that does not answer is `unavailable`, one too slow `timeout`, a wrong mint URL or maximum fee `bad_request`, not enough sats or spent ecash `refused`, instead of `engine` for all of them. A relay address `settings set` cannot take is `bad_request` naming its key, and a Lightning address it cannot reach no longer mentions a browser's CORS.
