---
section: Fixed / Wallets
---
- A Cashu wallet restored from a backup no longer counts ecash that was already spent when a Lightning payment or a paid invoice was still in progress at backup time. If the original profile finished them and spent what they brought, the restored copy now asks the mint first and drops that ecash, so the balance matches what the mint still holds and the next payment goes through.
