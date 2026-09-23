# Identity presentation and local public profiles

> Release decision (2026-09-21): external identity proofs and external profile lookup are deferred. This release exposes only Ghostly participation identity. Nostr, Pubky, Keet, imports and Ring UI are disabled; previous experiments and stored data are preserved for future work. Descriptions below are historical/research, not available release features.
>
> 2026-09-23: new Nostr proofs use the rebuilt [identity proofs](300-peer-proofs.md#implementation--2026-09-23-identity-proofs) instead; this `proof-*` protocol stays disabled.

2026-09-20. Experimental paired-chat UI increment; WISPs remain Draft. No proof format, participation pin or transport negotiation changed.

## What the user sees

The conversation's **Identities** action has a fixed-height row, separate from connection controls. The dialog starts with the default Ghostly identity, then compact cards grouped by who shared them. Brand marks identify ecosystems, not partnerships or civil identity. **Key verified** means an accepted, unexpired signature for the current participation. Public keys and precise times are in keyboard/touch-accessible Details. Share is an explicit action for this contact; local import warnings remain visible before the secret field. Withdrawal has a short contextual notice that existing remote copies cannot be erased.

An accepted identity may supply a public name and avatar for the header and chat list. A manually chosen nickname always wins over a public name. **Name & photo in this chat** lets the user choose a presented identity or return to Ghostly/nickname; this preference is local and never changes cryptographic identity. Profile names are also searchable locally. No identities are inferred from a name/photo, and contacts are never merged.

## Real provider contracts

- **Nostr:** reads only kind-0 events for the exact presented public key, from two fixed public relays (`relay.damus.io`, `nos.lol`). Verifies event ID/signature, kind, author, timestamp and bounds before parsing. Chooses newest verified metadata, with lexicographic ID tie-break per [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md). `display_name` falls back to `name`; metadata is self-described. Verification never trusts an SDK verification symbol attached to a caller-owned object.
- **Pubky (local import or accepted modified-Ring proof):** reads `https://nexus.pubky.app/v0/user/{z32}/details`, requires matching `id`, and uses the official `/static/avatar/{id}` route only when the index reports an image. This is **indexed public metadata**, not an independently user-signed response or a Ring login. Source: [Nexus UserDetails](https://github.com/pubky/pubky-nexus/blob/74880a19a0d6b58544814a5858a22a1835f9bd1d/nexus-common/src/models/user/details.rs), [API handler](https://github.com/pubky/pubky-nexus/blob/74880a19a0d6b58544814a5858a22a1835f9bd1d/nexus-webapi/src/routes/v0/user/details.rs), [official avatar URL utility](https://github.com/pubky/pubky-app/blob/b35cf7a59865758218868a9c626bf529aa5403bf/src/components/organisms/AvatarWithFallback/AvatarWithFallback.utils.ts). A generated/imported key may have no indexed account, which is a normal fallback.
- **Keet-compatible imported key:** no public profile lookup is implemented. There is no verified existing-app profile API in this integration. A compatible key alone never produces a fabricated name, photo or Keet account badge.

All lookups require an accepted, unexpired **remote** proof matching both current participation keys. Nothing about the local user's other identities, chat messages, history or secret keys is sent. Public relays/index/CDNs necessarily see the lookup and network address. This is public metadata retrieval, not an anonymity guarantee.

## Cache and lifecycle

The engine owns requests and IndexedDB updates. At startup and proof updates it refreshes eligible records without blocking chat. Requests deduplicate per conversation; successful entries normally have a 24-hour refresh interval, misses and explicit retries have a five-minute minimum. Offline settings skip lookups. The stored per-conversation cache holds at most one entry per adapter (four total, including the distinct modified-Ring adapter), including public identifier, source, name, normalized avatar, fetched/checked timestamps and Nostr event ID/time. A failed refresh preserves a previous successful copy. The UI consumes engine state without fetching on render.

An offline app can still display cached metadata while its proof remains current. Removal, expiry, a changed participation or a changed external key immediately removes that profile from the chat presentation and its origin badge. The cached entry is not presented as currently verified and is never silently attached to another contact. A fresh accepted proof for the same key can reuse its local cache. Deleting the conversation removes the containing link row and avatar cache. No cloud profile sync or avatar upload is added.

## Untrusted metadata and images

Names are plain React text, limited to 64 characters after rejecting oversized input and removing controls/bidi overrides. JSON responses are capped at 16 KiB; Nostr content is capped at 8 KiB. WebSocket work has a five-second deadline and a 20-frame bound per relay.

Avatar fetches use exact fixed HTTPS hosts only: `nostr.build`, `image.nostr.build`, `i.nostr.build`, `media.nostr.band`, `pfp.nostr.build`, `nexus.pubky.app`. No arbitrary relay/URL discovery, credentials, custom ports, cookies, referrer, redirects, localhost or private-IP targets are accepted. The fixed infrastructure remains a trust assumption; arbitrary image hosts deliberately fall back to initials.

Only bounded PNG/JPEG raster data is decoded: maximum 256 KiB download, dimensions at most 2048 per side and four million pixels, checked before decoding. SVG, HTML and unsupported formats (including WebP in this first version) are not executed or rendered. Images are re-encoded to 96×96 JPEG, at most 32 KiB, saved as local data URLs and reused without repeat image requests. If CORS, CSP, network availability, OffscreenCanvas or decoding prevents caching, the name/initials remain usable. No CSP or host permission expansion was required for this increment.

Bundled ecosystem logos come from verified source assets, listed in `src/assets/identities/SOURCES.md`; they are static image resources, never injected markup.

## Validation and isolated fixture

`publicProfiles.test.ts` covers signed Nostr metadata and a real local WebSocket fixture, forged/wrong-author/future/oversized events, Pubky ID mismatch, no Keet profile, unsafe URLs, bounded images/streams, local cache persistence/deletion, selection/scope/expiry/withdrawal, and offline fallback. Existing signer/import tests remain passing.

For native UI QA, `vite.profile-fixture.config.ts` explicitly substitutes only the engine profile lookup with `test/helpers/publicProfileFixture.ts`. The local signer at port 5189 generates a disposable key and signs its kind-0 name; its avatar is the existing Ghostly test icon, not a person's photo. The fixture fetches only its fixed loopback endpoint. **Normal builds never import this module or use this configuration.** Final native/web/extension bundles use normal configuration; a persisted disposable fixture profile is intentionally left in the isolated peer app to demonstrate offline cache. No public metadata event was published.

Observed native UI: signed fixture profile appeared in header/list/card; choosing Ghostly restored Anonymous; choosing automatic restored the profile; a manual nickname took precedence without removing the photo, then was reset to its original empty value. Withdrawing the Nostr proof removed name/avatar/origin immediately while Keet remained verified. A fresh explicit Nostr proof restored the cached profile. Dialogs were inspected at wide and approximately 430px widths; keyboard Tab/Space opened a disclosure, and Escape closed the dialog.
