# Identity presentation and public profiles

> 2026-09-26: **public profile lookup is back, on the rebuilt identity proofs** ([300](300-peer-proofs.md#implementation-2026-09-23-identity-proofs)). An identity card of a Nostr, Pubky or Bluesky identity with a current, verified proof shows that identity's public profile. The section below is the current state. The old `proof-*` protocol and its per-chat profile experiment (the history at the end) stay disabled.
>
> 2026-09-25: the one thing a profile publishes about itself for everyone is its DID ([3xx-did-dht](3xx-did-dht.md)): a did:dht under a key of its own, in a packet of its own, with the key alone unless the person lists identities in it. No record was merged into another key's packet.
>
> 2026-09-23: a verified Nostr proof's follows and notes are the [Nostr social layer](3xx-nostr-social.md), loaded on request; it shares this document's text sanitizing, fixed picture hosts and bounded re-encoding (`packages/browser/src/profiles/public.ts`).

## Public profiles on identity cards (2026-09-26)

**What the person sees.** An ID card wears the identity's picture (in the photo slot) and name. The rest goes where there is room: under the deck on the Identities page (`identity-public-profile`), on the back of a contact's card in the chat's identities panel (`chat-identity-public-profile`) and on the back of one's own card in the chat's picker (`composer-identity-public-profile`, without the bio): the handle, a short bio, followers and following where the network counts them, and "Loaded from <host> <when>". The header mark's tooltip adds the name. The card says the profile is what the account says about itself, not part of the proof, and that asking told that server this device's IP address. Cards of identities without a public profile (domain, OpenPGP, SSH, Bitcoin, OIDC accounts, DIDs) are unchanged: they keep the name their proof carries, if any.

**Only for a current, verified proof.** One's own proof until it expires; a contact's proof while this app's status for it is `verified` (not expired, withdrawn, revoked, unconfirmed or made with a previous key). The engine checks this before asking and again when the answer arrives; the UI shows a profile only on such a card.

**Lazily, one identity at a time.** A card asks (`loadPublicProfile {provider, subject}`) once it is on screen (IntersectionObserver), or when its header mark's tooltip opens. Nothing is fetched at startup, or for every contact at once. With the network off, nothing is asked and the kept copy is shown.

**Setting.** Settings → Security → **Load public profiles**, on by default (`settings.publicProfiles`, absent means on). Off: nothing is asked, no profile is shown, and what was kept is deleted.

### Readers (`packages/browser/src/profiles/readers.ts`)

Nothing else is looked up: the readers table has exactly these three providers.

- **Nostr** (`nostr`): the newest kind-0 of exactly the proven key, from the relays in the person's Nostr settings (by default `relay.damus.io` and `nos.lol`; never relays named in events or hints), signature, id, author, kind, time and size checked on a copy (`nostr/relay.ts` `checkedEvent`), content at most 8 KiB, frames at most 16 KiB, 20 events and 5 seconds per relay. `display_name` falls back to `name`; a different `name` is the handle. **Following** is the size of the newest kind-3 follow list of the same key (its distinct `p` tags; a list is read in frames up to 256 KiB and at most 2000 tags, else the count is left out). **Followers are not shown**: Nostr has no way to count them without trusting a counting service, and none is used. A picture is fetched only from the fixed Nostr picture hosts below; any other host leaves the mark in the photo slot.
- **Pubky** (`pubky`): the Pubky index, `https://nexus.pubky.app`, for exactly the proven key: `GET /v0/user/{z32}/details` (its `id` must be the key; a `deleted` account, or a 404 for an unindexed key, has no profile), `GET /v0/user/{z32}/counts` (`followers`, `following`; a failed or malformed answer only drops the counts) and, when `details.image` is set, the official avatar route `GET /static/avatar/{z32}`. Routes checked against [pubky-nexus 638e17f](https://github.com/pubky/pubky-nexus/blob/638e17f917a27259ffe32fd5a4157d1dae7d647c/nexus-webapi/src/routes/v0/endpoints.rs) ([UserCounts](https://github.com/pubky/pubky-nexus/blob/638e17f917a27259ffe32fd5a4157d1dae7d647c/nexus-common/src/models/user/counts.rs), [UserDetails](https://github.com/pubky/pubky-nexus/blob/638e17f917a27259ffe32fd5a4157d1dae7d647c/nexus-common/src/models/user/details.rs)). This is **indexed public metadata**, not a response the key signed. A name equal to the key is dropped.
- **Bluesky / AT Protocol** (`atproto`): Bluesky's public AppView, `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor={did}`, no account needed: `did` must be the proven DID; `displayName`, `handle` (dropped when the AppView says `handle.invalid`), `description`, `followersCount`, `followsCount`. A 400 `InvalidRequest`/`NotFound`/`AccountTakedown`/`AccountDeactivated` means no profile. **The picture**: the AppView names it on `cdn.bsky.app`, but that CDN sends no `Access-Control-Allow-Origin` header (checked 2026-09-26), so no page can read it. Its CID, taken only from a CDN URL of exactly `https://cdn.bsky.app/img/avatar/plain/{the same did}/{cid}`, is read as a blob from the account's own server: the PDS its DID document names (the PLC directory, or did:web), the same server the proof was verified against, after the same public-address check (`assertPublicServer`), with `com.atproto.sync.getBlob?did=…&cid=…` (CORS open). A picture larger than the cap below simply leaves the mark.

Every HTTP request goes through the engine's identity fetch (`proofs/verify.ts` `boundedIdentityFetch`): HTTPS GET only, no credentials, cookies or referrer, redirects refused, a time-out, refused offline, and a size cap per request.

### Fixed hosts

| Host | Why | What |
|---|---|---|
| Nostr relays in the person's settings (defaults `relay.damus.io`, `nos.lol`) | where Nostr profiles are | kind 0 and kind 3 of the proven key |
| `nostr.build`, `image.nostr.build`, `i.nostr.build`, `media.nostr.band`, `pfp.nostr.build` | common Nostr picture hosts, unchanged from the first version | a profile picture |
| `nexus.pubky.app` | Pubky's public index, the only source of Pubky profiles | details, counts, avatar |
| `public.api.bsky.app` | Bluesky's public AppView: profiles and counts without an account, CORS open | `app.bsky.actor.getProfile` |
| the account's own PDS (from its DID document) | `cdn.bsky.app` cannot be read by a page (no CORS); the PDS holds the same blob and was already asked during verification | `com.atproto.sync.getBlob` for the avatar's CID |

`cdn.bsky.app` is never asked. No host comes from the profile data itself except as described (a Nostr picture URL on a fixed host; a Bluesky CID).

### Untrusted metadata

Everything is self-described by the account and treated as plain text, never HTML: names and handles at most 64 characters (a Pubky or Bluesky name over 256 characters is refused outright), controls and bidi overrides removed; bios at most 280 characters (newlines kept, other controls and bidi overrides removed); counts only as whole numbers from 0 to one billion. JSON answers are capped at 16 KiB. Pictures: at most 256 KiB downloaded, PNG or JPEG only (by their bytes, not their content type), dimensions read from the header and refused over 2048 per side or four million pixels **before** decoding, then re-encoded to a 96×96 JPEG of at most 32 KiB kept as a `data:` URL. SVG, HTML, WebP and anything else is never decoded. The page only ever renders that data URL.

### Cache (`packages/browser/src/engine/publicProfiles.ts`)

The engine owns it, in IndexedDB (settings store, key `publicProfiles`), one entry per provider and subject (a profile is the same whichever chat shared it), at most 64 (the least recently asked go first). A profile found is asked again after 24 hours, a miss or a failure no sooner than five minutes (also for an explicit `force`); concurrent requests share one read. A failed refresh keeps the previous copy and reports the error. Offline, the kept copy is shown while the proof stays current. Entries are dropped when their identity stops being eligible (every ten minutes, and whenever identities change: expiry, removal, withdrawal, revocation, a replaced key), and all of them when the setting is turned off.

### Tests

`packages/browser/test/publicProfileReaders.test.ts` (per provider: happy path, forged and other-key Nostr events, oversized content, Pubky id mismatch, deleted and unindexed accounts, Bluesky DID mismatch, `handle.invalid`, avatars named for another DID or host, a PDS on a private address, broken counts, SVG pictures, size caps, bidi and control stripping), `publicProfilesCache.test.ts` (eligibility, cadence, failure, restart, pruning, late answers, the setting, the bound), `publicProfilesEngine.test.ts` (the setting and the RPC gate in the engine), `src/test/identities/publicProfiles.test.tsx` (cards with and without a profile, states, lazy request, tooltip, Settings). e2e `e2e/web/public-profiles.spec.ts`: Nostr through the in-process test relay answering the default relays (own card, a contact's card, the setting, withdrawal); Pubky against the e2e Pubky testnet with the index answered by the test; Bluesky against the e2e PDS with the AppView answered by the test. Every e2e peer refuses the real profile hosts (`e2e/support/fixtures.ts` `guardPublicProfiles`).

## History: the 2026-09-20 experiment (legacy `proof-*`, disabled)

> Release decision (2026-09-21): external identity proofs and external profile lookup were deferred; this experiment's per-chat profiles stayed off with the `proof-*` protocol (`EXTERNAL_IDENTITIES_ENABLED`). What follows describes it as it was; stored data is preserved.

2026-09-20. Experimental paired-chat UI increment; WISPs remain Draft. No proof format, participation pin or transport negotiation changed.

### What the user sees

The conversation's **Identities** action has a fixed-height row, separate from connection controls. The dialog starts with the default Ghostly identity, then compact cards grouped by who shared them. Brand marks identify ecosystems, not partnerships or civil identity. **Key verified** means an accepted, unexpired signature for the current participation. Public keys and precise times are in keyboard/touch-accessible Details. Share is an explicit action for this contact; local import warnings remain visible before the secret field. Withdrawal has a short contextual notice that existing remote copies cannot be erased.

An accepted identity may supply a public name and avatar for the header and chat list. A manually chosen nickname always wins over a public name. **Name & photo in this chat** lets the user choose a presented identity or return to Ghostly/nickname; this preference is local and never changes cryptographic identity. Profile names are also searchable locally. No identities are inferred from a name/photo, and contacts are never merged.

### Real provider contracts

- **Nostr:** reads only kind-0 events for the exact presented public key, from two fixed public relays (`relay.damus.io`, `nos.lol`). Verifies event ID/signature, kind, author, timestamp and bounds before parsing. Chooses newest verified metadata, with lexicographic ID tie-break per [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md). `display_name` falls back to `name`; metadata is self-described. Verification never trusts an SDK verification symbol attached to a caller-owned object.
- **Pubky (local import or accepted modified-Ring proof):** reads `https://nexus.pubky.app/v0/user/{z32}/details`, requires matching `id`, and uses the official `/static/avatar/{id}` route only when the index reports an image. This is **indexed public metadata**, not an independently user-signed response or a Ring login. Source: [Nexus UserDetails](https://github.com/pubky/pubky-nexus/blob/74880a19a0d6b58544814a5858a22a1835f9bd1d/nexus-common/src/models/user/details.rs), [API handler](https://github.com/pubky/pubky-nexus/blob/74880a19a0d6b58544814a5858a22a1835f9bd1d/nexus-webapi/src/routes/v0/user/details.rs), [official avatar URL utility](https://github.com/pubky/pubky-app/blob/b35cf7a59865758218868a9c626bf529aa5403bf/src/components/organisms/AvatarWithFallback/AvatarWithFallback.utils.ts). A generated/imported key may have no indexed account, which is a normal fallback.
- **Keet-compatible imported key:** no public profile lookup is implemented. There is no verified existing-app profile API in this integration. A compatible key alone never produces a fabricated name, photo or Keet account badge.

All lookups require an accepted, unexpired **remote** proof matching both current participation keys. Nothing about the local user's other identities, chat messages, history or secret keys is sent. Public relays/index/CDNs necessarily see the lookup and network address. This is public metadata retrieval, not an anonymity guarantee.

### Cache and lifecycle

The engine owns requests and IndexedDB updates. At startup and proof updates it refreshes eligible records without blocking chat. Requests deduplicate per conversation; successful entries normally have a 24-hour refresh interval, misses and explicit retries have a five-minute minimum. Offline settings skip lookups. The stored per-conversation cache holds at most one entry per adapter (four total, including the distinct modified-Ring adapter), including public identifier, source, name, normalized avatar, fetched/checked timestamps and Nostr event ID/time. A failed refresh preserves a previous successful copy. The UI consumes engine state without fetching on render.

An offline app can still display cached metadata while its proof remains current. Removal, expiry, a changed participation or a changed external key immediately removes that profile from the chat presentation and its origin badge. The cached entry is not presented as currently verified and is never silently attached to another contact. A fresh accepted proof for the same key can reuse its local cache. Deleting the conversation removes the containing link row and avatar cache. No cloud profile sync or avatar upload is added.

### Untrusted metadata and images

Names are plain React text, limited to 64 characters after rejecting oversized input and removing controls/bidi overrides. JSON responses are capped at 16 KiB; Nostr content is capped at 8 KiB. WebSocket work has a five-second deadline and a 20-frame bound per relay.

Avatar fetches use exact fixed HTTPS hosts only: `nostr.build`, `image.nostr.build`, `i.nostr.build`, `media.nostr.band`, `pfp.nostr.build`, `nexus.pubky.app`. No arbitrary relay/URL discovery, credentials, custom ports, cookies, referrer, redirects, localhost or private-IP targets are accepted. The fixed infrastructure remains a trust assumption; arbitrary image hosts deliberately fall back to initials.

Only bounded PNG/JPEG raster data is decoded: maximum 256 KiB download, dimensions at most 2048 per side and four million pixels, checked before decoding. SVG, HTML and unsupported formats (including WebP in this first version) are not executed or rendered. Images are re-encoded to 96×96 JPEG, at most 32 KiB, saved as local data URLs and reused without repeat image requests. If CORS, CSP, network availability, OffscreenCanvas or decoding prevents caching, the name/initials remain usable. No CSP or host permission expansion was required for this increment.

Bundled ecosystem logos come from verified source assets, listed in `src/assets/identities/SOURCES.md`; they are static image resources, never injected markup.

### Validation and isolated fixture

`publicProfiles.test.ts` covers signed Nostr metadata and a real local WebSocket fixture, forged/wrong-author/future/oversized events, Pubky ID mismatch, no Keet profile, unsafe URLs, bounded images/streams, local cache persistence/deletion, selection/scope/expiry/withdrawal, and offline fallback. Existing signer/import tests remain passing.

For native UI QA, `vite.profile-fixture.config.ts` explicitly substitutes only the engine profile lookup with `test/helpers/publicProfileFixture.ts`. The local signer at port 5189 generates a disposable key and signs its kind-0 name; its avatar is the existing Ghostly test icon, not a person's photo. The fixture fetches only its fixed loopback endpoint. **Normal builds never import this module or use this configuration.** Final native/web/extension bundles use normal configuration; a persisted disposable fixture profile is intentionally left in the isolated peer app to demonstrate offline cache. No public metadata event was published.

Observed native UI: signed fixture profile appeared in header/list/card; choosing Ghostly restored Anonymous; choosing automatic restored the profile; a manual nickname took precedence without removing the photo, then was reset to its original empty value. Withdrawing the Nostr proof removed name/avatar/origin immediately while Keet remained verified. A fresh explicit Nostr proof restored the cached profile. Dialogs were inspected at wide and approximately 430px widths; keyboard Tab/Space opened a disclosure, and Escape closed the dialog.
