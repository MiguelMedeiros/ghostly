# WISP 204: Ark payments via Bark

| Field | Value |
|---|---|
| Number | 204 |
| Status | Draft |
| Kind | Adapter |
| Revision | 0.1 |
| Updated | 2026-09-23 |
| Dependencies | [Payment Negotiation 200](200-payments.md), [Capabilities 03](03-capabilities.md), authenticated live data transport |
| Implementation | Experimental browser adapter, Second's Bark SDK `@secondts/bark` 0.24.0 (bark 0.7.1, WebAssembly). Testnet mode only: every Testnet profile starts a signet wallet on Second's server; Mainnet makes none yet. Regtest evidence below. |

## Scope and provider choice

Bark is [Second](https://second.tech)'s implementation of Ark: a client (bark) and a server (captaind). This adapter is a second Ark provider beside [Arkade 202](202-arkade.md), and **not interchangeable with it**. Checked on 2026-09-23 against bark 0.7.1:

- A Bark wallet cannot pay an Arkade address, nor an Arkade wallet a Bark one. The two use the same human-readable prefixes (`ark`/`tark`, bech32m) but a different address version (`tark1q…` Arkade, `tark1p…` Bark); Bark's own parser refuses an Arkade address with "address is an Arkade address and cannot be used here", and out-of-round payments only go to addresses of the wallet's own server.
- Two Bark wallets on **different** Bark servers cannot pay each other in Ark either. Crossing servers needs Lightning or on-chain, which this Draft does not offer through Bark.

So Bark is its own payment method, `bark`, with its own capability `payments-bark/1`, endpoint `btc-bark/1` and wallet. Two contacts pay each other over Bark only when both chats allow it and both apps negotiated it; an Ark request of one provider never falls back to the other.

**Distribution.** Second publishes Bark as a Rust crate (`bark-wallet`), a REST daemon (`barkd`, OpenAPI, with a generated TypeScript client), UniFFI bindings (React Native, Swift, Kotlin, Dart, Go) and a WebAssembly build for browsers (`@secondts/bark`). Ghostly's engine is TypeScript and runs in a web page, in the extension's offscreen document and in Desktop's WebView, so the WebAssembly build is the one that serves all three with one code path. The daemon would need a second process per profile and a local HTTP credential, which a web page cannot run; the Rust crate called from Tauri would reach Desktop only, leaving the web app and extension without Bark. The WebAssembly build keeps the wallet in IndexedDB, reaches the Ark server over gRPC-web (Second's servers and captaind both answer browsers, `chrome-extension://` origins included) and needs `wasm-unsafe-eval` in the page's CSP; it is loaded lazily (7.7 MB, 4.3 MB compressed), so a profile that never opens Bark never downloads it.

**Networks.** Testnet uses Second's public signet server `https://ark.signet.2nd.dev` with their Esplora `https://esplora.signet.2nd.dev` (Second asks not to swap it: it relays packages). Its faucet (`https://signet.2nd.dev`) requires a GitHub login, so a test wallet is funded by a person, not by Ghostly. Second has no Mutinynet server. A local regtest server (`e2e/support/bark-regtest`) is the other test choice. Second has run a Bitcoin server since 2026-06 (`https://ark.second.tech`), but this adapter has only been exercised on signet and regtest, so **Mainnet makes no Bark wallet** and says so; enabling it is one constant (`DEFAULT_BARK`) once it has been reviewed with real money in mind.

## Negotiation and transport binding

Both peers must negotiate `payments/1` and `payments-bark/1` inside the authenticated paired session; a chat may turn Bark off like any other way of paying, and the live `paired-payments` list carries `bark`. DHT-only carries no payment request or receipt. With `payments-bark/1` a full offer has 16 capabilities, the limit an offer parser accepted until now; the parser now accepts 32, and the live method list drops names it does not know instead of refusing the whole list, so the next method added does not cut off apps of this version.

A request carries endpoint `btc-bark/1` with a JSON target, validated as in 202:

```json
{"method":"bark","network":"signet","provider":"https://ark.signet.2nd.dev","asset":"BTC","unit":"sat","address":"<request-specific tark1p address>","expiresAt":1790000000000}
```

Networks are `bitcoin`, `signet` and `regtest` only. A `pay-ask` may name `bark`: the payee's app answers with an ordinary request. Every request uses a fresh address (index ≥ 1); the wallet page shows index 0, so money sent there never settles a request.

## Approval, execution and reconciliation

The adapter implements the shared [`PaymentAdapter`](../../packages/core/src/paymentIntent.ts) contract through the same coordinator as Cashu, Arkade and USDT. Preparation checks the target against the wallet (method, network, provider), that the address parses as a Bark address and that the SDK accepts it for this server (`validateArkoorAddress`), that the server still has the pinned key and network, and asks the SDK for the fee (`estimateArkoorPaymentFee`), which must be within the review's cap; it records the newest movement id. Nothing is signed at review.

The SDK signs and sends an out-of-round payment in one call (`sendArkoorPayment`), so there is no separate signed artefact to persist. Execution therefore re-checks target, server key, fee (not above the approved fee) and balance, persists the intent (`submitted`), and only then sends. The outcome is read from the wallet's own history: a `send` movement after the recorded id, to the reviewed address, for exactly the reviewed amount. `successful` settles; `failed`/`canceled` is a failure the server refused (nothing left); anything else is pending. An exception from the send is not proof of anything: if no such movement exists the attempt is `unknown`, and reconciliation only ever looks at the history again. It never sends a second time.

