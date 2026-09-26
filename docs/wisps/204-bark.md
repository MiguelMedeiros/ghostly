# WISP 204: Ark payments via Bark

| Field | Value |
|---|---|
| Number | 204 |
| Status | Draft |
| Kind | Adapter |
| Revision | 0.2 |
| Updated | 2026-09-26 |
| Dependencies | [Payment Negotiation 200](200-payments.md), [Capabilities 03](03-capabilities.md), authenticated live data transport |
| Implementation | Experimental browser adapter, Second's Bark SDK `@secondts/bark` 0.25.0 (bark 0.7.1, WebAssembly). New makes a Mainnet wallet on Second's Bitcoin server and a Testnet one on their signet server, each in one click. Regtest evidence below; no Ghostly test has moved real money. |

## Scope and provider choice

Bark is [Second](https://second.tech)'s implementation of Ark: a client (bark) and a server (captaind). This adapter is a second Ark provider beside [Arkade 202](202-arkade.md), and **not interchangeable with it**. Checked on 2026-09-23 against bark 0.7.1:

- A Bark wallet cannot pay an Arkade address, nor an Arkade wallet a Bark one. The two use the same human-readable prefixes (`ark`/`tark`, bech32m) but a different address version (`tark1q…` Arkade, `tark1p…` Bark); Bark's own parser refuses an Arkade address with "address is an Arkade address and cannot be used here", and out-of-round payments only go to addresses of the wallet's own server.
- Two Bark wallets on **different** Bark servers cannot pay each other in Ark either. Crossing servers needs Lightning or on-chain, which this Draft does not offer through Bark.

So Bark is its own payment method, `bark`, with its own capability `payments-bark/1`, endpoint `btc-bark/1` and wallet. Two contacts pay each other over Bark only when both chats allow it and both apps negotiated it; an Ark request of one provider never falls back to the other.

**Distribution.** Second publishes Bark as a Rust crate (`bark-wallet`), a REST daemon (`barkd`, OpenAPI, with a generated TypeScript client), UniFFI bindings (React Native, Swift, Kotlin, Dart, Go) and a WebAssembly build for browsers (`@secondts/bark`). Ghostly's engine is TypeScript and runs in a web page, in the extension's offscreen document and in Desktop's WebView, so the WebAssembly build is the one that serves all three with one code path. The daemon would need a second process per profile and a local HTTP credential, which a web page cannot run; the Rust crate called from Tauri would reach Desktop only, leaving the web app and extension without Bark. The WebAssembly build keeps the wallet in IndexedDB, reaches the Ark server over gRPC-web (Second's servers and captaind both answer browsers, `chrome-extension://` origins included) and needs `wasm-unsafe-eval` in the page's CSP; it is loaded lazily (7.7 MB, 4.3 MB compressed), so a profile that never opens Bark never downloads it.

**Networks.** Mainnet uses Second's Bitcoin server `https://ark.second.tech` with their Esplora `https://mempool.second.tech/api`; Testnet uses their signet server `https://ark.signet.2nd.dev` with `https://esplora.signet.2nd.dev` ([connection details](https://second.tech/docs/connection-details); Second asks not to swap the Esplora: it relays packages). The signet faucet (`https://signet.2nd.dev`) requires a GitHub login, so a test wallet is funded by a person, not by Ghostly. Second has no Mutinynet server. A local regtest server (`e2e/support/bark-regtest`) is the other test choice.

## Mainnet

