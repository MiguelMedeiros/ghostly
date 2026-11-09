---
section: Fixed / Wallets
---
- Cashu: when the device clock steps forward (a time correction, a manual change, a laptop waking with its clock behind), a Lightning payment or a split whose answer from the mint was lost is no longer booked as failed within seconds, with its sats put back while the mint may still pay with them. It stays pending until the few minutes its request can still reach the mint have really passed, and a payment the mint makes then shows as paid. A clock set back no longer holds one either.
