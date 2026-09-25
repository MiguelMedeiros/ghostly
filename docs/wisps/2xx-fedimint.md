# WISP 2xx — Fedimint ecash and Lightning through a federation

| Field | Value |
|---|---|
| Number assignment | 2xx; planned, number to be defined |
| Status | Draft |
| Kind | Adapter |
| Revision | 0.1 |
| Updated | 2026-09-25 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [Payment Negotiation 200](200-payments.md), [Lightning 203](203-lightning.md), [Profile Backups 05](05-backups.md), authenticated live data transport |
| Implementation | Experimental browser adapter on the Fedimint web SDK (`@fedimint/core` canary, pinned). Testnet mode only; regtest evidence below. |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md).

## Scope and client choice

[Fedimint](https://fedimint.org) is a federation of guardians who hold bitcoin together (a threshold of them must agree on everything) and issue blinded ecash for it. It has three modules this adapter uses: **mint** (ecash notes), **ln** (Lightning through a *gateway*, a Lightning node that swaps ecash for HTLCs) and **wallet** (on-chain peg-in and peg-out, not used here yet). Joining a federation is trusting its guardians with the sats: custodial like a Cashu mint, but no single operator can move or inflate them. Fedimint notes are **not** Cashu tokens and never stand in for them; nor is ecash of one federation worth anything to another.

Checked on 2026-09-24:

- **Client.** The Fedimint web SDK (`fedimint/fedimint-sdk`): `@fedimint/core` over the WebAssembly client `@fedimint/fedimint-client-wasm-bundler`. It is the one path that serves the web app, the extension's offscreen document and Desktop's WebView alike; the Rust client called from Tauri would leave the web app and the extension without Fedimint. The latest stable release (0.1.x, 2025-10) embeds a client older than fedimint 0.9 that cannot reach current iroh federations, so the adapter pins a **canary** build (`0.0.0-canary-eea6a3c…`, built from fedimint master after 0.12) exactly. The SDK speaks the **v1 modules only** (`mint`, `wallet`, `ln`): a federation of v2 modules is refused at preview ("no ecash module this app can use").
- **Worker.** The client runs in a dedicated worker. The SDK's own worker imports the WebAssembly as an ES module (a bundler plugin) and posts every request back as a log line, the mnemonic included; Ghostly runs its own small worker instead (`fedimintWorker.ts`), which instantiates the module the page compiled once and speaks the SDK's transport protocol unchanged, logging nothing.
- **Storage.** The client keeps its database (redb) in one file of the origin-private file system, held with an exclusive synchronous handle by its worker. The SDK binds its services to one client per database (fedimint-sdk#272), so Ghostly opens **one database per joined federation**, `ghostly-fedimint-<uuid>.db`. Nothing runs in Node (no worker, no OPFS): unit tests drive a fake client; the real one is exercised in Chromium.

## Negotiation and transport binding

The method is `fedimint`, capability `payments-fedimint/1`. Like on-chain Bitcoin it is **never offered in the handshake** (a full offer is already at the 16 capabilities apps before 0.5 accept): both sides allow it only through the `paired-payments` list of an open paired session, and a chat can turn it off like any other way of paying. DHT-only and store-and-forward carry no Fedimint request or ecash.

A request (`pay-req`) carries endpoint `fedimint-ecash/1` with the federations the payee takes ecash of, and, when the chat allows Lightning, an invoice made through one of them:

```json
{"id":"…","v":"1500","u":"sat","e":[["fedimint-ecash/1","{\"federations\":[\"8d84dfa9…72fc\"]}"],["btc-lightning-bolt11","lnbcrt15u1…"]]}
```

Federation ids are 32 bytes, lowercase hex; at most eight are read, anything else is dropped. A `pay-ask` may name `fedimint`: the payee's app answers with such a request. A payment (`pay`) carries the notes themselves under the same endpoint: out-of-band notes, a bearer string only the issuing federation redeems, once (a few kilobytes; the endpoint payload limit is 32 KiB).

The payer's app keeps a request only if it shares a federation with the payee: the target it reviews is `{"method":"fedimint","network":"<the federation's>","provider":"<federation id>","address":"<request id>",…}` on the shared federation it holds most in. **Contacts in different federations** pay the request's invoice instead, through any Lightning source, with the Lightning review of [203](203-lightning.md).

## Approval, execution and reconciliation

The adapter implements the shared [`PaymentAdapter`](../../packages/core/src/paymentIntent.ts) contract through the same coordinator as the other rails. Preparation checks the federation is joined in this mode and holds the amount; spending notes costs no fee (the payee pays the federation's fee when redeeming them). Nothing is spent at review.

Execution re-checks the balance, **persists the intent (`submitted`) and writes the payment into the chat's journal before the notes exist**, then asks the client to spend them (tagged with the review's id in the operation's meta), writes the notes into the journal, and only then sends them. The notes are the money until the contact redeems them: they stay in the journal, never reach a page, and **Take it back** asks the federation to reissue them to us, which fails once the contact redeemed them (then the payment is paid). The client also takes back, by itself, notes nobody redeemed within a week.

Reconciliation never spends again: a journaled payment with notes is sent again (the same notes); one interrupted between spending and writing the notes down is found by its meta in the client's operation log and taken back ("the sats came back"); one with no such operation spent nothing and is failed.

The payer's copy settles on the payee's `pay-res ok` (it redeemed them); a refusal (a federation it did not join, Fedimint off in the chat) takes the notes back at once and closes the review as failed. The payee:

- redeems only notes of a federation it joined in the current mode, parsed offline first (amount and federation prefix);
- writes the incoming payment, notes included, **before** redeeming, and finishes an interrupted redeem from the journal at start or on a retransmission;
- settles its request only in full (face value at least the amount) and in a federation the request named; the federation's fee on redeeming is the payee's;
- answers a retransmission of a redeemed payment with the same result and redeems nothing twice.

## Lightning through the federation

The source `fedimint` ([203](203-lightning.md), `providers/fedimint.ts`) makes a joined federation the Lightning card's source: invoices are paid into the federation as ecash (through its gateway, which funds the incoming contract with its own ecash), and invoices are paid from its ecash, the gateway routing them for its fee. The fee is estimated from the gateway's advertised fees and must be within the reviewed maximum; the client has no fee limit of its own, so a gateway that changed its fees between estimate and payment charges what it announced. A payment refused before a contract is funded is `NothingSpentError`; anything later is pending until the client's operation says paid (a preimage) or refunded. An invoice of the same federation is swapped internally, with no gateway fee.

A chat request's invoice is made by the payee's federation (not its Lightning source) and watched across restarts until paid or expired; when it is paid the request settles and the payer is told, whatever wallet paid it.

## Keys, persistence, backups and networks

- **Mnemonic.** One BIP-39 mnemonic per profile and wallet mode, generated by Ghostly, sealed with a device key like the Ark and Bark seeds (`fedimintWallet-<mode>` in the settings store), and set on every federation's database of that mode; the client derives a separate secret per federation from it. A federation is never joined fresh twice with one mnemonic (its keys would collide — seen on regtest): joining one again after leaving it, and every restore, goes through the federation's **recovery**, which rebuilds the ecash from the encrypted backup the client keeps with the guardians.
- **Per mode.** Mainnet and Testnet keep separate federations. A federation's network is read from its wallet module (or, without one, its Lightning module); one of the other mode's network is refused. **Mainnet joins nothing yet** (`FEDIMINT_MAINNET`): the adapter was exercised on regtest only, with a canary SDK; enabling it is one constant once reviewed with real money in mind.
- **Leaving.** Only a federation that holds nothing and has no payment in flight; notes handed out and not redeemed are taken back first (then it holds something again). The record is archived (`fedimintRetired-<mode>-<id>`), its database kept.
- **Backups (WISP 05).** The mnemonic record and the federations (id, invite code, configuration) live in the profile's peer database, so a profile backup carries them; the chat's journal (notes in flight) is in the same database. The client databases themselves are not in the bundle (they are files of the origin, in the SDK's format): restoring a profile gives every federation a new database name, so a copy on the same device never shares a file with the original, and the wallet, finding the file missing, joins each federation again with the mnemonic, recovering its ecash, as soon as the profile opens. The Fedimint card's own encrypted backup holds the mnemonic, the invite codes and the Fedimint payment intents; restoring it, or the phrase with the invite codes, re-joins every federation through recovery into a mode that has none yet. Payments in flight come back as unknown.

## Reproducible evidence

Source: [`fedimintWallet.ts`](../../packages/browser/src/engine/paymentAdapters/fedimintWallet.ts), [`fedimint.ts`](../../packages/browser/src/engine/paymentAdapters/fedimint.ts), [`fedimintSdk.ts`](../../packages/browser/src/engine/paymentAdapters/fedimintSdk.ts), [`fedimintWorker.ts`](../../packages/browser/src/engine/paymentAdapters/fedimintWorker.ts), [`providers/fedimint.ts`](../../packages/browser/src/engine/paymentAdapters/providers/fedimint.ts), [`payments.ts`](../../packages/browser/src/engine/payments.ts).

Checked on 2026-09-24/25 with worthless coins only:

- Unit tests against a fake client shaped on the real one (`test/helpers/fakeFedimint.ts`): preview joins nothing; invite codes, networks of the other mode, federations without ecash and Mainnet are refused; one sealed mnemonic for every federation of a mode, modes kept apart; notes out, back, and not back once redeemed; leaving takes back unredeemed notes and archives, joining again recovers; the encrypted backup restores through recovery; in a chat, the request carries federations and an invoice, the payer reviews ecash only for a shared federation, the payment is journaled before the notes exist, the payee redeems once and settles only in full in a named federation, a refusal takes the notes back, reconciliation never spends twice; the Lightning source refuses above the fee limit before anything leaves, swaps inside a federation for free and reports a payment in flight as pending.
- The real SDK in Chromium (Playwright) against e2e/infra's federation (`fedimint/fedimintd:v0.12.1`, one guardian, v1 modules; `fedimint/gatewayd:v0.12.1` on LND 0.19.3; an LND peer with a 2,000,000-sat channel to the gateway's node) on Miguel's test server "one": two browser profiles joined federation `8d84dfa9ca6fc93f5ebcede2c9c258899a4f1715b5599ffd1f069065fab272fc` after its preview (name "Ghostly regtest", 1 guardian, consensus 2.1, regtest); the LND peer paid Alice's 20,000-sat gateway invoice (19,994 sats arrived); 1,000 sats of notes went to Bob's wallet page and were redeemed there, 500 were taken back; Alice's Send of 3,000 in the chat was reviewed as Fedimint ecash (her app asked Bob's), redeemed by Bob and settled his request; with both on the Fedimint Lightning source, Bob's 2,000-sat Lightning request was paid by Alice inside the federation; Alice paid a 3,000-sat invoice of the LND peer through the gateway (fee 13 sats, settled at the peer). Final balances: Alice 10,979, Bob 5,991 (6,000 received less the federation's redeem fees).

```sh
npm run e2e:infra:up        # the federation, its gateway and the LND peer on the environment's regtest chain (e2e/infra)
npm test --workspace @ghostly/browser -- test/fedimint.test.ts
GHOSTLY_FEDIMINT_REGTEST=1 npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/fedimint-wallet.spec.ts
```

Not yet exercised: Mainnet and iroh federations (a public signet or mutinynet federation), a federation of four guardians or one losing guardians, a gateway that refunds a payment, recovery of a real profile backup, peg-in and peg-out, v2 modules, the extension's offscreen document and Desktop's WebView with money (the same engine and build run there; the OPFS lock means one tab of a profile at a time), and the SDK's canary moving under the pin.

## References

[Fedimint](https://fedimint.org), [documentation](https://docs.fedimint.org/), [web SDK](https://github.com/fedimint/fedimint-sdk) ([sdk.fedimint.org](https://sdk.fedimint.org)), [fedimint](https://github.com/fedimint/fedimint), [shared payment contract](200-payments.md), [Lightning sources](203-lightning.md), [profile backups](05-backups.md).
