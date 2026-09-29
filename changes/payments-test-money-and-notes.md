---
section: Security / Wallets
---
- A Testnet wallet pays a Bitcoin (`lnbc`) Lightning invoice only through the public test mint. A mint on this machine may have real sats behind it, so it no longer pays one as test money, and no other Testnet Lightning source does. Test-chain invoices (`lntb`, `lnbcrt`) are paid as before. The CLI declares a local test mint with a fake Lightning backend with `GHOSTLY_TEST_MINTS`.
- Creating Fedimint notes from a Mainnet federation now asks "Send real money" first, as every other spend does; the engine refuses it without that confirmation (the CLI's `--confirm-real`).
