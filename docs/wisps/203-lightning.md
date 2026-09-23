# WISP 203 — Lightning

| Field | Value |
|---|---|
| Candidate number | 203; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [200](200-payments.md) |
| Implementation | Existing invoice integration |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Existing integration

The current `btc-lightning-bolt11` endpoint carries an invoice; the application supports Lightning through its Cashu component and invoice UI. This is not evidence of a universal external-wallet adapter or a locally operated Lightning node. [BOLT 11](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md) is the invoice format reference.

## Candidate adapter

Validate the invoice's network, expiry, amount and intended payment context through the payment component, then obtain user authorization. Match an invoice to the authenticated request and reject incompatible asset/amount requirements. Specify explicit behavior for amountless invoices; never silently infer an unlimited amount. Do not send funds on capability advertisement alone.

An external component executes payment and reports settlement evidence or an unknown outcome. Reconcile unknown results before retry or fallback; an absent `pay-res` is not evidence the payment failed. Only the appropriate payee can report its request settled, and a peer statement remains distinct from wallet-verified settlement.

## Compatibility, privacy and open decisions

Keep BOLT11 as the initial endpoint. Choose component interfaces, fee ceilings, expiry tolerance, proof retention/redaction, and refund/cancellation semantics before Proposed. WebLN is not a separate WISP or an assumed required dependency. Invoices and receipts stay off public DHT/group traffic. No new custody service is introduced.

## Conformance

Wrong network, expired/amountless/mismatched invoice, duplicate request, fee refusal, settlement with lost receipt and timeout with unknown result. Two implementations must agree on user-visible payment state without initiating duplicates.

## References

[Invoice parser](../../packages/core/src/bolt11.ts), [payment coordinator](../../packages/browser/src/engine/payments.ts), [payment negotiation](200-payments.md).