Second opened its Bitcoin server to anyone on 2026-06-09 ([announcement](https://second.tech/blog/bark-now-on-bitcoin-mainnet/), [Bitcoin Magazine](https://bitcoinmagazine.com/news/second-launches-bark-on-bitcoin-mainnet), [changelog](https://second.tech/docs/changelog): bark 0.2.3 that day). No account is needed. Second's own guide says to start small and not to store more than one is willing to lose.

**SDK.** Any `@secondts/bark` built on bark 0.6.0 or newer (npm 0.15.0+) speaks the current protocol; Ghostly pins **0.25.0** (2026-09-24, bark 0.7.1, the same core as 0.24.0). It is the first build whose SDK refuses an address of another network (before, a wrong-network address could still build a valid output), which matters with real money. The bindings changes of 0.25.0 (`mailboxAuthorization(expirySecs)`, an optional `LightningReceive.amountSats`, `drainAll` on exits) touch nothing Ghostly calls, and the WebAssembly still loads as in #77.

**What the server says about itself.** Read once, read-only, with `GetArkInfo` over gRPC-web on 2026-09-26 (decoded with bark 0.7.1's `bark_server.proto`):

| Parameter | Mainnet (`ark.second.tech`) | Signet |
|---|---|---|
| Network, server key | `bitcoin`, `0375b2e4…0b97b5` | `signet`, `03244a5a…f85aed` |
| Round interval | 3600 s | 300 s |
| Coin (VTXO) lifetime | 4032 blocks, about 28 days | 144 blocks |
| Exit delay | 144 blocks | 12 blocks |
| Largest coin | 10,000,000 sats (0.1 BTC) | 100,000,000 sats |
| Smallest board | 50,000 sats, 2 confirmations | 10,000 sats, 1 confirmation |
| Terms (`tos_link`) | `https://second.tech/terms` | none |

**Fees** ([pricing](https://second.tech/pricing), the same table the server sends): an Ark payment (out of round, what Ghostly sends) and a Lightning receive cost nothing; a board costs its on-chain fee; a refresh is free within 288 blocks (2 days) of expiry, then 0.2 %, 0.4 % and 0.5 % from 288, 1008 and 2016 blocks; Lightning sends and offboards take 0.2 to 0.5 % by the same tiers (Lightning at least 20 sats, offboards plus the on-chain fee). A server may also cap a round's amount without telling the client, so a balance over that cap cannot be refreshed in one go.

**Terms** ([second.tech/terms](https://second.tech/terms), revised 2026-08-10) bind End Users and the Developers whose app connects (§1.2), re-affirmed on every connection (§1.3). What matters here: an expired coin may be swept by Second with no duty to return it (§1.6); fees may change for future operations (§1.7); sanctioned territories are excluded (§1.9); an app may not imply Second provides or endorses it (§1.12, §2.2(f)); no unreasonable load (§2.2(c)); the service may change or stop without notice (§2.3, §7). Ghostly names the terms where a Mainnet wallet is made and on its page, and names Second only as the server's operator.

**Coins expire; renewing them is the owner's job.** A coin lives 4032 blocks from the round or board that made it (a coin received out of round keeps its sender's expiry). The server can sweep it after that, so it must be refreshed through a round before. Bark refreshes on Bitcoin from 144 blocks before expiry by default; Ghostly sets 264 (`MAINNET_REFRESH_THRESHOLD`), still inside the free 288-block window, so a refresh costs nothing and the app has about two days, not one, to be open when it is due. Nothing renews a coin while Ghostly is closed: the wallet page says how long coins last and when the next one expires (`getFirstExpiringVtxoBlockheight` against the chain tip), in yellow when it is under three days.

**If the server disappears.** Every coin made by a board or a round can leave unilaterally: the wallet broadcasts its pre-signed transactions root to leaf, then claims after the 144-block exit delay, paying several on-chain fees (more than a small coin is worth). It has to happen before expiry and needs this device's wallet database, not only the phrase: a restore from the phrase alone asks the server for the coins. A coin received out of round can be blocked from exiting by its sender colluding with the server until it is refreshed ([exit](https://second.tech/docs/learn/exit.md), [lifetime](https://second.tech/docs/learn/lifetime.md)). Ghostly has **no exit button yet**; the wallet page says so, and says to keep amounts small.

**What Mainnet shares with the other rails.** A Mainnet Bark wallet is its own instance (`bark:mainnet`, key `barkWallet-mode-mainnet`) beside the Testnet one, made by New in one click under the same rule as the others: the SDK opens a fresh wallet and the server must answer with network `Bitcoin` and a key, which is pinned; a server on another network, or none, saves nothing and leaves no database. The adapter refuses a target of another network or provider and any address whose prefix is not the network's (`ark1` on Bitcoin, `tark1` on the test networks), before the SDK's own check. Every spend needs the engine's `confirmedReal` (the "Real money" review), removal counts its balance, pending coins, unfinished payments and open requests, and New offers the recovery phrase and the encrypted backup before the card is dealt.

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

The wallet is a BIP-39 phrase generated by Ghostly, sealed like the other wallets (AES-GCM, PBKDF2-SHA256 600,000 iterations) with a device key stored beside it, opening without a prompt. Each network has its own wallet (`barkWallet-mode-<network>`, see [200](200-payments.md)), opened side by side; a wallet with money, pending coins or payments is never replaced, and an empty one is archived (`barkWallet-retired-*`), not deleted. The server key is learnt when the wallet is created and pinned; a wallet whose server answers with another key or network does not open. A wallet opened again reports no server information until it reconnects; the adapter asks it to (`refreshServer`) and waits a few seconds, and says "not answering" rather than "key changed" when it never does.

The SDK keeps coins and history in IndexedDB (`ghostly-bark-<walletId>` and `…-onchain`). Unlike 202, the portable backup does **not** snapshot that database: its schema is the SDK's. The encrypted backup file holds the phrase, the pinned configuration and Ghostly's Bark payment journal; restore opens a new local database, where Bark's own recovery scan asks the server for the VTXOs registered to that phrase (a mailbox only the phrase can open) and rescans on-chain once. Balance recovery therefore depends on the server; in-progress unilateral exits and SDK-level history are not in the file, and every unfinished payment comes back as `unknown`.

While Ghostly is open the SDK's daemon receives payments, and every few minutes the wallet runs Bark's maintenance, which refreshes VTXOs close to expiry through a round (server fees may apply, without a per-refresh approval). On-chain coins sent to the wallet's on-chain address are moved into Ark by an explicit "Move into Ark" (a board: an on-chain transaction whose fee comes off). The balance shown is spendable sats, with pending (round, board, Lightning) and exiting amounts shown separately. There is no unilateral-exit UI, no Lightning through Bark, and no audited security claim in this Draft.

## Reproducible evidence

Source: [`bark.ts`](../../packages/browser/src/engine/paymentAdapters/bark.ts), [`barkWallet.ts`](../../packages/browser/src/engine/paymentAdapters/barkWallet.ts), [`barkSdk.ts`](../../packages/browser/src/engine/paymentAdapters/barkSdk.ts), [`payments.ts`](../../packages/browser/src/engine/payments.ts).

Checked on 2026-09-23 with worthless coins only:

- Mainnet, 2026-09-26, against a mocked Bitcoin server (unit tests, `barkMainnet.test.ts` and `bark.test.ts`): one-click creation pins the server key and shows the terms and coin expiry; a server that does not answer, or answers as signet, saves nothing; the Testnet wallet refuses a Bitcoin server and the Mainnet one a signet server or backup; a Mainnet wallet refuses `tark1` addresses and a test wallet `ark1` ones; a Mainnet payment is refused without `confirmedReal` and sent once with it; a funded wallet is not removed without accepting the loss, nor at all with a payment unfinished. In Chromium (e2e), a Mainnet Bark wallet whose server does not answer leaves no card, and one whose server answers as signet is refused, with Second's Bitcoin server never reached. The real server was read once, read-only (the table above); no automated test reaches it.
- Unit tests against a fake SDK shaped on the real one: review sends nothing; the intent is written before the send; Arkade addresses, other servers' addresses, other networks and providers are refused; fee over the cap, a fee grown after review and a missing journal stop before anything leaves; a send that errors after leaving settles from the history, one that errors with nothing sent stays `unknown` and reconciling never sends again; a changed server key refuses to open; a reopened wallet waits for its server. The desk settles a request only from the payee's own history (the receipt alone settles nothing, one receive pays one request, a lost receipt still settles). Mode parking, Mainnet unavailability, no-replace/archival and the encrypted backup round trip are covered.
- Real SDK in Chromium against Second's signet server: a wallet opens in about 3 s, the address is `tark1p…`, and the SDK refuses an Arkade address. Two browser profiles, each with a Testnet Bark wallet, each open a signet wallet by themselves; turning Bark off in one chat disables it for the contact with the reason, while Arkade stays available.
- Real SDK in Chromium against local regtest (bitcoind 31.0, captaind 0.7.1 without Lightning, electrs): the funder (bark CLI) paid 20,000 sats to Alice's Bark address (movement `successful`, VTXO `8b3c05b3…:0`); 30,000 sats sent on-chain to Bob (txid `95e9beaf9acaa7d294fd90a02f1c6d8567d230895ad142a90c88251de44d0b31`) were boarded to 29,888 after the on-chain fee; Alice paid Bob 5,000 from the wallet page (Ark transaction `d5300750469177ab0cbc8f9216d66aad59c141b65798c7735376bbf7f659866f`); Bob paid Alice 2,000 by Send in the chat (her app answered his ask with a request) and she paid his 1,000 request. Final balances 16,000 (Alice) and 33,888 (Bob), both checked in each app; out-of-round payments cost no fee on that server.

```sh
npm run e2e:infra:up        # captaind and a funder on the environment's regtest chain (e2e/infra)
npm test --workspace @ghostly/browser -- test/bark.test.ts test/barkPayments.test.ts
GHOSTLY_BARK_REGTEST=1 npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-providers.spec.ts -g Bark
```

Not yet exercised: funded signet payments (the faucet needs a person's GitHub login), a Mainnet payment with real money (the maintainer's check after merge), Lightning through Bark, unilateral exits, a server that disappears, the extension and Desktop with money (the same engine and build run there; only the web app was driven), and long-lived wallets across VTXO expiry.

## References

[Bark Web SDK](https://second.tech/docs/bark-sdk/wasm), [connection details](https://second.tech/docs/connection-details), [pricing](https://second.tech/pricing), [terms](https://second.tech/terms), [coin lifetime](https://second.tech/docs/learn/lifetime.md), [unilateral exit](https://second.tech/docs/learn/exit.md), [backups](https://second.tech/docs/backups), [bark repository](https://gitlab.com/ark-bitcoin/bark), [bindings](https://gitlab.com/ark-bitcoin/bark-ffi-bindings), [shared payment contract](200-payments.md), [Arkade adapter](202-arkade.md).
