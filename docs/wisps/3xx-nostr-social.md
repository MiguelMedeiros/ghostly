# WISP 3xx — Nostr social layer

| Field | Value |
|---|---|
| Number assignment | 3xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-23 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [300](300-peer-proofs.md), [301](301-nostr.md) |
| Implementation | Experimental: `packages/browser/src/nostr/`, `packages/browser/src/engine/nostrSocial.ts`; see [below](#implementation--2026-09-23) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Scope

What a **proven** Nostr identity ([301](301-nostr.md) under [300](300-peer-proofs.md)) lets a person *show* and *do* in Ghostly, as separate capabilities, each permitted on its own, exactly as the [roadmap's layer table](ADAPTER-ROADMAP.md#identity-profiles-and-social-data) separates them:

| Layer | Nostr data | Permission |
|---|---|---|
| Proof | the kind-30078 binding of 301 | shared per chat, by choice (300) |
| Profile | kind 0: name, picture, about, NIP-05, website | loaded on request, or by an explicit setting |
| Social graph | kind 3: whom a key follows | loaded on request; hints against the person's own list |
| Content read | kind 1 notes, moderated by the person's own kind-10000 mute list | loaded on request, paginated |
| Publication | kind 1, kind 3, kind 0, through the person's own signer | a capability turned on by the person; each action confirmed |

Nothing here defines a new event kind, tag or relay message: every read and write is plain [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) with the kinds of [NIP-02](https://github.com/nostr-protocol/nips/blob/master/02.md) (follows), [NIP-51](https://github.com/nostr-protocol/nips/blob/master/51.md) (mute list) and NIP-01 itself (profile, notes), signed by [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) or [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md). The contract is what Ghostly does and does not do with them. Nothing travels between Ghostly peers: a contact learns what the person's key published by asking relays, exactly as any Nostr client would, and only because the proof gave them the key.

## Candidate requirements

**A proof unlocks a key, nothing else.** A contact's app MAY ask relays about a key only while that key is a currently verified Nostr proof in that chat (300: verified, not expired, withdrawn, revoked or from a previous participation key). Nothing is asked about a key the contact did not prove. What was loaded for a key that stops being verified MUST leave the chat's presentation at once and MUST NOT be shown under another proof.

**Nothing without the person's action or an explicit setting.** Profile, follows and notes are each loaded when the person presses their button. One setting MAY load a contact's profile automatically when their proof is verified and refresh it when it is a day old; it is off by default and says what it does. Every place a fetch can be started says which relays are asked and that they learn the person's IP address and the key looked up.

**The relays are the person's.** Relays are read from one list the person configures (defaults allowed but shown), `wss://` only, at most eight. Nothing discovers relays from what it reads (a kind-3 relay list, a NIP-65 record, a relay hint in a tag), so the set of servers that learn what was looked up never grows without the person seeing it.

**Every event is checked, on a copy.** Strict shape, bounded sizes, the id recomputed and the BIP-340 signature verified before anything is parsed; an SDK's or a relay's verification flag is never trusted. Replaceable kinds keep the newest by `created_at`, the lexicographically smaller id on a tie (NIP-01). Every value is self-described by the key that signed it, and shown as such; nothing is inferred (a NIP-05 string is shown as written, not resolved; a follow is not trust).

**Bounded and plain.** Text is plain text: controls and bidirectional overrides removed, capped (name 64, about 500, note 4000 characters), never rendered as markup. Pictures are fetched only from the fixed hosts of [PUBLIC-PROFILES](PUBLIC-PROFILES.md), decoded within bounds and re-encoded to a small JPEG data URL, like a paired contact's own picture (`packages/core/src/avatar.ts`); any other host leaves the name usable and the picture out. A frame is at most 64 KiB, a relay read at most 64 events and eight seconds, a note page 20, at most 200 notes kept per key.

**Cached with provenance.** Each loaded part keeps which relays answered, when it was fetched and the event's own time and id; a day-old copy is shown as stale and offered a refresh. A manual name for the chat always wins over a profile name. A contact's cache lives in that chat's record and goes with it.

**The social graph is hints, with direction.** "Follows you" (their list names one of the person's proven keys), "you follow them" (the person's list names theirs) and "you both follow N" (the intersection, the two keys excluded) are computed locally from the two lists, each labelled with its direction and the time of the list it comes from. No edge is presented as reciprocal or trusted, and no contact's list is imported, merged or published.

**Content is a list, not a feed.** A key's notes, newest first as relays hold them, paginated by `until`; no ranking, no recommendation, no other author. The person's own kind-10000 mute list (its public `p`, `e` and `word` tags; the encrypted part is noticed, not read) hides notes by a muted author, mentioning a muted key, listed by id, or containing a muted word, and says how many were hidden.

**Publication is a capability, off by default.** With it on, the person may post a note, follow or unfollow a key, or update their profile. The app builds the exact unsigned event; the person sees what becomes public and where (the relays), confirms, and signs with their own NIP-07 extension or NIP-46 signer, which is asked only for that kind (`sign_event:1`, `:3`, `:0`); a stored private key is never an option. The app then verifies the signed event is the draft it built (same key, kind, time, tags, content) before sending, refuses otherwise, and reports which relays accepted it. A kind-3 or kind-0 is rebuilt from the current event read fresh from the relays, so every tag and field the app does not know travels unchanged; if no relay answers, the app refuses to publish a replacement blind. Deletion is out of scope (a NIP-09 request relays may ignore) and the notice says so.

**Per contact.** A contact only reaches the person's Nostr data if the person shared the proof with them; a contact's own reads reveal the person's key to the contact's relays, not to Ghostly or to the person.

## Compatibility and open decisions

Deletion requests (NIP-09), reactions, replies and mentions, DMs, relay lists (NIP-65) and the private part of the mute list (NIP-44 with the signer) are not included; each is a further capability with its own permission. Whether a contact's profile name may stand in for the chat's name when no name was set is a UI decision recorded as "manual wins" only. Muting from Ghostly (publishing a kind 10000) is not offered.

## Conformance

A contact without the shared proof loads nothing and sees no Nostr card, and no relay sees a request from them. With it, profile, follows and notes load only on the person's action, from the configured relays, each shown with source and time; a note matching the person's mute list is hidden and counted; hints are computed only once the person's own list is loaded. Publication is refused while the capability is off; a draft signed by another key, or altered by the signer, is refused before anything is sent; a follow/unfollow keeps every other entry of the list; a profile update keeps unknown fields. See the [implementation](#implementation--2026-09-23) for the tests that establish this.

## References

[Peer Proofs](300-peer-proofs.md), [Nostr](301-nostr.md), [Local public profiles](PUBLIC-PROFILES.md), [roadmap: identity, profiles and social data](ADAPTER-ROADMAP.md#identity-profiles-and-social-data).

## Implementation — 2026-09-23

Experimental, web, extension and desktop. Code: `packages/browser/src/nostr/relay.ts` (bounded NIP-01 client: read one filter from the person's relays, send one signed event), `nostr/social.ts` (parsing of kinds 0, 3, 1 and 10000, mute rules, follow hints, the three unsigned templates), `nostr/types.ts` (settings, caches, views), `engine/nostrSocial.ts` (permissions, caches, drafts), engine RPC `nostrLoadContact`, `nostrForgetContact`, `nostrLoadOwn`, `nostrDraft`, `nostrPublish`; UI `src/components/nostr/` (the contact card inside the chat's Identities, the Identities → Nostr section, the publish dialog), signing in `src/lib/nostr.ts`.

- **Settings** (`settings.nostr`): `relays` (default `relay.damus.io`, `nos.lol`, shown and editable), `autoLoadProfiles` (off), `publish` (off). Shown in Identities → Nostr once the profile has a Nostr key or a contact shared one.
- **Contact card**, in the chat's Identities under a verified Nostr proof: Load profile / follows / notes, "Load mine" for the hints, Older notes, Forget what was loaded; with publication on, Follow / Unfollow on Nostr. The proof's card takes the loaded name and picture with the source "Nostr profile (kind 0, signed by this key, self-described)"; the old provider `lookupDisplay` route for Nostr now goes through this layer, so it uses the person's relays.
- **Own keys**, in Identities → Nostr: profile, follow count and mute-list summary per proven key, Post a note, Update profile.
- **Tests.** Unit: `packages/browser/test/nostrSocial.test.ts` (parsing, bounds, mute rules, templates, relay client against a relay in the test process: EOSE, oversize frame, no EOSE, budget, abort, OK and refusals) and `nostrSocialEngine.test.ts` (refused without a verified proof or offline, cache with provenance and staleness, hints, pagination, mute, dropped when the proof goes, auto-load only with the setting, publication gating, draft binding, follow/unfollow/profile rebuilt from the current event). End-to-end `e2e/web/nostr-social.spec.ts`: three people, a relay inside the test process (`e2e/support/nostrRelay.ts`, Playwright routes the WebSocket), a NIP-07 signer injected in the page with a disposable key; the contact without the proof sees nothing and asks nothing; the other loads profile with picture, follows with hints, notes with one hidden by the mute list, then turns publication on and posts a note, updates the profile and unfollows/follows through the signer, with the relay receiving exactly those events.
- **Not done.** Reactions, replies, DMs, deletion, NIP-65 relay lists, the mute list's private part, publishing a mute list. The profile name is never used as the chat's name.
