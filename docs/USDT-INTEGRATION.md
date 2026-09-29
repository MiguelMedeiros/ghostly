# USDT via Tether WDK: experimental implementation

Ghostly integrates `@tetherto/wdk-wallet-evm` 1.0.0-beta.19 with the existing payment coordinator. This is an experimental implementation, not a production security audit or an independent protocol implementation.

## Supported configuration

- Ethereum, chain ID 1: canonical USDT contract `0xdAC17F958D2ee523a2206206994597C13D831ec7`, six decimals. Receive address, balance, request, review, local signing, submission and reconciliation are implemented. No real funds or Ethereum payment transactions were used in development validation.
- Sepolia, chain ID 11155111 (the Testnet default): Aave's test USDT `0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0`, six decimals, labelled **TEST-USDT**: worthless and not issued by Tether. **Get test coins** mints some from Aave's public faucet; the wallet needs a little Sepolia ETH for that gas first.
- Local EVM, chain ID 31337: an explicitly configured ERC-20 fixture labelled **TEST-USDT**, with no value and not issued by Tether. Real signed transactions execute on Anvil. This validates the adapter workflow, not USDT mainnet contract behavior.
- No other networks, gas sponsorship, smart accounts, bridges or hardware signers are advertised. Ethereum gas must be paid separately in ETH; fees can exceed a small token payment.

A configurable HTTPS RPC replaces the need to run a node. The application checks the RPC chain ID, deployed contract code and decimals, and pins the observed code hash. A request's target carries the chain's public RPC (`USDT_PUBLIC_RPC`: `ethereum.publicnode.com`, `ethereum-sepolia-rpc.publicnode.com`), or a local chain's origin, never the wallet's own RPC URL. Both peers must match chain, token and decimals; the payer always uses its own RPC, so a peer cannot redirect it to another one. A chat that has USDT of that network off on its Accept side drops the request. The RPC sees public addresses and is trusted for chain observations; this is not a light client. Code-hash pinning does not establish proxy-implementation immutability. Tether retains issuer controls, including freezing addresses.

## Local custody and approval

New (or "Create your first wallet") makes a USDT wallet per network in one click: Mainnet on Ethereum (RPC `https://ethereum.publicnode.com`, canonical contract), Testnet on Sepolia. A new profile gets the Mainnet one by itself on first run, beside Mainnet Cashu (WISP 200, Wallet networks), so the app reaches that RPC on first start. It can receive right away; sending needs ETH for gas at the same address. Every Mainnet spend needs the "Send real money" confirmation (`confirmedReal`). The seed is sealed with a random device key kept in the same local database, and the wallet reopens without a prompt: that protects it as well as the Cashu proofs beside it, not against someone who can read the profile. Wallets created earlier with a password keep asking for it. A Testnet wallet can switch between Sepolia and the local test chain only while it has no payments, tokens or gas; the old one is archived, never deleted. An exported backup is always sealed with a password chosen at export.

The wallet creates an independent BIP-39 seed, encrypted locally using the existing PBKDF2/AES-GCM vault. It does not reuse the chat identity or Ark seed. Standard BIP-39 seed bytes are passed to WDK because its mnemonic-string validation assumes Node's Buffer global; WDK performs account derivation and transaction signing. Temporary seed bytes are cleared after constructing the manager. JavaScript garbage collection prevents any promise of perfect memory erasure.

Amounts are integer token base units with exact decimal conversion. ETH gas is displayed separately from USDT and BTC balances. Requests negotiate `payments-usdt/1` in addition to `payments/1`; a peer without that capability is not offered an implicit alternate payment method. The offer parser permits at most 32 capabilities (apps before 0.5 accept 16), eight transports, and a 4096-byte handshake; newer ways of paying go in the live `paired-payments` list instead of the offer.

Preparation checks token and ETH balances and estimates gas without signing. The review binds destination, chain, contract, amount, nonce, gas limit, maximum fee and priority fee. Approval atomically claims the persisted intent, checks current balance and nonce again, signs locally, decodes the signature to verify those fields, and durably encrypts the exact signed bytes and transaction hash **before** broadcasting. An unresolved intent prevents another submission from the same wallet/chain.

After an uncertain network response, recovery looks up the existing hash. If necessary it broadcasts the exact persisted bytes again, never a newly signed payment or changed nonce. A consumed nonce with an unknown hash remains uncertain and requires investigation; automatic replacement/cancellation is not implemented. Gas spikes can leave the original transaction pending. The approved gas ceiling is encoded in the signed transaction, not merely checked against a later estimate.

Settlement requires the expected recipient/amount/token calldata, successful canonical receipt, matching Transfer event and two block confirmations. Two confirmations are not finality; deeper reorganizations are a remaining risk. A generic peer acknowledgment cannot settle a token request, and a receipt cannot settle another request. Reverted transactions report failed with gas spent. A locked recipient reconciles its saved receipt after unlocking.

## Backup and limits

Encrypted wallet backup includes configuration, independent seed and payment-intent journal. Restore goes into a network with no USDT wallet or an unused one (no payments, tokens or gas; it is archived), and the backup must be of that network. Pending/uncertain restored intents require reconciliation and cannot authorize a new payment. A wallet backup does not restore chat history or all recipient-side request records. A backup made before a payment cannot recover journal entries created later.

The wallet uses safe-integer token units and gas wei, not unbounded transaction amounts. Browser/native storage, backups and provider availability remain operational dependencies. Native bundle startup and forms can be checked locally; browser financial E2E does not establish native WebView or mobile financial correctness.

## Reproduce local validation

The end-to-end environment (`e2e/infra`, see `e2e/README.md`) runs a disposable Anvil on `127.0.0.1:47070`, chain 31337, mining every second (the Testnet wallet's "Local test chain"), and deploys the fixture there. The fixture setup refuses any other chain.

```sh
npm run e2e:infra:up        # Anvil, the contract deployed (e2e/support/usdt-local.mjs ready), .env.e2e written
set -a; . ./.env.e2e; set +a
npm test --workspace @ghostly/browser -- test/usdt.integration.test.ts
npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/usdt-wallet.spec.ts
```

Setup compiles the test-only `TestUSDT.sol` and deploys it as the first contract of Anvil's first account, so its address is the same on every fresh chain (`GHOSTLY_USDT_TOKEN`, `e2e/infra/env.mjs`). The contract's unrestricted mint and blocking controls are solely disposable local test fixtures. Do not deploy this fixture as a real asset.

Official references: [WDK EVM configuration](https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm/configuration/), [WDK transaction submission](https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm/guides/send-transactions/), [Tether supported protocols](https://tether.to/en/supported-protocols/).
