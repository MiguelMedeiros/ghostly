---
section: Fixed / Wallets
---
- In a chat's payment sheet, a Lightning card on its own node (LND, Core Lightning, NWC, Breez) checks the amount against that node's balance. It used to check the Cashu one and say "More than the 0 test sats on this card". A card that has not read its balance yet no longer claims a number.
