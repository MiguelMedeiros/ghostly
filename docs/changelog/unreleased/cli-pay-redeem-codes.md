---
section: Fixed / CLI
release: 1.14
---
- `pay` and `wallet redeem` refusals now say what they are with their `code`, which was `engine` (the engine failing) for each of these: a Lightning payment the mint refused is `refused` (nothing left the wallet), a mint that does not answer `pay`'s quote or `wallet faucet` is `unavailable` (try again later, as `wallet receive` already said), paying an invoice again while its first payment is pending is `refused`, and ecash from a mint that is not one of yours is `refused` with `details.reason` `mint_not_added` and the mint's URL in `details.mint`.
