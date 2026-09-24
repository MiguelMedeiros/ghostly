# USDT via Tether WDK — experimental implementation

Ghostly integrates `@tetherto/wdk-wallet-evm` 1.0.0-beta.19 with the existing payment coordinator. This is an experimental implementation, not a production security audit or an independent protocol implementation.

## Supported configuration

- Ethereum, chain ID 1: canonical USDT contract `0xdAC17F958D2ee523a2206206994597C13D831ec7`, six decimals. Receive address, balance, request, review, local signing, submission and reconciliation are implemented. No real funds or Ethereum payment transactions were used in development validation.
- Local EVM, chain ID 31337: an explicitly configured ERC-20 fixture labelled **TEST-USDT**, with no value and not issued by Tether. Real signed transactions execute on Anvil. This validates the adapter workflow, not USDT mainnet contract behavior.
- No other networks, gas sponsorship, smart accounts, bridges or hardware signers are advertised. Ethereum gas must be paid separately in ETH; fees can exceed a small token payment.

A configurable HTTPS RPC replaces the need to run a node. The application checks the RPC chain ID, deployed contract code and decimals, and pins the observed code hash. The initial chat profile requires matching configured RPC URL, chain, token and decimals on both peers. A peer cannot redirect the sender to a different RPC. The RPC sees public addresses and is trusted for chain observations; this is not a light client. Code-hash pinning does not establish proxy-implementation immutability. Tether retains issuer controls, including freezing addresses.

## Local custody and approval

Every new profile creates a USDT wallet on Ethereum (RPC `https://ethereum.publicnode.com`, canonical contract) with no setup, so it can receive right away; sending needs ETH for gas at the same address. The seed is sealed with a random device key kept in the same local database, and the wallet reopens without a prompt: that protects it as well as the Cashu proofs beside it, not against someone who can read the profile. Wallets created earlier with a password keep asking for it. "Other network or restore" can replace the wallet only while it has no payments, tokens or gas; the old one is archived, never deleted. An exported backup is always sealed with a password chosen at export.

The wallet creates an independent BIP-39 seed, encrypted locally using the existing PBKDF2/AES-GCM vault. It does not reuse the chat identity or Ark seed. Standard BIP-39 seed bytes are passed to WDK because its mnemonic-string validation assumes Node's Buffer global; WDK performs account derivation and transaction signing. Temporary seed bytes are cleared after constructing the manager. JavaScript garbage collection prevents any promise of perfect memory erasure.

Amounts are integer token base units with exact decimal conversion. ETH gas is displayed separately from USDT and BTC balances. Requests negotiate `payments-usdt/1` in addition to `payments/1`; a peer without that capability is not offered an implicit alternate payment method. The offer parser permits at most 16 capabilities, eight transports, and a 4096-byte handshake. Older clients with an eight-capability parser may reject a larger offer; upgrade both peers to use the full set of integrations.

Preparation checks token and ETH balances and estimates gas without signing. The review binds destination, chain, contract, amount, nonce, gas limit, maximum fee and priority fee. Approval atomically claims the persisted intent, checks current balance and nonce again, signs locally, decodes the signature to verify those fields, and durably encrypts the exact signed bytes and transaction hash **before** broadcasting. An unresolved intent prevents another submission from the same wallet/chain.

After an uncertain network response, recovery looks up the existing hash. If necessary it broadcasts the exact persisted bytes again, never a newly signed payment or changed nonce. A consumed nonce with an unknown hash remains uncertain and requires investigation; automatic replacement/cancellation is not implemented. Gas spikes can leave the original transaction pending. The approved gas ceiling is encoded in the signed transaction, not merely checked against a later estimate.

Settlement requires the expected recipient/amount/token calldata, successful canonical receipt, matching Transfer event and two block confirmations. Two confirmations are not finality; deeper reorganizations are a remaining risk. A generic peer acknowledgment cannot settle a token request, and a receipt cannot settle another request. Reverted transactions report failed with gas spent. A locked recipient reconciles its saved receipt after unlocking.

## Backup and limits

Encrypted wallet backup includes configuration, independent seed and payment-intent journal. Restore only accepts a fresh profile and starts locked. Pending/uncertain restored intents require reconciliation and cannot authorize a new payment. A wallet backup does not restore chat history or all recipient-side request records. A backup made before a payment cannot recover journal entries created later.

The wallet uses safe-integer token units and gas wei, not unbounded transaction amounts. Browser/native storage, backups and provider availability remain operational dependencies. Native bundle startup and forms can be checked locally; browser financial E2E does not establish native WebView or mobile financial correctness.

## Reproduce local validation

The end-to-end environment (`e2e/infra`, see `e2e/README.md`) runs a disposable Anvil on `127.0.0.1:47070`, chain 31337, mining every second — the web app's "Local test chain" — and deploys the fixture there. The fixture setup refuses any other chain.

```sh
npm run e2e:infra:up        # Anvil, the contract deployed (e2e/support/usdt-local.mjs ready), .env.e2e written
set -a; . ./.env.e2e; set +a
npm test --workspace @ghostly/browser -- test/usdt.integration.test.ts
npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/usdt-wallet.spec.ts
```

Setup compiles the test-only `TestUSDT.sol` and deploys it as the first contract of Anvil's first account, so its address is the same on every fresh chain (`GHOSTLY_USDT_TOKEN`, `e2e/infra/env.mjs`). The contract's unrestricted mint and blocking controls are solely disposable local test fixtures. Do not deploy this fixture as a real asset.

Official references: [WDK EVM configuration](https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm/configuration/), [WDK transaction submission](https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm/guides/send-transactions/), [Tether supported protocols](https://tether.to/en/supported-protocols/).
