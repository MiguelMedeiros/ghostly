---
section: Fixed / CLI
---
- `ghostly chat request <chat> <sats> --method arkade` (or `usdt`, `fedimint`, `spark`, `bitcoin`) to a contact with no wallet of that kind, or a Mainnet request or payment to a contact with Testnet wallets only, is now `refused` with `details.reason` `contact_no_wallet` and the `wallet create` command the contact needs, as a contact with no wallet at all already was. Before, it was `engine` ("Your contact has no Testnet Ark wallet"), which a bot reads as the engine failing and may retry.
