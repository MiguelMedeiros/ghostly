---
section: Fixed / Wallets
---
- Cashu: when ecash of a wallet was spent somewhere else (the same profile in use on another device, or its "Copy ecash" backup redeemed in another wallet), a payment that picks it now ends with "already spent somewhere else" instead of staying at "Status unknown". The wallet then asks the mint about the rest of its ecash there, so the balance shows what the mint still holds, nothing stays set aside, and the wallet can be removed. A Lightning payment that fails this way no longer shows a fee for it.
- Cashu: a redeem that could not reach the mint is sent again as soon as the mint answers.
