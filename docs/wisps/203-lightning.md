# WISP 203 — Lightning

| Field | Value |
|---|---|
| Candidate number | 203; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.3 |
| Updated | 2026-09-24 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [200](200-payments.md) |
| Implementation | Existing invoice integration; Lightning sources (the Cashu mints by default) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Existing integration

The current `btc-lightning-bolt11` endpoint carries an invoice; the application supports Lightning through its Cashu component and invoice UI. This is not evidence of a universal external-wallet adapter or a locally operated Lightning node. [BOLT 11](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md) is the invoice format reference.

## Lightning sources

The application reaches Lightning through one **active source** per profile and wallet mode (Mainnet,
Testnet), behind a `LightningProvider` contract: `info` (network, alias, balance when it has one),
`createInvoice`, `invoiceStatus`, `payInvoice` (with a fee ceiling) and `paymentStatus`. The Cashu mints are
the default source and the only one shipped so far; node and remote-wallet sources (LND, Core Lightning,
NWC, WebLN, Breez) are candidates, each a provider module with its own configuration. The Lightning card,
the `btc-lightning-bolt11` endpoint of an outgoing request and paying a contact's invoice all use the
active source; the wire format does not change.

- A source is accepted only if it reports a network of the mode (Bitcoin for Mainnet, any test network for
  Testnet). In Mainnet an invoice of a test network is refused.
- A payment is journaled before the source is asked to pay. A source reports either "nothing was spent"
  (safe to retry) or an outcome that is unknown until it is reconciled with the same source; an unknown
  payment is never paid again, and the source cannot be replaced until it ends.
- Credentials (connection URIs, macaroons, runes, keys) are sealed on the device, never part of the state a
  UI sees, and never logged.
- A source that cannot look up invoices (for example a browser wallet API) cannot tell a contact its
  request was paid; the request then stays pending on the payee's side.

Implementation guide: [PROVIDERS.md](../../packages/browser/src/engine/paymentAdapters/PROVIDERS.md).

## Paid from another wallet

An invoice a request carries can be paid by any Lightning wallet: the payer's client shows it as a QR code,
as text and as a `lightning:` link, and nothing more is required of the payer's client. The payee's source
sees the invoice paid (`invoiceStatus`, or the Cashu wallet's own quote), settles the request and sends
`pay-res ok`; only then does the payer's copy read Paid. A `pay` frame carrying the request's own invoice and
no receipt is "I paid it: look now": the payee asks its source at once (bounded), and repeats the `ok` for a
request already paid. A payer's statement is never settlement. The same holds for the on-chain, Ark and Bark
requests of [200](200-payments.md#paid-from-another-wallet).

## Lightning addresses

Paying a Lightning address or an LNURL is resolving it to an invoice and paying that invoice through the
active source, under every rule above. What is checked, and what is not offered (receiving on an address), is
[205](205-lnurl.md).

## Candidate adapter

Validate the invoice's network, expiry, amount and intended payment context through the payment component, then obtain user authorization. Match an invoice to the authenticated request and reject incompatible asset/amount requirements. Specify explicit behavior for amountless invoices; never silently infer an unlimited amount. Do not send funds on capability advertisement alone.

An external component executes payment and reports settlement evidence or an unknown outcome. Reconcile unknown results before retry or fallback; an absent `pay-res` is not evidence the payment failed. Only the appropriate payee can report its request settled, and a peer statement remains distinct from wallet-verified settlement.

## Compatibility, privacy and open decisions

Keep BOLT11 as the initial endpoint. Choose component interfaces, fee ceilings, expiry tolerance, proof retention/redaction, and refund/cancellation semantics before Proposed. WebLN is not a separate WISP or an assumed required dependency. Invoices and receipts stay off public DHT/group traffic. No new custody service is introduced.

## Conformance

Wrong network, expired/amountless/mismatched invoice, duplicate request, fee refusal, settlement with lost receipt and timeout with unknown result. Two implementations must agree on user-visible payment state without initiating duplicates.

## References

[Invoice parser](../../packages/core/src/bolt11.ts), [payment coordinator](../../packages/browser/src/engine/payments.ts), [Lightning contract](../../packages/browser/src/engine/paymentAdapters/providers/lightning.ts), [payment negotiation](200-payments.md).
