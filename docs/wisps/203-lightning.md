# WISP 203: Lightning

| Field | Value |
|---|---|
| Candidate number | 203; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [200](200-payments.md) |
| Implementation | Several Lightning cards per network, each on its own source (Cashu mints, Fedimint, Breez, NWC, Core Lightning, LND, WebLN) |
| Summary | Carry a Lightning invoice in the chat and pay or receive it through the wallet. |
| Availability | Available |
| Notes | Several Lightning cards per network, one of them the default for receiving: your Cashu mint or your own node or wallet (NWC, LND, Core Lightning, WebLN in the web app, Breez (with your own API key on Mainnet) or a Fedimint federation). Any other wallet can pay the invoice from its QR code. |
| Feature | [Wallets](https://ghostly.tools/#wallets) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Existing integration

The current `btc-lightning-bolt11` endpoint carries an invoice; the application reaches Lightning through the sources below. This is not evidence of a universal external-wallet adapter. [BOLT 11](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md) is the invoice format reference.

## Lightning sources

The application reaches Lightning through **Lightning cards**, several per profile and network (Mainnet,
Testnet), each with its own **source** behind a `LightningProvider` contract: `info` (network, alias, balance
when it has one), `createInvoice`, `invoiceStatus`, `payInvoice` (with a fee ceiling) and `paymentStatus`. The
Cashu mints, Fedimint, Breez, NWC, Core Lightning, LND and WebLN are sources, each a provider module with its
own configuration; the same source may back several cards (two NWC wallets, two LND nodes), never the same
wallet twice.

- **Paying** goes through the card the person picks (the payment sheet, a pasted invoice, a Lightning address).
- **Receiving:** one card per network is the **default for receiving**. The `btc-lightning-bolt11` endpoint of an
  outgoing request and Receive use it unless another card is picked for that request.
- A chat's **Accept** side keeps one Lightning switch per network: it means "a request of mine carries an
  invoice", and that invoice comes from the default card. A contact never learns which card; the wire format
  does not change.

- A source is accepted only if it reports a chain of the card's network (Bitcoin for Mainnet, any test network
  for Testnet). A Mainnet card refuses an invoice of a test network.
- Where each source runs: the Cashu mints, NWC, Core Lightning, LND, WebLN, Fedimint and Breez on Mainnet and
  Testnet (Breez on Mainnet with the person's own API key). The table is in
  [PROVIDERS.md](../../packages/browser/src/engine/paymentAdapters/PROVIDERS.md#built-in-providers).
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
Lightning card chosen (**Pay with**, when the network has several), under every rule above. What is checked, and what is not offered (receiving on an address), is
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

## Revision log

One file per change in [changes/203-lightning/](changes/203-lightning/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
