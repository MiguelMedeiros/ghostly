# WISP 801: Implemented Invitation Profiles

| Field | Value |
|---|---|
| Candidate number | 801; editorial family allocation |
| Status | Draft |
| Revision | 0.2 |
| Updated | 2026-09-25 |
| Document kind | Profile |
| Dependencies | [800](800-invite-join.md), [400](400-chat.md), [403](403-dht-text.md) |
| Implementation | Today: `pair1/` and `pair2d/` creation plus v0.4 imports. Proposed: one bech32m format, `ghostly1…`, and the reading rules below |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## One invite format (revision 0.2)

A current app creates exactly one kind of invite, for the one chat of [400](400-chat.md). There is no "Live chat" or "Text only" choice: how the chat is carried is decided after the handshake, and can be changed per chat at any time.

The invite is one self-describing [bech32m](https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki) string, in the family of Lightning's `lnbc1…` and Nostr's `npub1…`:

```text
ghostly1p<payload and checksum>
```

No slashes, no `pairN/` prefix. It reads as one word, survives being retyped (the checksum catches typos), and fits a QR code's alphanumeric mode when written in capitals.

### Exact layout

| Part | Value |
|---|---|
| Human-readable part | `ghostly` |
| Separator | `1` |
| First data symbol | The invite format version, one 5-bit symbol. Version 1 is `p` (bech32 value 1), so every version-1 code starts `ghostly1p` |
| Remaining data symbols | The payload bytes, converted from 8-bit to 5-bit groups most significant bit first, the last group padded with zero bits (the `convertbits(…, 8, 5, pad = true)` of BIP-173) |
| Checksum | Six symbols, **bech32m** constant `0x2bc830a3` (BIP-350) |

Version 1 payload, in this order, with no separators or length prefixes:

| Bytes | Field | Meaning | Today's text form |
|---|---|---|---|
| 0 to 31 | `joining-seed` | The joiner's rendezvous seed for this chat | 43 characters base64url |
| 32 to 63 | `inviter-rendezvous-key` | The inviter's Ed25519 rendezvous public key | 52 characters z-base-32 |
| 64 to 95 | `invite-secret` | Shared secret: seals pre-pin records, derives the mailboxes, the capability records and the hold pointer | 43 characters base64url |
| 96 to 127 | `inviter-participation-key` | The inviter's Ed25519 participation public key. **Present only if Q9 is adopted** | 52 characters z-base-32 |

Version 1 has exactly one payload length: 96 bytes, or 128 bytes if Q9 is adopted before any app emits a code. It never has both, and it has no optional fields: a version-1 code of any other length is damaged, not extended.

**Length.** 8 characters of `ghostly1`, 1 version symbol, 154 payload symbols (96 bytes) and 6 checksum symbols: **169 characters**. With the Q9 key: 205 payload symbols, **220 characters**. Today's `pair1/` code is 146 characters.

**The 90-character cap is lifted.** BIP-173 and BIP-350 limit a bech32 string to 90 characters; Ghostly lifts that limit explicitly, as Lightning invoices (BOLT 11) do. Encoders emit exactly the length above. Decoders accept strings up to **1,023 characters** and refuse longer ones before computing a checksum. Libraries default to 90 and must be called with the larger limit (for example `bech32m.decode(code, 1023)` in `@scure/base`, already a dependency of the core). Above 89 characters bech32m no longer *guarantees* catching every error in up to four characters; a random corruption still goes unnoticed with a probability of about one in a billion, which is the same trade Lightning makes.

**Case.** Apps emit the string in lower case in text and in upper case in QR codes. Decoders lower-case the whole string before decoding, so `ghostly1…`, `GHOSTLY1…` and a phone's autocapitalized `Ghostly1…` all read the same. (BIP-173 refuses mixed case; the case carries no data, so accepting it costs nothing and saves a confused newcomer.)

**QR.** In capitals every character of the code is in the QR alphanumeric set, which packs 5.5 bits per character instead of 8. At error correction M the bare code needs QR version 7 (version 8 with the Q9 key), where today's 146-character `pair1/` code in byte mode needs version 8. Measured with the QR encoder the app ships (qrcodegen in `qrcode.react`).

**Link form.** The same string may be shared as a link that opens Ghostly:

