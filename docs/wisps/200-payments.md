# WISP 200: Payment Negotiation

| Field | Value |
|---|---|
| Candidate number | 200; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.2 |
| Updated | 2026-09-24 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [03](03-capabilities.md), [100](100-transports.md) |
| Implementation | Existing payment frames; generic integration proposed |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Scope and existing behavior

Ghost negotiates payment methods and carries requests/results; it does not mandate a new wallet. Current `pay-req`, `pay`, `pay-res` frames use request/payment IDs, decimal-text amounts, an asset and ordered endpoints. Initial identifiers are `cashu` and `btc-lightning-bolt11`. Frames run only over the data link. The application currently includes Cashu wallet code; that is a reference integration, not a Core requirement.

## Candidate requirements

Keep method support, settlement and user authorization separate. A payer chooses a mutually supported, policy-allowed method, confirms amount/asset/payee and delegates execution to its chosen external payment component. Required fees/limits and ambiguous outcomes need explicit handling. A channel invite or proof does not authorize spending.

Bind requests and receipts to the authenticated payee context and request ID. Idempotent retries must not initiate a second payment. Distinguish pending, succeeded, failed and unknown outcomes. A peer's receipt is a statement, not independent settlement proof; verify through the payment adapter where available. Never silently switch methods after an ambiguous settlement.

## Wallet networks: Mainnet and Testnet

Real money and test coins never meet. Every wallet a client holds is on one of two networks, and a client may hold wallets of both at once, side by side:

| | Mainnet | Testnet |
|---|---|---|
| Cashu and Lightning | The user's mints, excluding test ones | Test mints: the public test mint and mints on this machine (`localhost`, `127.0.0.1`, `[::1]`) |
| Ark | Bitcoin | Mutinynet by default; Signet and a local regtest server may be chosen while the wallet is empty |
| USDT | Ethereum, the canonical contract | Sepolia (Aave's test USDT) by default; a local chain may be chosen while the wallet is empty |
| Lightning source | The Cashu mints unless another source is chosen | Its own choice, the Cashu (test) mints by default |
| Bitcoin on-chain source | None until one is chosen | None until one is chosen |

- A network's wallet of each kind is stored on its own (`arkWallet-mode-<network>`, `usdtWallet-mode-<network>`, … in the peer database). Clients from before wallets had their own network kept the wallet of the mode in use under a bare key (`arkWallet`); a client moves it to its network's key once, in one transaction, deleting and overwriting nothing ([05](05-backups.md)).
- The chain of a payment target decides its network (Bitcoin and Ethereum are Mainnet; every other chain is Testnet), and so does a Cashu mint. A payment goes only through the wallet of its own network. A request or a payment of one network is refused by a wallet of the other, with nothing spent.
- A `pay-req` carries `n`: `"mainnet"` or `"testnet"`, the network that pays it. A `pay-ask` carries the `n` the payer pays from, and the payee answers from its wallet of that network, or not at all. An older client sends no `n`: the request's endpoints tell (a test mint, a test chain; a bare invoice without mints is taken as Mainnet). Clients ignore an `n` that is neither value.
- `paired-payments` may carry `n`: for each way of paying in `m`, the networks this side has a wallet on (`{"cashu":["testnet"],"arkade":["mainnet","testnet"]}`). A client offers a card only where its network is in the contact's list; a method missing from the map has none. No `n` at all (an older client) means any network may meet. A malformed map is ignored and the last good one kept; unknown methods are left out. It is sent again on the open session when a wallet is made.
- Test sats never settle a request for real sats, and a request is never mixed: it names either only real mints or only test mints ([201](201-cashu.md)).
- The client shows each wallet's network with it, and every test amount reads as test sats, test coins or TEST-USDT.
- A contact's mint is never added automatically unless it is on the fixed list of public test mints: in particular never a mint on this machine, which would let a contact make the app reach one of its local ports.

## On-chain Bitcoin (draft)

A local `bitcoin` payment method pays a Bitcoin address through the profile's active on-chain source for
the mode (a wallet library or a node the user configures; none by default). A target names the method,
the network (`bitcoin`, `signet`, `testnet`, `regtest`, `mutinynet`), `BTC` in sats and an address that must
be valid for that network (checksums, witness version, prefixes); its provider field is the fixed value
`onchain`, since anyone can pay an address from any wallet.

The source builds and signs the transaction when the payment is reviewed, so the approved fee and outputs
are exactly what is broadcast. Approval broadcasts it; a lost answer is reconciled by asking about, or
re-broadcasting, that same transaction, which cannot pay twice. A cancelled review releases the coins it
reserved. A payment is settled after one confirmation; a transaction whose inputs another one spent is
failed. There is no chat endpoint for on-chain payments yet: requests, fee policy for small amounts,
confirmation targets, RBF and reorg handling must be decided before one is proposed.

## Paid from another wallet

A request's endpoint (an invoice, an address) is shown to the payer as a QR code, text and a `lightning:` or
`bitcoin:` URI (BIP 21, with `lightning=` when both exist and `ark=` for an Ark address), so any wallet can
pay it. Settlement stays with the payee: its own wallet must see the money (the invoice paid at its source, a
confirmed transaction on the address, a virtual output on the Ark address), then it marks the request paid and
sends `pay-res ok`. The payer's client marks its copy paid on that result only, never on the person's word.
A `pay` frame without a receipt (the request's own invoice, or the payload `{"check":true}` for an address)
means "I paid it: look now"; the payee bounds how often it looks and answers `ok` again for a request already
paid. Opening the URI is the client's platform's job (desktop and extension hand it to the system); copy and
the code are the fallback.

## Compatibility, privacy and open decisions

Preserve legacy frames/endpoint vocabulary, inspired by Paykit; do not claim Paykit transport integration. Payments and tokens MUST NOT be placed in DHT records or group broadcasts. Group context may identify a payee, but actual payment remains a specifically authorized exchange. Choose generic wallet interface, cancellation/expiry and receipt evidence semantics before Proposed. On-chain, Ark and Spark are possible future extensions without reserved numbers here.

## Conformance

Disjoint methods, malformed decimal amounts, mismatched request/payee, expired request, duplicate payment IDs, lost receipt and wallet-unknown outcome. Replaying a receipt must not authorize or duplicate spending.

## References

[Payment vocabulary](../../packages/core/src/payments.ts), [frames](../../packages/core/src/frames.ts), [application payment coordinator](../../packages/browser/src/engine/payments.ts), [Cashu](201-cashu.md), [Lightning](203-lightning.md), [Lightning addresses](205-lnurl.md), [payment URIs](../../packages/core/src/paymentUri.ts), [wallet providers](../../packages/browser/src/engine/paymentAdapters/PROVIDERS.md).
