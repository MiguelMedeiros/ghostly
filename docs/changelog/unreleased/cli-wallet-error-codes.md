---
section: Fixed / CLI
---
- The CLI's wallet and payment commands answer a wallet or card that is not there with `not_found` (exit 3), a token or invoice that is not one with `bad_request`, a wallet that already exists with `refused`, and no mint or source with `unavailable`, instead of `engine` ("the engine failed"). A contact that cannot be reached is `unavailable` too, and `chat pay` and `chat connect` on a chat whose invite nobody took say so at once instead of waiting 15 to 25 seconds.