```text
https://ghostly.tools/#ghostly1p…
```

The code travels in the fragment, which browsers never send to the server. A decoder takes everything after the last `#`, as today's decoder already does. In a QR, the link is encoded as three segments: `HTTPS://GHOSTLY.TOOLS/` alphanumeric, `#` in byte mode, the code alphanumeric; that is QR version 8 (9 with the Q9 key), against version 9 for today's `https://app.ghostly.tools/#/chat/pair1/…` link. Which host is canonical is Q11.

**Test vector** (synthetic bytes, not keys: seed `00 01 … 1f`, rendezvous key `20 21 … 3f`, secret `40 41 … 5f`; a codec vector only, since a decoder checks lengths and leaves key validity to first use, as today):

```text
ghostly1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tu5fqcad
```

With a participation key `60 61 … 7f` appended (Q9):

```text
ghostly1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tasxzcnrv3jkvemgd94xkmrddehhqutjwd682anh0puh57mu04l8794pd4k
```

**What the joiner does with it.** It stores the fields and a fresh participation key, then starts both first contacts at once: the first-contact envelope on the DHT ([403](403-dht-text.md#first-contact)) with its capability record ([03](03-capabilities.md#layer-0-capability-record)), and a stream attempt ([100](100-transports.md)). With the Q9 key it also pins the inviter's participation key from the code before either path answers.

A copied invitation is a bearer capability; hiding a saved invite after a message does not invalidate other copies. Participation keys are authenticated and durably pinned; possession of an invite can still compete for first admission, and comparing the displayed code verifies the pin separately. Reconnect uses the stored relationship and fresh session context.

## Reading an invite

A current app reads an invite by these rules, in order. It never guesses: a code is one format or it is refused with a reason, and nothing is stored for a refused code.

1. Trim it. If it contains `#`, keep what follows the last `#`; then drop a leading `chat/` or `/chat/` (today's rule, so every link form ever shared still reads).
2. If it starts with `ghostly1` in any case, it is a bech32m invite:

| Condition | Result or message |
|---|---|
| Longer than 1,023 characters | "This is not a Ghostly invite." |
| A character outside the bech32 alphabet, or the bech32m checksum fails | "This code has a typo. Check it, or ask for the code again." |
| The checksum is valid as bech32 but not bech32m | "This is not a Ghostly invite." |
| Version 0 | "This is not a Ghostly invite." (reserved, never emitted) |
| Version 1, payload of the version-1 length, padding of at most 4 zero bits | A new chat of [400](400-chat.md) |
| Version 1 with any other payload length, or non-zero padding | "This invite is damaged. Ask for a new one." |
| Version 2 to 31 | "This invite was made by a newer Ghostly. Update to join." |

3. Otherwise, the forms made before this revision are still accepted as input:

| Input | Result |
|---|---|
| `pair1/` with three valid fields | A new chat of [400](400-chat.md). It was made by a pre-0.5 build that expects a stream first; the DHT first contact still runs, and works once that build reads its mailbox |
| `pair2d/` with three valid fields | A new chat of [400](400-chat.md), `dht-chosen` by the contact: that build chose DHT only and says so in its envelopes, until someone leaves it |
| No prefix, three valid fields | A **compatibility chat** ([402](402-legacy-chat.md)): the code came from Ghostly 0.4, which speaks only that profile |

4. Anything else, a string with another human-readable part (`npub1…`, `lnbc1…`) included, is "This is not a Ghostly invite." A known form with one malformed field names that field.

A refused code MUST NOT be retried as another format: a `ghostly1` string with a bad checksum is never read as a slash form, and a malformed `pair1/` code is never read as prefix-less.

**Older apps reading a `ghostly1…` code** (checked against the v0.4.0 source):

- The core decoder of 0.4 ([invite.ts at v0.4.0](https://github.com/MiguelMedeiros/ghostly/blob/v0.4.0/packages/core/src/invite.ts)) strips everything up to `#` and a leading `chat/`, then requires exactly three `/`-separated parts. A bech32m string has no `/`: one part, refused as invalid.
- The app's own parser of 0.4 (`parseInvite` in `src/lib/url.ts`) only takes a link whose fragment starts with `/chat/`, or three `/`-separated parts. The bare string is one part; the link `https://ghostly.tools/#ghostly1…` splits into four. Both refused.
- The 0.4 CLI reads only its own `ghost://` URLs and refuses anything else.

So an old app shows its generic invalid-code message and creates nothing: no broken compatibility chat, no half-joined record. It cannot say "update"; only apps that implement the rules above can, which is why they are written now.

**Creating.** A current app only creates `ghostly1…` codes and links. It never creates a prefix-less code, so a contact on 0.4 cannot join a chat a current app starts; the 0.4 contact can start one instead (a compatibility chat), or update.

## Versioning from here

- The version symbol changes only when the payload's fields, or what the joiner must do first, change incompatibly. Anything that can be negotiated after the first contact (capabilities, transports, extensions) is negotiated there ([03](03-capabilities.md)), not added to the invite.
- A new format is the next version number under the same `ghostly` prefix, with its own fixed payload length. Every app keeps reading each older version it can map to a chat, and answers a newer one with "Update to join".
- Version 31 is reserved to extend the version field if 30 versions are ever not enough; an app that does not know it answers "Update to join" like any other newer version.
- A different human-readable part is never a Ghostly version: it is not a Ghostly invite.
- Group invites (`group-entry/1`, `group-community/1`) keep their own formats; moving them under the same scheme with their own versions is possible and out of scope here.

## Boundary with the common contract

The stronger single-use admission state machine, atomic global use limits, group admission and authority coordination in [800](800-invite-join.md) remain proposed. This profile does not make those promises. Group invites (`group-entry/1`, `group-community/1`) have their own formats ([9xx group mesh](9xx-group-mesh.md), [9xx group community](9xx-group-community.md)) and are not changed by this revision.

## Open decisions

| # | Question | Recommendation |
|---|---|---|
| Q8 | A new slash prefix (`pair3/`, the first draft of this revision) or one bech32m string? | **Resolved (maintainer, 2026-09-25): one bech32m string, `ghostly1…`**, with the version inside it. It replaces the `pair3/` proposal, which no app ever emitted. |
| Q9 | Should the code also carry the inviter's participation public key? | **Yes, if decided before 0.5 ships**: it makes version 1 the 128-byte layout (220 characters, QR version 8 at level M, the same as today's bare code). The joiner then pins the inviter from the code, and someone else holding a copy can no longer answer as the inviter. If not adopted, version 1 is the 96-byte layout (169 characters) and the key waits for a later version. |
| Q10 | Offer "Invite someone on Ghostly 0.4" (make a prefix-less code)? | **No.** The web app is replaced by 0.5 on release; desktop users on 0.4 can make the code themselves or update. |
| Q11 | Which host is canonical for the link form: `ghostly.tools` or `app.ghostly.tools`? | **`https://ghostly.tools/#ghostly1…`**, with `app.ghostly.tools/#ghostly1…` also read. The site's page can offer the choices a newcomer needs (open in the desktop app, open in the browser, get Ghostly) where the web app would only open itself; the shorter host also keeps the QR at version 8. Either way the page MUST keep the fragment out of analytics, logs and referrers, and hand it to the app without a server round trip. |

## Evidence and checks

[Invite encoding](../../packages/core/src/invite.ts), [paired bootstrap](PAIRED-CHAT-INCREMENT.md), [DHT invitation binding](../DHT-DELIVERY.md), [client join lifecycle](../../packages/browser/src/engine/node.ts). Test the vectors above both ways; upper, lower and mixed case; the link form with each host; each refusal of the table with its message and nothing stored (bad checksum, bech32 instead of bech32m, version 0, version 2, wrong length, non-zero padding, 1,024 characters, `npub1…`); reading `pair1/`, `pair2d/` and prefix-less codes; that 0.4 builds refuse the code and the link; duplicate local joins; key substitution; reconnect without losing history.

## Revision log

- 0.2 (2026-09-25): one invite format, a bech32m `ghostly1…` string with its version inside (replacing a first `pair3/` draft); exact layout, lengths, QR and link form; reading rules and messages both ways; versioning rule; Q8 resolved, Q9 to Q11.
- 0.1 (2026-09-22): `pair1/`, `pair2d/` and legacy imports.
