---
section: Fixed / CLI
---
- On the CLI's socket, `engine.call` keeps secrets back as `ghostly engine` does: a call that answers with them (`exportLinks`, `walletExport`, the wallets' backups, …) is refused without `"showSecret": true`, and `getState` gives pending invite codes, group entry links and settings' credentials as `<hidden>`. Before, a bot that logged its replies kept chat seeds, invites and the TURN credential in the clear.
