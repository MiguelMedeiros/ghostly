---
section: Fixed / Wallets
---
- A Lightning payment the mint left pending no longer reads "still pending at the mint" after the mint settles it. While its result is on screen it follows the payment: it turns into "Paid." once the mint pays it, or says that the payment failed and the payee was not paid, with the sats set aside for it back in the balance (less any fee the mint kept). The paid and failed-fee rows in the Cashu history now carry the payment's melt quote.
