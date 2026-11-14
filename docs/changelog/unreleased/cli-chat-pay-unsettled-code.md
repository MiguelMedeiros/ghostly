---
section: Fixed / CLI
---
- When the mint has not answered, `ghostly chat pay` now fails with the code `unavailable` (try again later), as `wallet` commands already did. Its error code was `engine`, which reads as Ghostly itself failing.
