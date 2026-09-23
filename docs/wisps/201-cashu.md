# WISP 201 — Cashu

| Field | Value |
|---|---|
| Candidate number | 201; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [200](200-payments.md) |
| Implementation | Existing application integration |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Existing integration

Ghostly currently uses Cashu tokens and mint-backed wallet operations. Requests advertise accepted mints; an in-band payment carries a token; the recipient attempts redemption and returns a result. The application keeps pending operations and recovery state. This functionality belongs to the application/payment component, not Core rendezvous.

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
