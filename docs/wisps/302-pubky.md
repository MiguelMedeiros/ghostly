# WISP 3xx: Pubky identity (approved in Pubky Ring or Pubky Passport)

| Field | Value |
|---|---|
| Number assignment | 3xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.2 |
| Updated | 2026-09-25 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [300](300-peer-proofs.md) |
| Implementation | Identity provider `pubky`: `packages/browser/src/proofs/providers/pubky.ts`, `proofs/pubky.ts`; core `pubkyProofs.ts`, `pkdns.ts` |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md). The historical document identifier 302 remains in the URL for link compatibility; it is not a committed WISP number.

## Purpose

A person shows a contact, optionally and per contact, that they hold a Pubky key: the key [Pubky Ring](https://github.com/pubky/pubky-ring) (a phone) or [Pubky Passport](https://github.com/pubky/pubky-passport) (a browser) keeps for them. It is a provider of the identity-proof contract ([PROOFS.md](../../packages/browser/src/proofs/PROOFS.md)), id `pubky`, category self-custodied: made once on the Identities page, then shared per contact through WISP 300's exchange like every other identity.

## Publication, not signature

Neither Ring nor Passport signs arbitrary text. They approve standard Pubky SDK auth requests, which grant an app access to paths of the key's homeserver. So the external identity vouches for the statement by **publishing** it, the way a domain proof publishes a DNS record:

1. Ghostly picks a fresh folder, 32 random bytes as hex, and starts ONE grant auth flow (`GrantAuthFlow.start`, client id `ghostly.tools`, `x-source` Ghostly) for exactly one capability: `/pub/ghostly.app/proofs/<folder>/:w`. The flow's proof-of-possession key stays in that flow's memory (not the SDK's delegated IndexedDB key).
2. The same request is offered two ways, on one screen, and whichever approves it first wins:
   - **Pubky Passport**: a button opens `https://passport.pubky.app/authorize#d=<encodeURIComponent(authorization URL)>` in a popup, from the click itself (a popup opened after an `await` is blocked). The desktop app hands that page to the system browser instead. Ghostly passes no callbacks, so it acts on no message from Passport: a Passport outcome is never a credential. Someone with no Passport identity can make one there with "Continue with Google"; such an identity is recovered with Google plus Passport together (neither alone can), and the approval screen says so.
   - **Pubky Ring**: a QR code of the same authorization URL.
3. The SDK receives the approval through Pubky's HTTP relay and returns a session. Ghostly refuses a session whose capabilities are not exactly the one asked for (signs it out, writes nothing).
4. Ghostly builds the WISP 300 statement for the session's key (`pubky:<z32 key>` authorizes a fresh per-proof Ed25519 key for the validity chosen, 90 days by default, at most 365), and writes its exact bytes, one line with no newline, to `/pub/ghostly.app/proofs/<folder>/<statement id>.txt`, where the statement id is SHA-256 of the statement, lowercase hex. The evidence is `{ "folder": "<64 hex>" }` and nothing else.
5. Ghostly verifies it the way a contact will (below) before saving, then signs the session out and forgets it. An approval that lands after a cancel or a time-out (5 minutes, the relay's lifetime) is signed out at once. If the proof is not saved, the file just written is deleted.

The authorization URL carries the relay channel's secret. It goes in Passport's fragment (never sent to a server), encoded exactly once, is drawn as a QR code but never written into the page as text, and is never logged; errors from the SDK are redacted before they are shown.

## Verification (contact side)

Only through the contract's bounded `ctx.fetch` (HTTPS GET, no credentials or referrer, a timeout, a size cap, no redirects), and never from a host or URL in the evidence:

1. The subject is a canonical Pubky key: 52 characters of z-base-32 that decode to 32 bytes and back.
2. The key's signed Pkarr packet is read from Pubky's relays (`https://pkarr.pubky.org/<key>`, `https://pkarr.pubky.app/<key>`, at most 1072 bytes each); each answer's signature is checked against the key, and the newest valid one is used. Its `_pubky` HTTPS or SVCB record names the homeserver's key.
3. The homeserver's own signed packet, read the same way, names where it answers browsers: of its HTTPS/SVCB records at its root, the lowest priority one (above 0) whose target is a public ICANN host name (not `.`, not another Pkarr key, not a name that only works on private networks such as `localhost`, `*.local`, `*.internal`, `*.test`, nor an IP literal), with its port parameter.
4. `GET https://<host>[:<port>]/pub/ghostly.app/proofs/<folder>/<statement id>.txt` with header `pubky-host: <key>`, at most 1024 bytes. It must answer 200 with exactly the statement's text.

The outcome says how it was checked: "File on the homeserver <host>, found through the key's own Pkarr records". The file can be deleted, or the key can move to another homeserver, before the proof expires, so the provider declares `recheck` (a day): contacts' apps offer "Check again" and look again by themselves.

## Removal

Ghostly keeps no access after adding a proof, so taking the file down needs one more approval. Removing a Pubky identity offers both:

- **Approve and remove**: a new request for the same folder's capability (Ring or Passport, the same screen), the session must be the same key, the file is deleted, then the proof is removed.
- **Remove, keep the file**: the proof is removed without touching the homeserver.

Either way, WISP 300's revocation applies: every contact it was shared with is told it is withdrawn, and the proof key publishes a `_ghostly-revoked` record on Pkarr (republished until the proof would have expired), which contacts find even if the person never reconnects. A contact's re-check finds the revocation first ("Revoked by its owner"); a deleted file alone reads "Could not be confirmed".

## Security and privacy

- **What it shows.** Whoever approved the request could write under that key on the homeserver its records name. It does not show who holds the key. The homeserver's operator could write there too: the UI says so in the provider's limits.
- **What contacts learn.** The Pubky key, which links every conversation it is shared in, and the proof key. Reading the proof, a contact's app contacts Pubky's Pkarr relays and the person's homeserver, which sees the contact's IP address.
- **What is public.** The file sits in a random folder under `/pub/ghostly.app/proofs/`: anyone listing the key's public storage can see that the key made a Ghostly proof and read its statement (the proof key and the dates), not who it was shared with.
- **Least privilege.** One write capability, one folder, one use. A grant for anything more is refused before any write.

## CSP

Web (`connect-src 'self' https: wss:`) and desktop (`connect-src … https: wss: ws:`) already reach Pubky's relays and any homeserver over HTTPS; extension pages set no `connect-src`. The SDK needs `'wasm-unsafe-eval'`, already allowed. No `frame-src`: Passport sends `frame-ancestors 'none'` and runs in its own window. The desktop app opens Passport through an allow-listed command (`open_pubky_passport`: only `https://passport.pubky.app/authorize#d=` followed by an encoded `pubkyauth:` request).

## Conformance

- Unit: path and capability building, the exact file bytes, key normalization, PKDNS decoding (a real homeserver packet as the vector), bounded reads, newest-record selection, private-host refusal, a session with any other capability refused and signed out, cancellation, the Passport popup opened synchronously in the click, the request never logged; the WISP 300 contract suite.
- End to end, against Pubky's testnet in the e2e infra (homeserver, Pkarr relay, HTTP relay) with a test approver holding a throwaway key in place of Ring and Passport: adding a Pubky identity through a Passport stand-in and by scanning the QR code, a contact verifying it, removal deleting the file and the contact seeing it revoked (`e2e/web/pubky-identity.spec.ts`).
- Pending: approval by the real Pubky Ring and the real passport.pubky.app, checked by hand.

## Retired experiments (history)

Before this provider, Pubky existed only in the old per-chat proof dialog, disabled since 2026-09-21: a pasted 64-hex secret (`pubky-import`), a modified-Ring challenge protocol (`pubky-ring`, never supported by the official Ring), and a per-chat storage observation (`pubky-storage`). They are retired: nothing makes them any more, and the modified-Ring overlay is gone. Evidence a contact already accepted still verifies (`pubky-import`, `pubky-ring`) or can still be read (`pubky-storage`), so stored records are not orphaned.

## References

[Peer proofs](300-peer-proofs.md), [PROOFS.md](../../packages/browser/src/proofs/PROOFS.md), [Pubky Passport integration guide](https://github.com/pubky/pubky-passport/blob/main/docs/integration.md), [Pubky homeserver and SDK](https://github.com/pubky/pubky-homeserver).
