---
section: Fixed / Everywhere
---
- `ghostly send` and `ghostly group send` refuse a text over 16 KiB with the code `bad_request` (and the size in `details`), before anything is sent. It used to come back as `unavailable`, which a bot reads as "try again later".
