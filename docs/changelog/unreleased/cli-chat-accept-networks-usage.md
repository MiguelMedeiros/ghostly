---
section: Fixed / CLI
---
- `ghostly chat accept <chat> <method> --networks` with a word that is not `mainnet` or `testnet` (or with none, an unset variable) is a usage error (exit 2) that names the flag and what it takes, before the profile opens. Before, the command opened the profile and reached the relays, then answered `bad_request` (exit 1), unlike every other flag given a word it does not take.
