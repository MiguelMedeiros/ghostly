---
section: Fixed / Wallets
---
- Cashu: every exchange of ecash with a mint (receiving a payment, redeeming a token, taking a payment back, sending, paying over Lightning, an invoice being paid) is now saved before the mint is asked. If the app closes or the connection drops before the mint's answer arrives, the wallet asks the mint again, at once and the next time it opens, and finishes from there: the ecash shows up with its history line and its payment, or the sats that were set aside are free again. Sats held for a payment the mint has not confirmed show under the balance as set aside, and removing a wallet names an exchange that is still open before you confirm. A contact is told the result once the mint has answered.
