# WISP 202: Ark payments via Arkade

| Field | Value |
|---|---|
| Number | 202 |
| Status | Draft |
| Kind | Adapter |
| Revision | 0.1 |
| Updated | 2026-09-22 |
| Dependencies | [Payment Negotiation 200](200-payments.md), [Capabilities 03](03-capabilities.md), authenticated live data transport |
| Implementation | Experimental browser adapter, Arkade SDK 0.4.74; regtest evidence below. Every new profile starts with a Bitcoin mainnet wallet on `arkade.computer`. |

## Scope and provider choice

This adapter implements Ark payments using `@arkade-os/sdk` 0.4.74. Ark is the payment method; Arkade is the selected provider implementation. [Bark](204-bark.md) is a second, separate Ark provider: not a separate currency, and not compatible with this one (a Bark wallet cannot pay an Arkade address). Arkade was selected because its TypeScript wallet, transaction preparation, operator/indexer clients and browser repositories fit the existing browser engine. That choice does not establish parity across native, extension, mobile or hardware signers.

Every new profile creates a wallet on Bitcoin mainnet (`https://arkade.computer`, Esplora `https://mempool.space/api`) with no setup; `mutinynet`, `signet` and `regtest` remain available from "Other network or restore" while the current wallet is empty and has no payments (the replaced wallet is archived, never deleted). Each wallet pins an operator URL, operator signing key, network and Esplora URL. Outside regtest the SDK's background settlement is on: VTXOs are renewed before expiry and on-chain deposits to the boarding address are settled into Ark, which can cost operator/chain fees without a per-renewal approval; it only runs while Ghostly is open. On local regtest settlement stays manual because batches expire within minutes. Financial flows were exercised only on local regtest; mainnet was checked for wallet creation, address and balance, never with funds. Unilateral exits and operator loss remain release gates, not completed features.

## Negotiation and transport binding

Both peers must negotiate `payments/1` and `payments-arkade/1` inside the authenticated paired session. An older peer can retain chat and Cashu support without Ark. Legacy unauthenticated capability assumptions do not enable Ark. DHT-only carries no payment request, signed transaction, token or receipt; the existing live payment-support gate remains mandatory.

The existing payment-request envelope carries endpoint `btc-arkade/1` with a JSON target:

```json
{"method":"arkade","network":"regtest","provider":"http://127.0.0.1:43010","asset":"BTC","unit":"sat","address":"<request-specific tark address>","expiresAt":1790000000000}
```

The target binds method, network, provider, asset, unit, destination and millisecond expiry. Amount remains the envelope's positive decimal integer in sats. Unknown method/network/asset/unit, malformed URL, provider credentials/query/fragment, invalid destination or expired target are rejected. HTTPS is required except explicit localhost test services. The maximum accepted future expiry is 24 hours; generated chat requests use 15 minutes. Address server key and test-network prefix must match the configured wallet. Test-network distinction also relies on the pinned operator network; the shared test address prefix alone is insufficient.

Requests use a new HD address per request, persisted by the SDK contract repository. A prior transaction to a different request address cannot satisfy a new request. The engine validates the request ID, direction, link, amount and target before preparing a spend. The displayed payee comes from the authenticated stored peer, not caller-provided display text.

## Shared wallet contract and approval

[`PaymentAdapter`](../../packages/core/src/paymentIntent.ts) defines `prepare`, `execute` and `reconcile`; Arkade and Cashu implement this interface. [`PaymentCoordinator`](../../packages/browser/src/engine/paymentAdapters/coordinator.ts) persists a review and exact prepared operation before execution. Review contains request/link IDs where applicable, authenticated payee, method/provider/network, amount, actual fee, fee ceiling, expiry and status.

Preparation builds and signs the transaction through an SDK provider that captures the operation and refuses broadcast/finalization. It verifies destination output amount and the difference between input/output values. Approval is a separate explicit action. An IndexedDB read/write claim admits one submitted attempt per request across coordinator instances. Cancellation uses an atomic pending-only transition; it cannot overwrite a submitted attempt. Concurrent prepares may exist, but they cannot both claim the same request.

States are `pending`, `submitted`, `settled`, `failed`, `unknown`, and `cancelled`. Current ambiguous execution failures map conservatively to `unknown`; they are not proof that funds remained unspent. The UI provides “Check existing payment”, not another send. No automatic switch to Cashu, Lightning, another provider or another network occurs after approval.

## Execution and reconciliation

Submission uses the saved signed transaction and checkpoints. The response transaction ID must match. Server signatures must verify for the pinned operator on the exact reviewed spend leaves; checkpoint count/transaction identity and sighash restrictions are checked. Checkpoints are signed by the descriptor belonging to their input contract, including HD request outputs. Signed checkpoints are persisted before finalization.

`settled` on the sender means operator-accepted Ark off-chain finalization, not a Bitcoin block confirmation or proof of a completed unilateral exit. Reconciliation checks the exact transaction/output at the configured indexer first. A saved finalization may be retried for that same transaction. If the submit response was lost before checkpoints were saved, the SDK authenticates a pending-transaction lookup; a restricted provider permits finalization only for the approved transaction ID, matching checkpoints and verified operator signatures. It never prepares or submits a fresh spend. A finalized operator may reject repeated finalization, so this error alone does not reverse an independently observed receipt.

