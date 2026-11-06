---
section: Fixed / Wallets
---
- Cashu ecash received right after its mint changed its signing keys is redeemed on the new keys at once. Before, a contact's payment or a pasted token was refused the first time with a technical English line ("Mint rejected a stale keyset..."), and the contact had to take it back and pay again.
- A Cashu redeem still waiting on the mint when the app closed is sent again at the next start for as long as the ecash is unspent, also after the mint changed its keys meanwhile. Before, it could be dropped: the contact was told the mint did not confirm the ecash, and a pasted token the wallet had promised to add was lost from the wallet without a word.
