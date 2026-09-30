---
section: Fixed / Wallets
---
- A Lightning payment from the Cashu wallet that fails after the wallet split its ecash (a mint refusing it, "Invoice already paid") now shows the fee the mint kept for that split in the wallet's history, and the error says it: "The sats are back in your wallet, less 1 sat the mint kept as its fee." It used to vanish from the balance with no line anywhere.
