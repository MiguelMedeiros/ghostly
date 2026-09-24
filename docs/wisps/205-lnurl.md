# WISP 205 — Lightning Addresses and LNURL-pay

| Field | Value |
|---|---|
| Candidate number | 205; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-24 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [200](200-payments.md), [203](203-lightning.md) |
| Implementation | Paying a Lightning address or LNURL through the active Lightning source; no wire format |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Scope

A Lightning address (`name@domain`, [LUD-16](https://github.com/lnurl/luds/blob/luds/16.md)) or an LNURL
(`lnurl1…`, [LUD-01](https://github.com/lnurl/luds/blob/luds/01.md); `lnurlp://…`,
[LUD-17](https://github.com/lnurl/luds/blob/luds/17.md)) names an HTTPS service that hands out invoices on
request ([LUD-06](https://github.com/lnurl/luds/blob/luds/06.md)). This draft covers **paying** one from a
Ghostly client, in the wallet's Send tab and from an address pasted in a chat. Nothing crosses the data link:
the chat carries the address as text, like any invoice. **Receiving** on a Lightning address needs a server
the person runs (or a custodian's); Ghostly does not provide one, and this draft does not propose one.

## Candidate requirements

- **The domain is named before anything is fetched.** Resolving is an HTTP request to the address's domain:
  that server learns that this client is about to pay. The client says which domain, and fetches only when the
  person asks. The fetch carries no credentials and no referrer.
- **Transport.** HTTPS only. Plain HTTP is accepted for a `.onion` host and for a server on the client's own
  machine (tests); a URL with credentials is refused, and so is a redirect to anything else.
- **The `payRequest` is checked field by field**: `tag`, an acceptable `callback`, integer `minSendable ≤
  maxSendable` in millisats (amounts below one whole sat are refused: the client pays whole sats), `metadata`
  that is a JSON array of `[type, value]` pairs with a `text/plain` entry, and, for an address, a
  `text/identifier`/`text/email` entry that names the same address when present. `commentAllowed`
  ([LUD-12](https://github.com/lnurl/luds/blob/luds/12.md)) is honoured within a ceiling.
- **The amount is the person's, within the limits.** The client asks for whole sats between the limits (or
  exactly the one amount when they coincide) before the callback is fetched; an amount outside them never
  reaches the service.
- **The invoice is checked before any wallet sees it**: it decodes, its amount is exactly the millisats asked
  for, it has a payment hash, it is not expired, it is on a network of the wallet mode, and it commits to the
  metadata the person was shown: its `h` tag is the sha256 of the metadata string, or it carries that exact
  string as its description (the same commitment, unhashed; how an invoice issued by a Cashu mint commits).
- **Paying is the ordinary invoice path** of [203](203-lightning.md): quoted and paid through the active
  Lightning source, with the same review, fee ceiling, journal-before-spend and unknown-outcome rules. The
  address is kept as the note of the journal entry.
- **A success action** ([LUD-09](https://github.com/lnurl/luds/blob/luds/09.md)) of tag `message` is shown
  as text; of tag `url` as a link that is never opened by itself; anything else (`aes`) is ignored.
- **Bounds.** Every fetch is bounded in time and size; a resolution is kept for a limited time and count while
  the amount is chosen, then must be repeated.

## Where it runs

The engine fetches, so every platform resolves the same way. In a web page and in the extension (which has no
host permissions), the service must allow cross-origin reads (CORS); without them the client says the server
could not be reached and names the domain. The desktop WebView has the same constraint today.

## Compatibility, privacy and open decisions

An address that looks like an email address is only treated as money when it is the whole message, or is
prefixed `lightning:`; an `lnurl1…` string is money wherever it is. Open: whether to route the fetch through
the desktop's Rust side to escape CORS, [LUD-18](https://github.com/lnurl/luds/blob/luds/18.md) payer
identity (never sent today), [LUD-21](https://github.com/lnurl/luds/blob/luds/21.md) verify, and BOLT 12 offers
as the non-HTTP alternative.

## Conformance

A plain-HTTP or credentialed URL, a non-`payRequest` answer, limits below a sat or inverted, missing
`text/plain`, an identifier for another address, an amount outside the limits, an invoice for another amount,
without a commitment to the metadata, expired, or of the other mode's network, an oversized or slow answer, an
unreachable domain named in the error. Two clients must agree on what is refused without any of them having
paid.

## References

[Parser and checks](../../packages/core/src/lnurl.ts), [Lightning service](../../packages/browser/src/engine/paymentAdapters/providers/lightningService.ts), [payment negotiation](200-payments.md), [Lightning](203-lightning.md).
