---
section: Fixed / CLI
---
- `wallet redeem` of ecash from a mint that is not one of yours now names the token's whole mint URL in the command that adds it (`ghostly wallet add-mint <url>`), for when you trust that mint. Before, it named the mint's host only, with no way on. `wallet redeem`'s help says the same.
