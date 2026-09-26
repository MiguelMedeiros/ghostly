# Identity presentation and public profiles

> 2026-09-26 (later still): **a contact can be shown as one of their identities.** The identities panel's **Show as** picks one of the contact's verified identities with a public profile; the chat list, the chat's header and group mentions then use that profile's name and photo, with the provider's mark on the avatar's corner. A nickname given in the chat always keeps the name. The marks beside a contact's name open a small card (the identity's picture, name, handle, state and source) on hover, keyboard focus or a long press. See [Name and photo of a contact](#name-and-photo-of-a-contact-2026-09-26).
>
> 2026-09-26 (later): **the picture reaches the card.** #292's cards kept the provider's mark for most identities: the Pubky index serves every avatar as WebP, which was never decoded, and most Nostr pictures were on hosts outside the list, or behind a redirect the list refused. WebP is decoded now, the picture hosts are the ones Nostr profiles actually use (a sample below), the size cap is larger, and a picture that is still refused says which rule refused it. The header's marks wear the picture too. See [Pictures](#pictures).
>
> 2026-09-26: **public profile lookup is back, on the rebuilt identity proofs** ([300](300-peer-proofs.md#implementation-2026-09-23-identity-proofs)). An identity card of a Nostr, Pubky or Bluesky identity with a current, verified proof shows that identity's public profile. The section below is the current state. The old `proof-*` protocol and its per-chat profile experiment (the history at the end) stay disabled.
>
> 2026-09-25: the one thing a profile publishes about itself for everyone is its DID ([3xx-did-dht](3xx-did-dht.md)): a did:dht under a key of its own, in a packet of its own, with the key alone unless the person lists identities in it. No record was merged into another key's packet.
>
> 2026-09-23: a verified Nostr proof's follows and notes are the [Nostr social layer](3xx-nostr-social.md), loaded on request; it shares this document's text sanitizing, fixed picture hosts and bounded re-encoding (`packages/browser/src/profiles/public.ts`).

## Public profiles on identity cards (2026-09-26)

**What the person sees.** An ID card wears the identity's picture (in the photo slot, the provider's mark as a small badge on its corner) and name; the chat header's mark for that identity wears the same picture, the provider's mark on its corner. Without a picture, while it loads, or when a rule below refuses it, the photo slot and the mark show the provider's mark as before. The rest goes where there is room: under the deck on the Identities page (`identity-public-profile`), on the back of a contact's card in the chat's identities panel (`chat-identity-public-profile`) and on the back of one's own card in the chat's picker (`composer-identity-public-profile`, without the bio): the handle, a short bio, followers and following where the network counts them, and "Loaded from <host> <when>". The header mark's tooltip adds the name. The card says the profile is what the account says about itself, not part of the proof, and that asking told that server this device's IP address. Cards of identities without a public profile (domain, OpenPGP, SSH, Bitcoin, OIDC accounts, DIDs) are unchanged: they keep the name their proof carries, if any.

**Only for a current, verified proof.** One's own proof until it expires; a contact's proof while this app's status for it is `verified` (not expired, withdrawn, revoked, unconfirmed or made with a previous key). The engine checks this before asking and again when the answer arrives; the UI shows a profile only on such a card.

**Lazily, one identity at a time.** A card asks (`loadPublicProfile {provider, subject}`) once it is on screen (IntersectionObserver), or when its header mark's tooltip opens. Nothing is fetched at startup, or for every contact at once. With the network off, nothing is asked and the kept copy is shown.

**Setting.** Settings → Security → **Load public profiles**, on by default (`settings.publicProfiles`, absent means on). Off: nothing is asked, no profile is shown, and what was kept is deleted.

### Readers (`packages/browser/src/profiles/readers.ts`)

Nothing else is looked up: the readers table has exactly these three providers.

- **Nostr** (`nostr`): the newest kind-0 of exactly the proven key, from the relays in the person's Nostr settings (by default `relay.damus.io` and `nos.lol`; never relays named in events or hints), signature, id, author, kind, time and size checked on a copy (`nostr/relay.ts` `checkedEvent`), content at most 8 KiB, frames at most 16 KiB, 20 events and 5 seconds per relay. `display_name` falls back to `name`; a different `name` is the handle. **Following** is the size of the newest kind-3 follow list of the same key (its distinct `p` tags; a list is read in frames up to 256 KiB and at most 2000 tags, else the count is left out). **Followers are not shown**: Nostr has no way to count them without trusting a counting service, and none is used. A picture is fetched only from the fixed picture hosts below; any other host leaves the mark in the photo slot, and the details say so ("it is on example.com, a host this app does not load pictures from").
- **Pubky** (`pubky`): the Pubky index, `https://nexus.pubky.app`, for exactly the proven key: `GET /v0/user/{z32}/details` (its `id` must be the key; a `deleted` account, or a 404 for an unindexed key, has no profile), `GET /v0/user/{z32}/counts` (`followers`, `following`; a failed or malformed answer only drops the counts) and, when `details.image` is set, the official avatar route `GET /static/avatar/{z32}`, which answers a WebP whatever the account uploaded (checked against five accounts on 2026-09-26: always `image/webp`, extended `VP8X`, CORS `*`, no redirect). Routes checked against [pubky-nexus 638e17f](https://github.com/pubky/pubky-nexus/blob/638e17f917a27259ffe32fd5a4157d1dae7d647c/nexus-webapi/src/routes/v0/endpoints.rs) ([UserCounts](https://github.com/pubky/pubky-nexus/blob/638e17f917a27259ffe32fd5a4157d1dae7d647c/nexus-common/src/models/user/counts.rs), [UserDetails](https://github.com/pubky/pubky-nexus/blob/638e17f917a27259ffe32fd5a4157d1dae7d647c/nexus-common/src/models/user/details.rs)). This is **indexed public metadata**, not a response the key signed. A name equal to the key is dropped.
- **Bluesky / AT Protocol** (`atproto`): Bluesky's public AppView, `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor={did}`, no account needed: `did` must be the proven DID; `displayName`, `handle` (dropped when the AppView says `handle.invalid`), `description`, `followersCount`, `followsCount`. A 400 `InvalidRequest`/`NotFound`/`AccountTakedown`/`AccountDeactivated` means no profile. **The picture**: the AppView names it on `cdn.bsky.app`, but that CDN sends no `Access-Control-Allow-Origin` header (checked 2026-09-26), so no page can read it. Its CID, taken only from a CDN URL of exactly `https://cdn.bsky.app/img/avatar/plain/{the same did}/{cid}`, is read as a blob from the account's own server: the PDS its DID document names (the PLC directory, or did:web), the same server the proof was verified against, after the same public-address check (`assertPublicServer`), with `com.atproto.sync.getBlob?did=…&cid=…` (CORS open). A picture larger than the cap below leaves the mark.

Every HTTP request goes through the engine's identity fetch (`proofs/verify.ts` `boundedIdentityFetch`): HTTPS GET only, no credentials, cookies or referrer, redirects refused, a time-out, refused offline, and a size cap per request.

### Fixed hosts

| Host | Why | What |
|---|---|---|
| Nostr relays in the person's settings (defaults `relay.damus.io`, `nos.lol`) | where Nostr profiles are | kind 0 and kind 3 of the proven key |
| the picture hosts under [Pictures](#pictures) | where Nostr profiles keep their pictures | a profile picture |
| `nexus.pubky.app` | Pubky's public index, the only source of Pubky profiles | details, counts, avatar |
| `public.api.bsky.app` | Bluesky's public AppView: profiles and counts without an account, CORS open | `app.bsky.actor.getProfile` |
| the account's own PDS (from its DID document) | `cdn.bsky.app` cannot be read by a page (no CORS); the PDS holds the same blob and was already asked during verification | `com.atproto.sync.getBlob` for the avatar's CID |

`cdn.bsky.app` is never asked. No host comes from the profile data itself except as described (a Nostr picture URL on a fixed host; a Bluesky CID). The card's "Loaded from" names every host asked, the picture's included.

### Untrusted metadata

Everything is self-described by the account and treated as plain text, never HTML: names and handles at most 64 characters (a Pubky or Bluesky name over 256 characters is refused outright), controls and bidi overrides removed; bios at most 280 characters (newlines kept, other controls and bidi overrides removed); counts only as whole numbers from 0 to one billion. JSON answers are capped at 16 KiB. Pictures: see [Pictures](#pictures). The page only ever renders a re-encoded `data:` URL.

### Pictures

**Decoding.** At most 2 MiB downloaded; PNG, JPEG or WebP (lossy `VP8 `, lossless `VP8L`, extended `VP8X`), recognised by their bytes, not their content type; dimensions read from the header and refused over 2048 per side or four million pixels **before** anything is decoded; then the middle square is re-encoded to a 160×160 JPEG of at most 32 KiB, kept as a `data:` URL (chat avatars from the Nostr social layer stay 96×96). SVG, HTML, GIF, AVIF and anything else is never decoded. WebP was left out of the first version as a first-version limit only: every browser engine the app runs in decodes it (Chromium, WebKit on macOS 11+, WebKitGTK), the header check comes before the decoder sees a byte, and the Pubky index serves nothing else. The 256 KiB cap of the first version dropped more than a quarter of the pictures on listed hosts (45 of 160 downloaded from the sample below); 2 MiB drops about one in twenty (9 of 160). With the pixel caps it bounds both the download and the decode, and it happens once a day per identity, only for a card on screen.

**Hosts.** A fixed list (`packages/browser/src/profiles/public.ts` `IMAGE_HOSTS`), HTTPS on port 443, no credentials, cookies or referrer:

| Hosts | Share of a sample |
|---|---|
| `nostr.build`, `image.nostr.build`, `i.nostr.build`, `pfp.nostr.build`, `cdn.nostr.build`, `media.nostr.band` | 38% |
| `m.primal.net`, `blossom.primal.net` (Primal) | 23% |
| `pbs.twimg.com`, `avatars.githubusercontent.com`, `i.imgur.com`, `files.mastodon.social` | 11% |
| `blossom.ditto.pub`, `cdn.nostrcheck.me`, `nostrcheck.me`, `nostr.download`, `cdn.azzamo.media` (Blossom and NIP-96 servers) | 2% |
| `nexus.pubky.app` | Pubky's avatars |

The sample (2026-09-26): the kind-0 pictures of the 1,392 accounts three well-known Nostr accounts follow, 1,249 with a picture, read from relay.damus.io, nos.lol and relay.primal.net. The first version's five hosts covered 37% of them on paper and 28% in practice, since `nostr.build/i/…` links redirect. The new list covers about 74%. Every listed host was checked to answer a page (a CORS header) with PNG, JPEG or WebP; hosts that do not (`profilepics.nostur.com`, most of `void.cat` is gone) are left out, since no page could read them.

**Why a list and not any host.** A picture URL is chosen by the account. With any host allowed, whoever shares an identity could point its picture at a server of their own and learn when, and from which IP address, each contact looks at the card: a tracking pixel. The listed hosts are large shared media services that hold many people's pictures, where the account owner does not read the logs. The rest of the long tail (personal sites, small servers, bot avatar generators) keeps the mark. A host is added when a sample shows real profiles use it, it answers pages, and it is a shared service rather than one person's server.

**Redirects.** Refused (`redirect: "error"`), with two fixed exceptions:
- nostr.build's short links (`nostr.build/i/<file>`, `cdn.nostr.build/i/<file>`) redirect to `image.nostr.build/<file>` without a CORS header, so no page could follow them: the link is rewritten to where it redirects, and only image.nostr.build is asked.
- Primal's `m.primal.net` and `blossom.primal.net` answer with a redirect to Primal's own storage (`r2a.primal.net`, `primal.b-cdn.net`). The browser follows it, and the answer is used only when it came from one of those two; from anywhere else it is refused (that host may have been reached, since the browser follows a redirect before the app sees it).

**Why a picture is missing.** When a profile names a picture that is not shown, the reader says which rule refused it (`avatarMiss`: the host, the format, the size, the dimensions, a redirect, the host's answer, a decoding failure), the engine logs it without the identity (`Public profile (nostr): the picture is not shown: it is a GIF; only PNG, JPEG and WebP pictures are shown.`), and the card's details show it.

**Content Security Policy.** The engine fetches the picture (`connect-src`, which allows `https:` in the Desktop, web and extension policies) and the page shows only the re-encoded `data:` URL (`img-src data:` in all three). No policy names an image host; `src/test/security/contentSecurityPolicy.test.ts` checks every listed host against the three policies.

**Cached copies.** Profiles kept by the earlier readers (no WebP, fewer hosts) are asked again on the next look instead of after a day (`READERS_VERSION`).

### Cache (`packages/browser/src/engine/publicProfiles.ts`)

The engine owns it, in IndexedDB (settings store, key `publicProfiles`), one entry per provider and subject (a profile is the same whichever chat shared it), at most 64 (the least recently asked go first). A profile found is asked again after 24 hours (sooner when it was kept by an older version of the readers, `READERS_VERSION`), a miss or a failure no sooner than five minutes (also for an explicit `force`); concurrent requests share one read. A failed refresh keeps the previous copy and reports the error. Offline, the kept copy is shown while the proof stays current. Entries are dropped when their identity stops being eligible (every ten minutes, and whenever identities change: expiry, removal, withdrawal, revocation, a replaced key), and all of them when the setting is turned off.

### Tests

`packages/browser/test/profileAvatars.test.ts` (real PNG, JPEG and WebP fixtures from `e2e/support/avatar-fixtures/`: header dimensions, middle-square crop, GIF/SVG/page refused undecoded, byte and pixel caps, hosts, the nostr.build rewrite, redirects refused or followed only to Primal's storage, each reason), `packages/browser/test/publicProfileReaders.test.ts` (per provider, the Pubky avatar as the index serves it (extended WebP); happy path, forged and other-key Nostr events, oversized content, Pubky id mismatch, deleted and unindexed accounts, Bluesky DID mismatch, `handle.invalid`, avatars named for another DID or host, a PDS on a private address, broken counts, SVG pictures, size caps, bidi and control stripping), `publicProfilesCache.test.ts` (eligibility, cadence, failure, restart, pruning, late answers, the setting, the bound), `publicProfilesEngine.test.ts` (the setting and the RPC gate in the engine), `src/test/identities/publicProfiles.test.tsx` (cards with and without a profile, states, lazy request, tooltip, Settings), `src/test/identities/contactFace.test.tsx` (the marks' card on hover, focus and long press without opening the chat; Show as, the offer, the nickname's precedence, fallback on expiry, revocation and withdrawal, search, group mentions, name cleaning), `src/test/identities/identityPhotos.test.tsx` (the photo and its corner badge on the Identities page, the composer's picker, the contact's panel and the header's marks; the mark alone without a picture, while loading, when refused, after expiry or revocation). e2e `e2e/web/public-profiles.spec.ts`: Nostr through the in-process test relay answering the default relays (own card, a contact's card and its header mark wearing a WebP picture from a nostr.build short link, the setting, withdrawal); Pubky against the e2e Pubky testnet with the index answered by the test, its avatar an extended WebP as the real index serves it; Bluesky against the e2e PDS with the AppView answered by the test. Every e2e peer refuses the real profile hosts, every listed picture host included (`e2e/support/fixtures.ts` `guardPublicProfiles`). A redirect answered by a Playwright route is not intercepted on its second leg, so Primal's redirects are covered by the unit tests only.

## Name and photo of a contact (2026-09-26)

What the 2026-09-20 experiment sketched ("an accepted identity may supply a public name and avatar for the header and chat list; a manually chosen nickname always wins"), on the rebuilt proofs (`src/components/identities/contactFace.ts`).

**Choosing.** The contact's identities panel opens with **Show as** (`contact-face`): a select (`contact-face-select`) of **Ghostly (none)** and each of the contact's identities that is verified now (verified or expiring, `contactBadges.ts`), has a reader (Nostr, Pubky, Bluesky) and whose public profile has a name or a picture. When the contact has exactly one such identity, the user gave them no nickname and nothing was chosen yet (not even Ghostly), a one-tap **Use Pubky name & photo** (`contact-face-suggest`) offers it. It is not applied by itself: the name in the chat list is how a person finds a chat, and a name changing under them because a contact shared a proof would be a surprise; one tap is enough. Choosing Ghostly ends the offer.

**Precedence.** Name: a nickname the user gave the chat (its label) always wins; then the chosen identity's profile name; then the name the contact goes by; then "Contact · xxxxxx". Photo: the chosen identity's picture, even under a nickname; else the picture the contact sent; else the initial or the key's pattern. A chosen identity puts its provider's mark on the avatar's corner (`contact-face-corner`) in the chat list and the header. In a group, a member who is a contact goes by the chosen identity's name in messages, events and mentions, unless the user gave that contact a nickname (groups keep the name they know the member by).

**Where it applies.** The chat list row (and its search: the shown name is searched too), the chat's header, and group messages, events and mentions. The row's tooltip, the header mark's card ("Shown with their Pubky profile · Ghostly key …") and the Ghostly card in the panel keep the Ghostly key.

**Only while the proof holds.** The chosen identity is shown only while its proof is verified now, its public profile was found and Load public profiles is on. Expiry, revocation, withdrawal, a proof made with a previous key, a check that failed, or the profile gone: the contact falls back at once to the nickname or their own name, and the panel says why ("That profile's proof no longer holds"). The choice itself is kept, so a renewed proof of the same identity is shown again; a different key is a different identity and never inherits it.

**Safety.** The name is plain text, cleaned again before it names a contact: control, format and bidi characters removed (including the marks and isolates the engine's cleaning leaves), whitespace folded, at most 64 characters; it is rendered inside `<bdi>`. The photo is the engine's re-encoded `data:image/` URL (see Pictures); nothing else is shown.

**Storage.** One key per contact key in this profile's local storage (`<prefix>face_<contact key>`): the identity's provider and subject, or `none`. Never sent to the contact or anywhere else; deleted with the contact's last chat.

**Reads.** A row or a header whose contact has a chosen identity asks for that identity's profile (`loadPublicProfile`), as a card on screen does. The engine answers from its cache while the copy is fresh (a day), so this reaches the network at most once a day per chosen identity, and never for contacts nobody chose a profile for. The panel asks for the profiles of the contact's verified identities so the choice has names and pictures.

### The marks' card

The chat list's marks (`contact-marks`) and the header's stack (`chat-identity-badges`) open the same card (`IdentityTip.tsx`; `contact-marks-tip`, `chat-identity-tip`): per identity, its profile picture with the provider's mark on its corner (or the provider's mark alone), its profile name (or its subject), the provider and handle, its state and when ("Verified 2 hr. ago") and "Loaded from <host>". A mouse opens it after resting 300 ms on a mark (moving to the next mark while it is open is at once), keyboard focus opens it for every mark at once, and a long press (450 ms) on a touch screen opens it for three seconds. The card never takes the pointer and opening it never opens the chat: the click that ends a long press is eaten. The row's own tooltip (its name and key) is kept off the marks (`title=""`), and keyboard focus on the marks does not raise the row's actions (their layer shows on focus inside itself only). Opening a card asks for the profiles it shows, as before.

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
