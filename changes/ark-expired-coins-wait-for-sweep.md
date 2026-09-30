---
section: Fixed / Wallets
---
- Ark: coins that expired before they were renewed now say they are waiting for the Ark server to sweep their batch, and Recover appears only once it has. Recover used to show at once and fail ("No recoverable VTXOs found" or a failed batch, after which the server refused the coins for a while), so the wallet showed a balance it could neither spend nor recover.
- Ark: expired sats too few to recover on their own (under the Ark server's minimum coin size) are shown apart, recovered with the next coins that expire, instead of a Recover that answered "No recoverable VTXOs found".