`settled` on the payer means the Bark server cosigned the out-of-round transfer; it is not a Bitcoin confirmation. The chat receipt (`btc-bark/1`, `{"txid":…}`) is a hint. The payee settles a request from **its own wallet**: a `receive` movement with status `successful`, received on the address made for that request, of at least the requested amount, created after the request, not already used for another request. The sender's VTXO ids are not the payee's (the server re-issues the VTXO to the recipient), so no identifier the sender sends is trusted. A request paid while the receipt was lost still settles on the payee's next wallet refresh.

## Keys, persistence and recovery

The wallet is a BIP-39 phrase generated by Ghostly, sealed like the other wallets (AES-GCM, PBKDF2-SHA256 600,000 iterations) with a device key stored beside it, opening without a prompt. Each mode keeps its own wallet (`barkWallet`, parked as `barkWallet-mode-<mode>`), switching parks and never replaces; a wallet with money, pending coins or payments is never replaced, and an empty one is archived (`barkWallet-retired-*`), not deleted. The server key is learnt when the wallet is created and pinned; a wallet whose server answers with another key or network does not open. A wallet opened again reports no server information until it reconnects; the adapter asks it to (`refreshServer`) and waits a few seconds, and says "not answering" rather than "key changed" when it never does.

The SDK keeps coins and history in IndexedDB (`ghostly-bark-<walletId>` and `…-onchain`). Unlike 202, the portable backup does **not** snapshot that database: its schema is the SDK's. The encrypted backup file holds the phrase, the pinned configuration and Ghostly's Bark payment journal; restore opens a new local database, where Bark's own recovery scan asks the server for the VTXOs registered to that phrase (a mailbox only the phrase can open) and rescans on-chain once. Balance recovery therefore depends on the server; in-progress unilateral exits and SDK-level history are not in the file, and every unfinished payment comes back as `unknown`.

While Ghostly is open the SDK's daemon receives payments, and every few minutes the wallet runs Bark's maintenance, which refreshes VTXOs close to expiry through a round (server fees may apply, without a per-refresh approval). On-chain coins sent to the wallet's on-chain address are moved into Ark by an explicit "Move into Ark" (a board: an on-chain transaction whose fee comes off). The balance shown is spendable sats, with pending (round, board, Lightning) and exiting amounts shown separately. There is no unilateral-exit UI, no Lightning through Bark, and no audited security claim in this Draft.

## Reproducible evidence

Source: [`bark.ts`](../../packages/browser/src/engine/paymentAdapters/bark.ts), [`barkWallet.ts`](../../packages/browser/src/engine/paymentAdapters/barkWallet.ts), [`barkSdk.ts`](../../packages/browser/src/engine/paymentAdapters/barkSdk.ts), [`payments.ts`](../../packages/browser/src/engine/payments.ts).

Checked on 2026-09-23 with worthless coins only:

- Unit tests against a fake SDK shaped on the real one: review sends nothing; the intent is written before the send; Arkade addresses, other servers' addresses, other networks and providers are refused; fee over the cap, a fee grown after review and a missing journal stop before anything leaves; a send that errors after leaving settles from the history, one that errors with nothing sent stays `unknown` and reconciling never sends again; a changed server key refuses to open; a reopened wallet waits for its server. The desk settles a request only from the payee's own history (the receipt alone settles nothing, one receive pays one request, a lost receipt still settles). Mode parking, Mainnet unavailability, no-replace/archival and the encrypted backup round trip are covered.
- Real SDK in Chromium against Second's signet server: a wallet opens in about 3 s, the address is `tark1p…`, and the SDK refuses an Arkade address. Two browser profiles in Testnet mode each open a signet wallet by themselves; turning Bark off in one chat disables it for the contact with the reason, while Arkade stays available.
- Real SDK in Chromium against local regtest (bitcoind 31.0, captaind 0.7.1 without Lightning, electrs): the funder (bark CLI) paid 20,000 sats to Alice's Bark address (movement `successful`, VTXO `8b3c05b3…:0`); 30,000 sats sent on-chain to Bob (txid `95e9beaf9acaa7d294fd90a02f1c6d8567d230895ad142a90c88251de44d0b31`) were boarded to 29,888 after the on-chain fee; Alice paid Bob 5,000 from the wallet page (Ark transaction `d5300750469177ab0cbc8f9216d66aad59c141b65798c7735376bbf7f659866f`); Bob paid Alice 2,000 by Send in the chat (her app answered his ask with a request) and she paid his 1,000 request. Final balances 16,000 (Alice) and 33,888 (Bob), both checked in each app; out-of-round payments cost no fee on that server.

```sh
npm run e2e:infra:up        # captaind and a funder on the environment's regtest chain (e2e/infra)
npm test --workspace @ghostly/browser -- test/bark.test.ts test/barkPayments.test.ts
GHOSTLY_BARK_REGTEST=1 npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-providers.spec.ts -g Bark
```

Not yet exercised: funded signet payments (the faucet needs a person's GitHub login), Mainnet, Lightning through Bark, unilateral exits, a server that disappears, the extension and Desktop with money (the same engine and build run there; only the web app was driven), and long-lived wallets across VTXO expiry.

## References

[Bark Web SDK](https://second.tech/docs/bark-sdk/wasm), [connection details](https://second.tech/docs/connection-details), [backups](https://second.tech/docs/backups), [bark repository](https://gitlab.com/ark-bitcoin/bark), [bindings](https://gitlab.com/ark-bitcoin/bark-ffi-bindings), [shared payment contract](200-payments.md), [Arkade adapter](202-arkade.md).
