# WISP 201: Cashu

| Field | Value |
|---|---|
| Candidate number | 201; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [200](200-payments.md) |
| Implementation | Cashu wallet per network (Mainnet and Testnet); shared reviewed-payment coordinator |
| Summary | Send and receive ecash tokens in the conversation; a mint you choose holds the funds. |
| Availability | Available |
| Feature | [Wallets](https://ghostly.tools/#wallets) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Existing integration

Ghostly currently uses Cashu tokens and mint-backed wallet operations. Requests advertise accepted mints; an in-band payment carries a token; the recipient attempts redemption and returns a result. The application keeps pending operations and recovery state. This functionality belongs to the application/payment component, not Core rendezvous.

## Networks (2026-09-26)

- **Per network.** New makes a Cashu wallet on Mainnet (a few public mints, only those that answer) or Testnet (the public test mint `testnut.cashu.space`). Test mints and mints on this machine are Testnet; every other mint is Mainnet ([200](200-payments.md#wallet-networks-mainnet-and-testnet)).
- **Ecash is pinned to the request's network.** A payment spends only mints of the request's network, even when the request lists a mint of the other one first; a request's mints of the other network are dropped.
- **Testnet never funds itself.** A test mint marks its own invoices paid, so such a quote is held: it is minted only when a payer says it paid that invoice, or with **Get test coins** (a small fixed amount, on the person's click).
- **Removal.** Removing a Cashu wallet first claims paid quotes, counts open and unclaimed quotes and ecash not yet taken, and closes the chat requests only it could be paid through (`pay-res` with `c: true`).

## Candidate adapter

Follow the selected [Cashu NUTs](https://github.com/cashubtc/nuts), pin their supported versions and delegate token validation/redemption to an appropriate component. Accept only explicitly allowed mints and supported units. Tokens are bearer secrets: possession before redemption can enable spending, and senders may still spend an unredeemed token. Do not log or broadcast tokens.

Deduplicate IDs and persist settlement/recovery state before retry. If redemption is refused, report a reason without exposing secrets. If its outcome is uncertain, reconcile with the component/mint before retrying or switching to Lightning. Redemption success precedes a successful settlement receipt.

## Compatibility, security and open decisions

Preserve the current `cashu` endpoint while specifying exact supported token encodings and NUT requirements before Proposed. Mint custody/availability and wallet recovery remain explicit tradeoffs. Existing wallet secrets are random; a universal seed-based recovery mechanism is not implemented. This WISP does not require building a new wallet or promise risk-free ecash.

## Conformance

Accepted/untrusted mint, unsupported asset, duplicate token/payment, already-spent token, timeout during redemption, crash recovery and lost receipt. Use dedicated test funds/test fixtures; document component versions and settlement evidence.

## References

[Wallet implementation](../../packages/browser/src/engine/wallet.ts), [payment coordination](../../packages/browser/src/engine/payments.ts), [payment negotiation](200-payments.md).


## Shared reviewed-payment implementation (2026-09-22)

The browser app also implements Cashu through the shared [payment intent coordinator](../../packages/browser/src/engine/paymentAdapters/coordinator.ts), alongside [Arkade 202](202-arkade.md). The current chat UI selects a mint, prepares an exact swap and fee, persists the preview and requires explicit approval. It reserves inputs before the mint call and stores the outgoing token with the proof replacement. A lost response is reconciled using NUT-09 for the exact saved outputs; recovery does not generate another swap or switch to Lightning. A peer receipt triggers verification, but the mint must report redemption before the reviewed payment is marked settled.

The opt-in [test-mint integration test](../../packages/browser/test/cashuAdapter.integration.test.ts) exercised 32 worthless sats redeemed by a second SDK wallet, and a deliberately lost swap response followed by NUT-09 recovery and redemption of 16 sats without another swap. Mint support for restore is a dependency: failure retains an unknown outcome and reserved inputs. Older application payment paths remain documented above; this does not claim universal NUT support or independent WISP conformance.

The reviewed fee includes both the mint swap fee and the prepaid recipient redemption fee, derived from prepared input value minus change minus the requested amount. The SDK 4.x `preview.fees` field alone omits the recipient top-up. Integration tests assert exact balance reduction and reject a fee cap below the full cost before spending.

## Every swap is written down first (2026-10-02)

The same rule now holds for every request that asks a mint to sign new outputs, not only the reviewed payment: redeeming a token (a contact's payment, a pasted token, ecash taken back), splitting ecash for a token or for a Lightning payment, and minting the ecash of a paid invoice. The wallet stores the request's inputs and blinded outputs with their secrets before it asks the mint, and sends what it stored, so a second try asks for the same outputs. A redeem is stored with the history line and the payment record that go in with its ecash; a split reserves its inputs in the same transaction. Coins that add up exactly are sent as they are, with no mint and nothing to store.

When the answer does not arrive, the wallet asks the mint for its signatures on those exact outputs (NUT-09) and for the state of the inputs (NUT-07), at once and again at every start until it knows. Only an answer counts: a mint that cannot be reached, answers with an error or answers for some of the outputs is asked again. Signed: the result is stored as the answer would have been, in one transaction that reads the stored swap first, so it is stored once. Answered as not signed, with an input spent: something else spent it, that proof is dropped and the swap ends. Not signed and the inputs unspent: the inputs are free again at once when the mint refused the first request, and otherwise once no request can still reach the mint (a request's longest life of five minutes, and two minutes more). A swap that gave its inputs back this way stays stored for an hour and is still asked about, so a request that reached the mint late is recovered too. A split finished after its payment was given up returns everything it made to the wallet, and the mint's fee shows in the history. A contact whose ecash is being redeemed is answered only once the mint has spoken, and a swap kept is never reported as a failure.

A mint whose info does not list NUT-09 is not asked for signatures. A swap there ends by the state of its inputs when they are unspent or the mint refused it; while they read spent it stays stored, is asked about less and less often (every ten minutes, then hourly, then daily), and its sats show as not confirmed. Sats held by a swap or a payment the mint has not settled show in the wallet as set aside. Removing a wallet with an open swap names the swap and its amount, and goes ahead only when the person agrees to let it go. A swap that arrives with a restored copy of a profile stores what it brings as ecash still to be checked ([05](05-backups.md)).

## Revision log

One file per change in [changes/201-cashu/](changes/201-cashu/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
