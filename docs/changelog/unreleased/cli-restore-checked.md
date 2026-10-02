---
section: Fixed / CLI
---
- `ghostly profile restore`: the restored profile's Cashu balance is what its mints still hold. The profile came back with the ecash of the day its backup was made, so what was spent afterwards stayed in the balance and payments failed with "Token already spent". The first time the restored profile starts, its wallet now asks each mint which ecash is still unspent, as the app's restore does, and a payment that was unfinished in the backup is never sent again by the copy.
- `ghostly profile restore` stopped while it runs (Ctrl-C, a kill) leaves no profile behind. Before, a half-written profile could stay under the new name, listed and usable, with a large file cut short.
