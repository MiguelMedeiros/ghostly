---
section: Fixed / CLI
release: 1.14
---
- `ghostly pay --amount` and `--max-fee`, and `chat pay-request --max-fee`, take whole sats and refuse any other value as a usage error (exit 2) in the flag's words ("--amount takes a whole number of sats from 1 to …, not 1.5"), before the profile opens, as other number flags do. Before, `--amount 1.5` was asked of an address's server, and `--amount 0` or `--max-fee -1` answered `bad_request` (exit 1) naming `amount` or `maxFee`. On the socket API, `pay`'s `amount` and `maxFee` and `chat.payRequest`'s `maxFee` must be whole, and `pay` checks them before it asks the mint for a quote.
