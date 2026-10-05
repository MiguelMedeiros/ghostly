# WISP 200: Payment Negotiation

| Field | Value |
|---|---|
| Candidate number | 200; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [03](03-capabilities.md), [100](100-transports.md) |
| Implementation | Payment frames with wallets per network (Mainnet and Testnet side by side); experimental rails: Cashu, Lightning cards, Ark (Arkade, Bark), Spark, Fedimint, USDT, on-chain Bitcoin |
| Summary | Agree on a payment method and carry the request; the wallet adapter moves the value. |
| Availability | Available |
| Notes | Methods are negotiated in every chat, and in groups between two members. Any wallet can pay a request from its QR code or link; it is settled only when the payee's own wallet sees the money. |
| Feature | [Send sats](https://ghostly.tools/#next) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Scope and existing behavior

Ghost negotiates payment methods and carries requests/results; it does not mandate a new wallet. Current `pay-req`, `pay`, `pay-res` frames use request/payment IDs, decimal-text amounts, an asset and ordered endpoints. Initial identifiers are `cashu` and `btc-lightning-bolt11`; the other rails add their own endpoints (`btc-arkade/1`, `btc-bark/1`, `btc-spark/1`, `fedimint-ecash/1`, `btc-onchain/1`, USDT). Frames run only over the data link. The application's wallets are reference integrations, not a Core requirement.

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
| Bark | Bitcoin, Second's server `ark.second.tech` | Second's signet server; a local regtest server |
| Spark | Bitcoin, with the user's own Breez API key | Breez and Lightspark's hosted regtest |
| Fedimint | Federations on Bitcoin, joined by invite | Federations on test networks, joined by invite |
| Lightning | Several cards, each with its own source; the Cashu mints' card comes with a Cashu wallet | The same, on test networks |
| Bitcoin on-chain source | None until one is chosen | None until one is chosen |

- First run: a new profile (nothing stored yet, no wallet, no chat) gets its default Mainnet wallets by itself, in the background, so it can receive without setting anything up: Cashu (Lightning through the default mints) and USDT on Ethereum, and Bitcoin on-chain once a Mainnet on-chain wallet can be made without a form (none yet). Each is made as New makes it, checked before its card appears, and moves no money. The client records per profile that the setup ran and which kinds are still to make: a kind made (by the setup or by hand) is never made again, so a wallet the user removes stays removed, and a kind that could not be made (a server down, offline) shows its reason on the wallet page with Try again and Skip, and is tried again at the next start. A profile from before this, or one whose wallets were all removed, is never set up. The headless client never does this, and neither does a client under test (an automated browser, a test build) unless the test asks for it.
- Otherwise nothing is made by itself: every other wallet is made with New (or "Create your first wallet": Testnet makes Cashu and USDT; Mainnet makes the same wallets as the first run), one type and one network at a time.
- A network's wallet of each kind is stored on its own (`arkWallet-mode-<network>`, `usdtWallet-mode-<network>`, … in the peer database). Clients from before wallets had their own network kept the wallet of the mode in use under a bare key (`arkWallet`); a client moves it to its network's key once, in one transaction, deleting and overwriting nothing ([05](05-backups.md)).
- The chain of a payment target decides its network (Bitcoin and Ethereum are Mainnet; every other chain is Testnet), and so does a Cashu mint. A payment goes only through the wallet of its own network. A request or a payment of one network is refused by a wallet of the other, with nothing spent.
- A `pay-req` carries `n`: `"mainnet"` or `"testnet"`, the network that pays it. A `pay-ask` carries the `n` the payer pays from, and the payee answers from its wallet of that network, or not at all. An older client sends no `n`: the request's endpoints tell (a test mint, a test chain; a bare invoice without mints is taken as Mainnet). Clients ignore an `n` that is neither value.
- `paired-payments` may carry `n`: for each way of paying in `m`, the networks this side has a wallet on (`{"cashu":["testnet"],"arkade":["mainnet","testnet"]}`). A client offers a card only where its network is in the contact's list; a method missing from the map has none. No `n` at all (an older client) means any network may meet. A malformed map is ignored and the last good one kept; unknown methods are left out. It is sent again on the open session when a wallet is made.
- Test sats never settle a request for real sats, and a request is never mixed: it names either only real mints or only test mints ([201](201-cashu.md)).
- The client shows each wallet's network with it, in words (Real money / Test money), and every test amount reads as test sats, test coins or TEST-USDT.
- A Mainnet spend needs an explicit second confirmation ("Send real money"); the engine refuses one without it (`confirmedReal`), before anything is spent. Test money needs no second step.
- The first time a Mainnet wallet holds money, the client asks once for a copy of it: a card on the Wallet page and a dot on the wallet icon, never a dialog. A wallet with a recovery phrase asks for the phrase (or a backup file of it); Cashu, which has none, asks for a profile backup ([05](05-backups.md)). It ends once the phrase is shown, a backup file of the wallet is made, or a profile backup is made after the money arrived. "Later" puts it off until the next receive or for three days, once; a second "Later" ends it. The engine keeps this per wallet in the profile's settings (`backupReminders`), and removing a wallet forgets it. Test money never asks.
- A Testnet wallet never funds itself: a test mint's invoice is held until a payer says it paid it, and test coins come only from **Get test coins** on the wallet's details.
- A contact's mint is never added automatically unless it is on the fixed list of public test mints: in particular never a mint on this machine, which would let a contact make the app reach one of its local ports.

## On-chain Bitcoin (draft)

A local `bitcoin` payment method pays a Bitcoin address through the profile's active on-chain source for
the network (a wallet library or a node the user configures; none by default). A target names the method,
the network (`bitcoin`, `signet`, `testnet`, `regtest`, `mutinynet`), `BTC` in sats and an address that must
be valid for that network (checksums, witness version, prefixes); its provider field is the fixed value
`onchain`, since anyone can pay an address from any wallet.

The source builds and signs the transaction when the payment is reviewed, so the approved fee and outputs
are exactly what is broadcast. Approval broadcasts it; a lost answer is reconciled by asking about, or
re-broadcasting, that same transaction, which cannot pay twice. A cancelled review releases the coins it
reserved. A payment is settled after one confirmation; a transaction whose inputs another one spent is
failed. In a chat it is the `bitcoin` way of paying, endpoint `btc-onchain/1`, allowed only through the
`paired-payments` list of an open session. Fee policy for small amounts, confirmation targets, RBF and reorg
handling are still open.

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

Preserve legacy frames/endpoint vocabulary, inspired by Paykit; do not claim Paykit transport integration. Payments and tokens MUST NOT be placed in DHT records or group broadcasts. Group context may identify a payee, but actual payment remains a specifically authorized exchange. Choose generic wallet interface, cancellation/expiry and receipt evidence semantics before Proposed. On-chain, Ark, Spark and Fedimint are implemented as experimental rails; none has a reserved number here.

## Conformance

Disjoint methods, malformed decimal amounts, mismatched request/payee, expired request, duplicate payment IDs, lost receipt and wallet-unknown outcome. Replaying a receipt must not authorize or duplicate spending.

## References

[Payment vocabulary](../../packages/core/src/payments.ts), [frames](../../packages/core/src/frames.ts), [application payment coordinator](../../packages/browser/src/engine/payments.ts), [Cashu](201-cashu.md), [Lightning](203-lightning.md), [Lightning addresses](205-lnurl.md), [Arkade](202-arkade.md), [Bark](204-bark.md), [Spark](206-spark.md), [Fedimint](207-fedimint.md), [USDT](../USDT-INTEGRATION.md), [payment URIs](../../packages/core/src/paymentUri.ts), [wallet providers](../../packages/browser/src/engine/paymentAdapters/PROVIDERS.md).

## Revision log

One file per change in [changes/200-payments/](changes/200-payments/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