The chat payment envelope sends endpoint `btc-arkade/1` with `{"txid":"<64 lowercase hex>"}` and the original request ID. This is a hint, not financial evidence. The recipient persists a pending receipt even while its wallet is locked. Once unlocked, it checks operator/network, exact request destination, amount and transaction through its own configured indexer. It rejects cross-request/link transaction reuse. Indexer updates can lag finalization; pending receipts are checked again on wallet refresh. No chat acknowledgment can by itself mark an Ark payment settled.

## Persistence, keys and current recovery limits

Mnemonic material is local, encrypted with AES-GCM, a random 16-byte salt and 12-byte IV, and a PBKDF2-SHA256 key with 600,000 iterations. A wallet created automatically is sealed with a random device key stored beside it in the same local database, so it opens without a prompt; this protects the seed exactly as well as the Cashu proofs in that database, not against someone who can read the profile. Wallets created earlier with a password keep asking for it. Locking disposes the live SDK wallet. The engine state sent to pages excludes mnemonic and prepared transactions. Recovery phrase reveal is an explicit local UI action; an exported backup file is always sealed with a password of at least 12 characters chosen at export.

The SDK's local contract/HD repository and Ghostly's payment-intent journal retain transaction state across restart. Clearing chats does not clear the intent store. Unknown outcomes remain reserved for reconciliation. Restoring only the mnemonic is **not** a complete recovery of historical requests, pending attempts, exit data or all HD allocation history. The encrypted portable backup includes the SDK database, wallet configuration, mnemonic and Ark payment-intent journal. Restore requires a fresh profile or an unused wallet (no payments, no balance; the old one is archived), validates its format/SDK/network, reopens the wallet automatically and turns every non-terminal attempt into `unknown` so an older snapshot cannot authorize a repeated send. Password failure, no-overwrite protection, HD allocation continuity, restored balance and no-repeat authorization are covered by the regtest restore drill. Backups preserve the data already held locally; independent unilateral-exit completeness and stale-backup/device-loss scenarios remain release gates. A recovery phrase alone is not this database backup.

Operator and indexer are trust/dependency boundaries. The adapter verifies signatures and output identity but does not supply independent consensus, guaranteed liquidity, guaranteed exit availability or a privacy proof. Mainnet wallets exist by default and renew through the operator; there is no unilateral-exit UI or audited security claim in this Draft.

## Reproducible evidence

Source: [`arkade.ts`](../../packages/browser/src/engine/paymentAdapters/arkade.ts), [`arkWallet.ts`](../../packages/browser/src/engine/paymentAdapters/arkWallet.ts), [`payments.ts`](../../packages/browser/src/engine/payments.ts), [`persistence.ts`](../../packages/browser/src/engine/paymentAdapters/persistence.ts).

Checked on 2026-09-22:

- SDK 0.4.74 against official ArkLabsHQ `arkade-regtest`, arkd 0.9.16, isolated localhost ports and disposable keys/credit notes. Test funded 9,900 regtest sats, transferred 1,000 to a fresh recipient address, independently observed receipt/saldo, rejected that transaction for another fresh address, and spent 500 back from the HD receipt output. Lost finalization and submission responses are exercised without another submit; the additional 100-sat recovery transfer leaves 400 sats, which the encrypted backup restores into a fresh locked wallet. No production funds used.
- Coordinator/persistence tests cover no spend on preparation/cancellation, duplicate approval, distinct intents for one request, cancel-vs-submit races, persistence failure, timeout/restart reconciliation, expiry, unit/fee checks, wrong password and modified ciphertext.
- Paired-session tests cover Ark capability intersection with supporting and older peers while retaining ordinary payment/chat support.
- The Cashu adapter uses the same coordinator; an independent test-mint wallet redeemed 32 worthless sats, then a deliberately lost swap response was recovered through NUT-09 without a second swap and 16 sats were redeemed. This establishes the second implementation path, not cross-rail conversion.

Run targeted tests from the repository root:

```sh
npm test --workspace @ghostly/browser -- test/paymentCoordinator.test.ts test/paymentPersistence.test.ts
npm test --workspace @ghostly/core -- test/pairedSession.test.ts test/pairedLink.test.ts
GHOSTLY_CASHU_TEST=1 npm test --workspace @ghostly/browser -- test/cashuAdapter.integration.test.ts
NODE_OPTIONS=--experimental-eventsource GHOSTLY_ARK_REGTEST=1 npm test --workspace @ghostly/browser -- test/arkade.regtest.test.ts
```

The Ark integration test runs against arkd in the end-to-end environment (`npm run e2e:infra:up`: operator `127.0.0.1:47010`, Esplora `127.0.0.1:47002`, the web app's Regtest option); it is opt-in and does not start or stop infrastructure. The opt-in `e2e/web/ark-wallet.spec.ts` also passed against the production web build: two isolated Chromium peers create/restore test wallets through the UI, exchange an authenticated Ark request, review without spending, approve explicitly, and reconcile the receipt after the recipient unlocks its wallet. The recipient balance is 1,000 sats and both chat cards confirm settlement. The macOS debug `.app` builds and opens the wallet integrations; native financial transactions have not been exercised. Signet/mutinynet, physical device-loss migration, unilateral exits and payment behavior on native/mobile platforms remain separate verification gates. None of the above establishes independent WISP conformance.

## References

[Arkade TypeScript SDK](https://arkade-os.github.io/ts-sdk/), [official local regtest](https://github.com/ArkLabsHQ/arkade-regtest), [Arkade security model](https://docs.arkadeos.com/learn/core-concepts/security-and-trust-model), [Bark alternative](https://second.tech/docs/bark-sdk/index.md), [shared payment contract](200-payments.md), [Cashu adapter](201-cashu.md).
