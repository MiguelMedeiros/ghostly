# WISP 2xx: Spark payments

| Field | Value |
|---|---|
| Number | 2xx (planned, number to be defined) |
| Status | Draft |
| Kind | Adapter |
| Revision | 0.1 |
| Updated | 2026-09-24 |
| Dependencies | [Payment Negotiation 200](200-payments.md), [Lightning 203](203-lightning.md) (the Breez source shares the wallet), authenticated live data transport |
| Implementation | Experimental browser adapter, Breez SDK Spark `@breeztech/breez-sdk-spark` 0.26.0 (WebAssembly, nodeless). Every Testnet profile opens a wallet on Breez and Lightspark's hosted regtest. Mainnet makes one only after the person enters a Breez API key. |

## Scope and SDK choice

[Spark](https://spark.money) is a Bitcoin layer 2. Its signing operators co-sign transfers of off-chain leaves: a transfer between two Spark wallets is instant, costs no on-chain fee, and needs no Lightning route. Before this draft Ghostly used Spark only through the Breez Lightning source ([203](203-lightning.md), `breez`): it paid and received BOLT11 invoices from a Spark wallet. This adapter makes Spark a way of paying of its own, `spark`. Two contacts who both have Spark pay each other Spark to Spark.

Checked on 2026-09-24:

- **SDK.** Breez SDK Spark already sends and receives on Spark natively. `receivePayment` makes a Spark address or a Spark invoice. `prepareSendPayment` of either answers with `paymentMethod.type` `sparkAddress` / `sparkInvoice` and a flat fee, and `sendPayment` takes an idempotency key. So the SDK the Breez source already loads serves the rail too: the same WebAssembly runs in the web app, the extension's offscreen document and Desktop's WebView. Spark's own SDK (`@buildonspark/spark-sdk`) was not chosen. A second SDK would keep a second copy of the same seed's leaves, and two SDKs moving one seed's leaves would race.
- **One seed.** The rail owns a wallet per profile and mode. The Breez connection is shared per seed and storage (`openBreez`): the Spark rail and a Breez Lightning source of the same seed are one SDK instance, one database and one balance. "Use for Lightning too" (Testnet) makes the Spark wallet's own phrase the Breez source.
- **Network and key.** Breez offers `mainnet` and `regtest`. Regtest is hosted by Breez and Lightspark and needs **no API key** (verified here and in 203). Mainnet needs a Breez API key (free, https://breez.technology/request-api-key/). The person enters it in the Spark panel. It is sealed with the phrase and never committed, and the panel says Mainnet moves real bitcoin. Spark's own testnet and signet are not offered by the SDK, so the payment networks are `bitcoin` and `regtest` only.
- **Tokens.** Spark carries tokens (BTKN), and the SDK takes a `tokenIdentifier`. This draft pays sats only: a token invoice is refused, and the prepared payment must carry no token. A token rail is later work (asset, decimals, review wording).

## Addresses, invoices and targets

A Spark string is bech32m. Its human-readable part names the network: `spark` (Bitcoin), `sparkrt` (regtest; `sparkt`, `sparks` and `sparkl` are Spark's other networks, not payment networks here). Its payload is protobuf. Field 1 holds the wallet's identity key (33 bytes, compressed); that alone is an **address**, the same every time (the wallet's identity). An **invoice** adds field 2, the invoice's fields (id, sats or tokens payment, memo, expiry, optional sender), and field 3, the payee's signature. `sparkAddressKind` tells the two apart, and `sparkInvoiceDetails` reads an invoice's amount, memo and expiry (the payer's SDK checks them again).

A target:

```json
{"method":"spark","network":"regtest","provider":"spark","asset":"BTC","unit":"sat","address":"<sparkrt1… invoice>","expiresAt":1790000000000}
```

`provider` is the constant `spark`. Spark's operators are the same for every wallet of a network, so any Spark wallet pays any Spark string of its network, and there is no server to name, as with on-chain. `validatePaymentTarget` accepts an address or an invoice of the target's network.

## Negotiation

`spark` is **never offered in the handshake**: a full paired offer is already at the 16 capabilities apps before 0.5 accept. Like on-chain `bitcoin`, both sides allow it only through the `paired-payments` list of the open session, and older apps drop the name. A chat may turn Spark off like any other way of paying. DHT-only and held items carry no Spark request.

A request carries endpoint `btc-spark/1` with a target whose address is a **Spark invoice made for that request**: its amount, the request's memo, and a quarter of an hour to pay. A static Spark address cannot tell one request's payment from another's, so a request never carries one: the payer's app drops a request whose target is an address, is for a token, or asks another amount than the request. A `pay-ask` may name `spark`: the payee's app answers with such a request, which the payer reviews and approves.

## Approval, execution and reconciliation

The adapter implements the shared [`PaymentAdapter`](../../packages/core/src/paymentIntent.ts) through the same coordinator as the other rails.

- **Review** (`prepare`). The target must match the wallet (method, network, provider `spark`, sats) and be a Spark string of its network. The SDK prepares the payment, which must be a Spark transfer (`sparkAddress` / `sparkInvoice`, never Lightning or on-chain) to exactly that string, for exactly the amount (an invoice's own amount, and not expired), with no token. The fee must be within the review's cap and the balance must cover amount plus fee. A fresh idempotency key (UUID) is made and journaled with the review. Nothing is signed.
- **Execution.** The target and prepared payment are re-checked. The history is looked up by the key: a retry after an interruption answers what was sent and never sends again. The payment is prepared again, and a fee above the approved one or a short balance stops it. The intent is persisted (`submitted`), and only then is `sendPayment` called with the journaled key. The SDK pays a key once and names the transfer after it. `completed` settles and `failed` is a failure (nothing left); anything else is pending.
- **Outcome.** An exception from `sendPayment` is not proof of anything: the history is asked, by the key, then by the review's recorded transfer id, then for an invoice the send that paid it. With nothing found the attempt is `unknown`, and reconciliation (after asking Spark to sync) only ever looks again. It never sends.

`settled` on the payer means Spark's operators signed the transfer; the receiver claims it. Both sides record the transfer under the same id (the payer's idempotency key). The chat receipt (`btc-spark/1`, `{"id":…}`) is a hint. The payee settles a request from **its own wallet**: a completed receive whose invoice is the one made for the request, of at least the amount asked, not already used for another request. Nothing the payer sends is trusted. A request paid while the receipt was lost still settles on the payee's next look (every wallet poll, and "I paid" asks it to look now).

## Keys, persistence and recovery

The wallet is a BIP-39 phrase generated by Ghostly (or restored), sealed like the other wallets (AES-GCM, PBKDF2-SHA256 600,000 iterations) with a device key stored beside it. The Mainnet API key is sealed the same way. Each mode keeps its own wallet (`sparkWallet`, parked as `sparkWallet-mode-<mode>`): switching parks the wallet and never replaces it. A wallet with money or payments is never replaced, and an empty one is archived (`sparkWallet-retired-*`), not deleted.

The SDK keeps leaves and history in IndexedDB under a name derived from the network and a hash of the phrase: the same name the Breez source uses, so one seed is one wallet. The encrypted backup file holds the phrase and Ghostly's Spark payment journal, but not the API key. Restoring opens the wallet from the phrase, and the SDK recovers the leaves from Spark's operators. Every unfinished payment comes back `unknown`.

Not in this draft: unilateral exit to Bitcoin (Spark's trust model allows it; there is no UI), static deposit addresses, withdrawals, Spark tokens, and an audited security claim.

## Reproducible evidence

Source: [`spark.ts`](../../packages/browser/src/engine/paymentAdapters/spark.ts), [`sparkWallet.ts`](../../packages/browser/src/engine/paymentAdapters/sparkWallet.ts), [`breezSdk.ts`](../../packages/browser/src/engine/paymentAdapters/providers/breezSdk.ts), [`payments.ts`](../../packages/browser/src/engine/payments.ts), [`sparkAddress.ts`](../../packages/core/src/sparkAddress.ts).

Checked on 2026-09-24 with worthless sats only:

- **Real SDK, from Node, on Breez's regtest.** A new wallet's address is `sparkrt1pgss…` (bech32m, 35-byte payload: `0a 21` + identity key) and is the same on every call. An invoice of 1,234 sats with memo "probe" is 143 bytes, and its amount, memo and expiry decode as described above. These real strings are the core tests' vectors.
- **Real SDK, in Chromium** (`e2e/web/spark-wallet.spec.ts`, `@network`). A Testnet profile opens a Spark wallet on regtest by itself in about 2.5 s: a `sparkrt1` address, a zero balance and a twelve-word phrase. Mainnet asks for a Breez API key and makes nothing without one.
- **Unit tests against a fake SDK** that writes real-format strings. Review sends nothing, and the intent is written before the send with the key made at review. Other networks, providers, methods, a fee over the cap, a fee grown after review, a short balance and a missing journal stop before anything leaves. A send that errors after leaving is found by its key and settles; one that never left stays `unknown`, and reconciling never sends. A pending send is found by its key, not sent twice, and settles when the history says so. An invoice payment is found by its invoice when the SDK names the transfer otherwise. The Spark wallet and the Breez Lightning source of one seed share one SDK instance. On the desk: a request carries a fresh invoice; addresses, tokens and another amount are refused; asks are answered; a receipt alone settles nothing, and one transfer pays one request; replay and "I paid" work. Mode parking, Mainnet's key, no-replace and archival, and the encrypted backup round trip are covered.

```sh
npm test --workspace @ghostly/core -- test/sparkAddress.test.ts
npm test --workspace @ghostly/browser -- test/spark.test.ts test/sparkPayments.test.ts test/sparkNode.test.ts
GHOSTLY_SPARK_REGTEST=1 GHOSTLY_SPARK_COUNTERPART="…" npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/spark-wallet.spec.ts
```

- **Two Ghostly peers paying each other Spark to Spark, in Chromium, on Breez's regtest** (`spark-wallet.spec.ts`, gated, 2026-09-25, 55 s). The funder is a regtest wallet run from Node, funded once by hand at Lightspark's faucet (50,000 sats, which asks for a reCAPTCHA). Each step ended `completed` at once with no fee:
  1. The funder paid 10,000 to Alice's Spark address (transfer `2320e409-3ac2-4b4a-b793-a512bb29dbea`).
  2. Alice sent 3,000 to Bob's address from the wallet page (`d0dfc8ee-adef-4a26-9a63-55bc610e0149`: the transfer is named after the key journaled at review).
  3. In the chat, Bob's Send asked Alice's app for a Spark invoice and paid 1,500 on it; Alice's app marked its request Paid from her own history.
  4. Bob's Request of 700 was paid by Alice, and both bubbles turned Paid.
  5. The balances read 7,800 (Alice) and 2,200 (Bob) in each app.
  6. Both sent everything back to the funder's address (`66dc16f3-…`, `e5f36140-…`), so the next run needs no faucet.
- **Real SDK behaviour found along the way.** The idempotency key becomes the transfer's id on both sides: `getPayment(key)` finds it, and the payee's receive carries the same id. An amount that is not a sum of the wallet's leaves is paid through a leaf swap with Lightspark's service provider. Two SDK instances over one seed (two local storages) disagree about the leaves, and a swap started then left a leaf out until it came back later: this is why the app opens one instance per seed (`openBreez`), and why the e2e funder keeps a single storage.

Not yet exercised: Mainnet with real money, the extension and Desktop with money (the same engine and build run there), unilateral exit, and long-lived wallets.

## References

[Breez SDK Spark: sending](https://sdk-doc-spark.breez.technology/guide/send_payment.html), [Spark addressing](https://docs.spark.money/wallets/addressing), [Spark overview](https://docs.spark.money/wallets/overview), [Lightspark regtest faucet](https://app.lightspark.com/regtest-faucet), [shared payment contract](200-payments.md), [Lightning (Breez source)](203-lightning.md).
