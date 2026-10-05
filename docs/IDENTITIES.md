# Identities

How a Ghostly profile proves who it is to a contact, and how a contact's identities show in the app. Specs: [WISP 300 Identity Proofs](wisps/300-peer-proofs.md) and the provider WISPs linked below. Writing a provider: [PROOFS.md](../packages/browser/src/proofs/PROOFS.md).

## Profiles

- A device holds several **local profiles** ([WISP 04](wisps/04-profiles.md), `apps/ui/src/lib/profiles.ts`). Each has its own chats, contacts, settings, wallets and lock. Nothing about profiles is sent to a contact.
- Switch profiles from the account bar (Alt+Shift+P) or, on a phone, by holding the Settings tab (`apps/ui/src/components/ProfileSwitcher.tsx`).

### Profile DID (did:dht)

Every profile has a `did:dht` of its own ([WISP 310 Profile DID](wisps/310-did-dht.md), #247).

- Its own key, made once per profile and stored sealed in that profile's settings. No chat uses it (`packages/browser/src/engine/did.ts`, `packages/core/src/didDht.ts`).
- The document holds the key. It lists an identity (`alsoKnownAs`) only when the person turns that identity's switch on. Every switch starts off, and the packet is capped at 1000 bytes.
- Published 15 s after start, re-put unchanged every hour while the app runs, re-signed only when it changes.
- Web and extension put it on the Pkarr relays. Desktop publishes it through the `publish_signed_packet` command (granted to the main window in #299).
- UI: Identities → the Ghostly card → "Public DID" (Copy DID, Show QR code, the list switches).

## Identity proofs

A proof is shared inside a paired chat and **checked by the contact's app**, not by a server. Both sides must offer `identity-proof/1`; the steps are `idp-hello`, `idp-request`, `idp-challenge`, `idp-present`, `idp-result` and `idp-withdraw` (`packages/core/src/identityProofs.ts`). When the contact's own network fails the check, the sharer is told only "Your contact's app could not check it. Try again later." (#299).

Providers, in picker order (`packages/browser/src/proofs/registry.ts`):

| Provider | Proves | Made with | Checked by the contact | WISP |
|---|---|---|---|---|
| Nostr | a Nostr key | NIP-07 extension or NIP-46 bunker signs an event (never sent to a relay) | signature, locally | [301](wisps/301-nostr.md) |
| Pubky | a Pubky key | one request approved in Pubky Ring or Pubky Passport; a file on the homeserver | Pkarr records, then the file (port 443, public hosts only) | [302](wisps/302-pubky.md) |
| Domain | control of a domain | DNS TXT at `_ghostly.<domain>`, `/.well-known/ghostly.json`, or NIP-05 | DNS over HTTPS (Quad9, then Cloudflare, then Google) | [304](wisps/304-domain.md) |
| OpenPGP key | a PGP key | `gpg --clearsign` | locally; optional email check at keys.openpgp.org | [305](wisps/305-openpgp.md) |
| Bitcoin address | signing for an address | BIP-322 or legacy `signmessage` in the person's wallet | locally, no chain lookup | [306](wisps/306-bitcoin.md) |
| SSH key | an SSH key (FIDO keys too) | `ssh-keygen -Y sign -n ghostly` | locally | [307](wisps/307-ssh.md) |
| GitHub / GitLab (SSH key) | the account publishes that key | the same `ssh-keygen` step | the forge's public keys API | [307](wisps/307-ssh.md) |
| Account at a provider (OIDC) | the provider says the person signed in | popup sign-in | the provider's pinned JWKS | [3xx](wisps/3xx-oidc-proofs.md) |
| DID | did:key, did:jwk, did:dht or did:web | a pasted JWS or signature; a file for did:web | resolves the DID at every check | [311](wisps/311-did.md) |
| Bluesky / AT Protocol | an atproto account | OAuth on the person's PDS; one `tools.ghostly.proof` record | the signed record and the handle, both ways | [312](wisps/312-atproto.md) |

Notes:

- **OIDC is off in every build.** No provider (Google, Microsoft, Apple, GitLab, Twitch) has a client ID yet, so the option is neither offered nor accepted (`packages/browser/src/proofs/oidc/providers.ts`). Registration steps: [OIDC-PROVIDERS.md](OIDC-PROVIDERS.md).
- **DID** sits under Advanced in the New dialog and is marked experimental. It refuses the profile's own did:dht.
- The New dialog lists only providers that run on this platform and have a signer available now (for example, NIP-07 only with a browser signer).

## The Identities page

- Route `/identities` (`apps/ui/src/pages/Identities.tsx`), in the account bar and the phone's tab bar (#144).
- **New** in the page header opens the add dialog (#275).
- Sections: **Yours** (the Ghostly card first, then each proof), **From your contacts**, and Nostr once there is a key.
- Cards are an ID-card deck, the same deck as the wallets (`apps/ui/src/components/deck/`, faces in `apps/ui/src/components/identities/IdCardFace.tsx`).

## Sharing in a chat

- **+ → Identity** in a paired 1:1 chat opens the picker, a deck of your ID cards (#164). Groups have no identity picker.
- "Use …" turns the card over (#172). Its back offers **Share with {contact}**, **Stop sharing** or **Share again**. The picker closes after a share (#308).
- Each share shows in the timeline, on both sides, as the identity's ID card (the picker's card, `IdCardFace.tsx`) with "You shared this identity" / "{contact} shared this identity" and the time under it. The card's status corner is the share's state: Checking, Waiting, Not checked, Verified, Not verified, and later No longer shared or Revoked on the same card. With a mouse the card lifts and plays the deck's flourish once; it is a button that opens the identity's details (`apps/ui/src/components/identities/IdentityShareLine.tsx`, #308). A stop also adds a line after the card. These lines are local: never sent, never unread.

## A contact's identities

- **Marks** (`apps/ui/src/components/identities/ContactMarks.tsx`, #176): verified identities show as small marks in the chat list and group members (up to 2, then "+N").
- **Chat header** (#267): the marks open the contact's identities panel ("Identities with {name}"). With nothing shared, a quiet Ghostly mark still opens it.
- **Card on a mark** (#311): hover (300 ms), keyboard focus or a long press shows that identity's card.
- **Show as** (#311): in the panel, pick one of the contact's verified identities to use its name and photo in the chat list, header and mentions. Only on this device, never sent. Name order: your nickname, the chosen identity, the contact's own name, "Contact · xxxxxx".

## Public profiles and activity

- Verified **Nostr, Pubky and Bluesky** identities show their public profile on the card: picture, name, bio, followers (#292, #297). Sources: your Nostr relays, `nexus.pubky.app`, `public.api.bsky.app` (Bluesky pictures come from the account's PDS).
- Pictures load only from a list of known hosts (`packages/browser/src/profiles/public.ts`).
- **Contact activity** (#313): under the contact panel's deck, the chosen card shows its profile, "Follows you" / "You follow" chips and people you both know, and its recent posts (10 at a time, pictures on tap).
- Switch: Settings → Privacy & security → **Load public profiles** (on by default). Those servers see the device's IP. Off: cards show only what the proof carries, and loaded profiles are deleted.
- Presentation rules: [PUBLIC-PROFILES.md](wisps/PUBLIC-PROFILES.md). The Nostr social layer: [WISP 309](wisps/309-nostr-social.md).

## Code map

| What | Where |
|---|---|
| Wire exchange | `packages/core/src/identityProofs.ts` |
| Providers | `packages/browser/src/proofs/providers/` |
| Profile DID | `packages/browser/src/engine/did.ts`, `packages/core/src/didDht.ts` |
| Public profiles | `packages/browser/src/profiles/` |
| UI | `apps/ui/src/pages/Identities.tsx`, `apps/ui/src/components/identities/` |
