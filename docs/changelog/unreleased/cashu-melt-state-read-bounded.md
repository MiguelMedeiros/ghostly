---
section: Fixed / Wallets
---
- When you pay a Lightning invoice from Cashu and the mint gives the quote but never answers where the payment stands, your other payments at that mint (chat payments, ecash a contact sends you, other Lightning payments) are no longer stuck waiting for 5 minutes. The same holds at every start, and every few minutes after, while a Lightning payment stays pending there. The wallet gives up on that question after 30 seconds, says the mint did not answer, and asks again later.
