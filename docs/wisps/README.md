# WISP working catalogue

> **State on `dev` (2026-09-27).** One chat, one invite (chat family revision 0.2, decided 2026-09-25) is implemented:
>
> - Every new chat starts from one bech32m code, `ghostly1…`, also shared as `https://ghostly.tools/#ghostly1…` ([801](801-invitation-profiles.md), #210).
> - The DHT is the rendezvous and floor of every 1:1 chat. First contact goes over the DHT and a live link at once; the chat upgrades to WebRTC, Iroh or HyperDHT by itself and falls back to DHT text when none connects ([400](400-chat.md), #209, #229). A person can keep a chat on DHT only.
> - Calls, shared apps, files of any size and payments run on the live session ([401](401-paired-chat.md), #207, #233). Desktop on Linux calls with its own media ([601](601-webrtc-media.md#desktop-on-linux), #331).
> - Chats with Ghostly 0.4 contacts keep working as compatibility chats ([402](402-legacy-chat.md)).
> - Chats carry replies, edits, emoji reactions and a typing indicator; message text shows lists, quotes, headings and links ([400](400-chat.md), [401](401-paired-chat.md), #344, #347, #351, #354, #370).
> - Bots run the app's own engine without a screen: the `ghostly` CLI, its daemon and its event stream, voice calls included ([11xx](11xx-headless.md), #323 to #327, #350).
> - Identity proofs are back, rebuilt (2026-09-23, [WISP 300](300-peer-proofs.md#implementation-2026-09-23-identity-proofs)): made once per profile, shared per contact by choice, through one provider contract ([PROOFS.md](../../packages/browser/src/proofs/PROOFS.md)). Identity cards of a verified Nostr, Pubky or Bluesky identity show its public profile ([PUBLIC-PROFILES.md](PUBLIC-PROFILES.md), #292).
>
> Start at [400](400-chat.md); the invite is in [801](801-invitation-profiles.md).

**All 53 entries remain Draft.** The maintainer approved family-based numbering on 2026-09-22. This editorial migration does not assign new wire identifiers or claim new implementation support. See [numbering and compatibility](NUMBERING.md) for the old-to-new map and independent families. Future adapters need substantive contracts, not empty numbered placeholders.

Ghost is the minimal Pkarr/DHT rendezvous and small-record primitive. Ghostly is the reference application composing that primitive with local state, transports and capabilities. WISPs make those boundaries reviewable; this series does not rename the current wire protocol or expand the WISP acronym by decree.

## One source

WISP content lives in `docs/wisps` only; the site is generated. What [ghostly.tools](https://ghostly.tools/developers/catalog) says about a WISP (its summary, availability and notes) is read from the rows of that WISP's header table, defined in [the process](00-process.md#header-fields-the-site-reads); the roadmap page is read from the [adapter roadmap](ADAPTER-ROADMAP.md). To change what the site says, change the document and run `npm run sync:references` in `website/`.

## Read first

- [Adapter and ecosystem roadmap](ADAPTER-ROADMAP.md): the one place where each candidate's implementation status lives; candidate inventory, not implementation claims.
- [Process and required format](00-process.md)
- [Composable architecture map](MAP.md)
- [Implementation evidence and security limits](IMPLEMENTATION.md)
- [Interoperability plan](INTEROP.md)
- [Chat session increment](PAIRED-CHAT-INCREMENT.md), [files and sats in the chat session](PAIRED-CAPABILITIES.md) and [native transport increment](TRANSPORT-INCREMENT.md)
- [Identity presentation and public profiles](PUBLIC-PROFILES.md)
- [Current implemented wire protocol](../PROTOCOL.md)

The implementation column is independent of document status. Existing features can be Draft documentation; proposed adapters are not shipped merely because their draft exists. New semantic envelopes in these documents are sketches, not assigned wire formats. Existing records/frames continue to mean what the implemented protocol specifies.

## Draft catalogue by family

Implementation evidence below is what is merged on `dev` on 2026-09-27. Pull request numbers point to the change that shipped it.

| Candidate | Document | Status | Implementation evidence |
|---|---|---|---|
| [00](00-process.md) | WISP process and document format | Draft | Process proposal |
| [01](01-ghost-core.md) | Ghost Core Protocol | Draft | Rendezvous and the DHT floor of every chat; Desktop reads the Mainline DHT directly, browsers through Pkarr relays, a circuit breaker per relay (#289) |
| [02](02-peer-keys.md) | Peer Keys | Draft | Participation keys pinned per chat, the inviter's pinned from the invite; lifecycle extensions proposed |
| [03](03-capabilities.md) | Capability Negotiation | Draft | The paired `pair-offer`, the layer-0 capability record (#209) and the `paired-capabilities` frame; general negotiation proposed |
| [04](04-profiles.md) | Local Profiles | Draft | Experimental: web, desktop and browser extension (#171); wallets per network and identity proofs per profile |
| [05](05-backups.md) | Profile Backups | Draft | Experimental: web, desktop and extension; whole-profile encrypted bundles, restore as a new profile |
| [100](100-transports.md) | Transport Negotiation | Draft | Rank-sum negotiation, the DHT floor, background retry and self-upgrade in every new chat (#209, #229); a per-chat transport choice (#204) |
| [101](101-webrtc.md) | WebRTC | Draft | The only direct transport in browsers; every client except Linux Desktop (no WebRTC in WebKitGTK) |
| [102](102-iroh.md) | Iroh | Draft | Native on Desktop; relay-only in the web app and extension, on by default (#225); a web chat reaches a Desktop over relayed Iroh (#270) |
| [103](103-hyperdht.md) | HyperDHT | Draft | Native sidecar on Desktop; web app and extension only through a HyperDHT relay the person sets, none by default (#231) |
| [200](200-payments.md) | Payment Negotiation | Draft | Payment frames in every chat's live session, per network; Lightning and on-chain provider contracts; each rail its own method |
| [201](201-cashu.md) | Cashu | Draft | Mainnet mints by default, a test mint on Testnet |
| [202](202-arkade.md) | Ark via Arkade | Draft | Experimental: Mainnet and Testnet (mutinynet) wallets; payments verified on regtest; encrypted restore tested; exits pending |
| [203](203-lightning.md) | Lightning | Draft | Several Lightning cards per network, one the default for receiving (#314, #317): the mints, NWC, LND, Core Lightning, WebLN, Breez, a Fedimint federation |
| [204](204-bark.md) | Ark via Bark | Draft | Experimental: Mainnet on Second's server (#305) and Testnet; regtest verified; not compatible with Arkade; exits pending |
| [205](205-lnurl.md) | Lightning Addresses and LNURL-pay | Draft | Paying an address or LNURL through a Lightning card; strict checks; no receiving |
| [Fedimint · 2xx planned](2xx-fedimint.md) | Fedimint ecash and Lightning through a federation | Draft | Experimental, Mainnet and Testnet (#192, #341); web SDK canary; regtest verified (ecash in chats, Lightning through the gateway); not yet tried with real funds |
| [Spark · 2xx planned](2xx-spark.md) | Spark payments | Draft | Experimental (#188): Spark to Spark (addresses and invoices) through the Breez SDK; Testnet on Breez's regtest; Mainnet with the person's Breez API key (#341) |
| [300](300-peer-proofs.md) | Identity Proofs | Draft | Experimental provider contract (2026-09-23): made once per profile, shared per contact; the providers below |
| [301](301-nostr.md) | Nostr | Draft | Experimental provider `nostr` (NIP-07, NIP-46) |
| [Nostr social · 3xx planned](3xx-nostr-social.md) | Nostr social layer | Draft | Experimental: profile, follows, notes on request; publication through the person's signer, off by default |
| [Profile DID · 3xx planned](3xx-did-dht.md) | Profile DID (did:dht) | Draft | Experimental (#247): every profile's did:dht of its own key, the key alone unless the person lists identities; published by web, extension and Desktop (#299); @web5/dids interop |
| [Pubky · 3xx planned](302-pubky.md) | Pubky | Draft | Experimental provider `pubky` (#246): approved in Pubky Ring or Pubky Passport, proof file on the homeserver |
| [Keet · 3xx planned](303-keet.md) | Keet | Draft | Blocked: no supported Keet signing or export API; the 2026-09-20 compatible import is off |
| [Domain · 3xx planned](3xx-domain.md) | Domain Proofs | Draft | Experimental provider `domain`: DNS TXT, /.well-known/ghostly.json, NIP-05 |
| [OpenPGP · 3xx planned](3xx-openpgp.md) | OpenPGP | Draft | Experimental provider `openpgp`; gpg-made vectors, contract suite and e2e |
| [Bitcoin address · 3xx planned](3xx-bitcoin.md) | Bitcoin Address Proof | Draft | Experimental provider `bitcoin`: BIP-322 2.0.0 and legacy P2PKH, verified locally |
| [SSH · 3xx planned](3xx-ssh.md) | SSH keys | Draft | Experimental `ssh`, `ssh-github`, `ssh-gitlab` providers |
| [OpenID Connect · 3xx planned](3xx-oidc-proofs.md) | Provider-attested identity (OpenID Connect) | Draft | Built and tested against a test issuer (#92); blocked on Ghostly's OAuth client registrations, so no provider is offered |
| [AT Protocol · 3xx planned](3xx-atproto.md) | AT Protocol identity (Bluesky) | Draft | Provider `atproto` (#248), e2e against a local PDS; a real server needs its client-metadata file live on ghostly.tools |
| [DID · 3xx planned](3xx-did.md) | Decentralized identifiers (did:key, did:jwk, did:dht, did:web) | Draft | Experimental provider `did` (#249), under Advanced in the picker |
| [400](400-chat.md) | Chat Messaging | Draft | One chat on two layers in every new chat: DHT first contact and floor, live link, self-upgrade, DHT only per chat (#209, #229); replies (#347), reactions (#354), edits (#351), lists, quotes, headings and links in the text (#370) |
| [401](401-paired-chat.md) | Chat Session (formerly Paired Chat) | Draft | Layer-1 session of every new chat: WebRTC, Iroh, HyperDHT; files, payments, calls (`calls/1`) and shared apps (`services/1`) while live; typing (`typing/1`, #344), reactions (`react/1`, #354), edits (`edit/1`, #351), replies on texts and files (#347, #359) |
| [402](402-legacy-chat.md) | Compatibility Chat (formerly Legacy Timestamp Chat) | Draft; retained for compatibility | v0.4 apps and the Rust compatibility CLI; existing chats and v0.4 codes only; "Continue in a new chat" |
| [403](403-dht-text.md) | DHT Text (formerly Bounded DHT Text) | Draft | First contact and floor of every chat, fallback after a drop, DHT only per chat; pinned mailboxes (#302); a reply's id, an edit and reactions ride in the envelope (#347, #351, #354) |
| [Store-and-forward · 4xx planned](4xx-store-and-forward.md) | Store-and-Forward for an Away Contact | Draft | Experimental `hold/1` (#108), opt-in: sealed items in the sender's own S3 storage, a signed DHT pointer; text, pictures and payment requests; held replies (#347, #359) |
| [500](500-files.md) | File Transfer | Draft | 1:1 files of any size, with consent, resume and a digest check (#228, #233) |
| [501](501-paired-files.md) | Chat Files (formerly Paired Files) | Draft | `files/2` (100 MiB) and `files/3` (any size) on every chat's live link; Send again and Ask again for a stuck transfer, backpressure on native links (#348, #352); a file can answer a message (#359) |
| [502](502-legacy-files.md) | Compatibility File Frames | Draft; retained for compatibility | Compatibility chats only; both peers online |
| [600](600-media.md) | Voice and Video | Draft | 1:1 calls in every chat while live; screen sharing from inside a call (#253); Linux Desktop with native media, no screen sharing yet |
| [601](601-webrtc-media.md) | WebRTC Media | Draft | Compatibility chats and the chat session (`calls/1`); Desktop on Linux with WebRTC in Rust and GStreamer media (#331) |
| [700](700-local-services.md) | Local Services | Draft | HTTP proxy in every chat, hosted from Desktop and the extension; Shared apps from the composer's + (#268) |
| [701](701-http-services.md) | HTTP Local Service Profile | Draft | `ph` frames in the chat session (`services/1`, #207); the web app can neither host nor open one |
| [800](800-invite-join.md) | Invite and Join | Draft | Bearer `ghostly1` invite that pins the inviter's participation key (#210); a copy cannot stop a paired chat (#302); admission protocol proposed |
| [801](801-invitation-profiles.md) | Implemented Invitation Profiles | Draft | Every new chat makes a `ghostly1…` code (#210); `pair1/`, `pair2d/` and v0.4 codes still read |
| [900](900-group-sessions.md) | Group Session Negotiation | Draft | Two profiles implemented: text, @mentions (#279), a group picture and payments between members; admin changes final in a community (#300) |
| [Group Mesh · 9xx planned](9xx-group-mesh.md) | Group Mesh Distribution Profile | Draft | `group-mesh/1` and its link `group-entry/1`: up to eight members; core, engine and UI; unit and four-browser e2e; web, extension and desktop; replies and reactions (#347, #354) |
| [Group Community · 9xx planned](9xx-group-community.md) | Group Community Distribution Profile | Draft | `group-community/1` (#153): a link anyone can open, admission by any member, elected hubs, up to 256 members; unit, six-browser e2e and a headless load test; replies and reactions (#347, #354) |
| [GossipSub · 9xx planned](901-gossipsub.md) | GossipSub Transport | Draft | Proposed; no adapter |
| [1000](1000-storage.md) | Storage Contract | Draft | Experimental: object contract, naming and adapter rules |
| [1001](1001-local-storage.md) | Local File Storage | Draft | Experimental adapter |
| [1002](1002-s3-storage.md) | S3-Compatible Storage | Draft | Experimental adapter; local S3 server end-to-end |
| [Headless · 11xx planned](11xx-headless.md) | Headless Runtime and Local Control API | Draft | Experimental: the app's engine on Node for bots: a per-profile daemon, the `ghostly` CLI and its event stream; chats, groups, wallets, files, proofs and shared apps (#323 to #327); voice calls with the audio on a Unix socket (#350, #362); typing, replies, edits and reactions (#344, #347, #351, #354); npm package not published |

Dependencies in headers describe the candidate modular design. Conditional dependencies are stated in the body (for example, existing media requires WebRTC). A document can refer to another without making its entire capability mandatory. In particular, 100 does not require a particular transport, 300 does not require an external identity, and 900 does not require GossipSub; the group mesh (9xx) is the first profile of 900 and 901 an optional later one. Group chat uses 400, group file sharing uses 500, and neither implies group payments or localhost permissions.

## Proposed milestones and exit evidence

1. **00-03, 100-101:** review process/Core/key lifecycle, then capability/transport agreement and the WebRTC binding. Exit: exact profiles and two independent implementations with downgrade, invite and reconnect tests.
2. **102-103:** demonstrate interchangeable data adapters using the same application capability. Exit: measured supported platforms, endpoint authentication and policy-respecting failure/fallback; not just sockets connecting.
3. **300-302:** demonstrate optional external proofs and no-proof sessions. Exit: independent verification, replay/rotation tests and explicit correlation tradeoffs. Keet remains gated by API feasibility in 303.
4. **Groups:** 800 and 901 remain review drafts. 900 has two implemented profiles: the [group mesh](9xx-group-mesh.md) (up to eight members) and the [group community](9xx-group-community.md) (up to 256), each with text, a picture and payments between members. Files and calls in groups, more than one admin and channels need their own scope decision.

400, 500, 600, 700 and 200/201/203 document existing application capabilities and their modular evolution. These milestones do not promise implementation dates or claim that all adapters exist. Group security, topology and abuse limits must be validated before release claims.

## Out of scope for this series

The [chat session increment](PAIRED-CHAT-INCREMENT.md) and [native transport increment](TRANSPORT-INCREMENT.md) record the bounded implementation profiles separately from full draft conformance. No public lobby or Ghostly OS is implemented. Preset wizards are product UX, not an extra WISP. Passkeys, hardware signers beyond what gpg and ssh-keygen drive, Tor, centralized proofs and Bitcoin query/broadcast services remain possible future work. [Ark via Arkade 202](202-arkade.md) documents the experimental implementation and real regtest evidence; exits and broader platform coverage remain release gates. The erroneous WebLN/gateway/backup/compliance catalogue is not adopted.

## Proposal: 1.0 maturity labels (not normative until Miguel confirms)

A proposal only. Every entry stays Draft until Miguel decides. "Stable 1.0" means the chat core the v1.0.0 release stands on; "Experimental" means usable but young, gated, test-network only or waiting on something outside the code.

| WISP | Proposed label | Reason |
|---|---|---|
| 00 Process | Stable 1.0 | The format every WISP follows |
| 01 Ghost Core | Stable 1.0 | Rendezvous and floor of every chat |
| 02 Peer Keys | Stable 1.0 | Participation keys pinned in every chat |
| 03 Capabilities | Stable 1.0 | Offer, capability record and session frame in every chat |
| 04 Local Profiles | Stable 1.0 | On all three clients |
| 05 Profile Backups | Experimental | Format revised 2026-09-25; restore only as a new profile |
| 100 Transport Negotiation | Stable 1.0 | Every chat negotiates, falls back and upgrades |
| 101 WebRTC | Stable 1.0 | Default live link between browsers |
| 102 Iroh | Stable 1.0 | Native on Desktop; browser relay path newer |
| 103 HyperDHT | Stable 1.0 | Native on Desktop; browser relay off by default |
| 200 Payment Negotiation | Stable 1.0 | Payment frames per network in every chat |
| 201 Cashu | Stable 1.0 | Default rail, Mainnet mints |
| 202 Arkade | Experimental | No unilateral exit yet |
| 203 Lightning | Stable 1.0 | Default through the mints; own sources plug in |
| 204 Bark | Experimental | No exit yet; Mainnet since 2026-09-26 |
| 205 LNURL-pay | Stable 1.0 | Paying only, strict checks, no wire format |
| 2xx Fedimint | Experimental | Mainnet and Testnet, canary SDK |
| 2xx Spark | Experimental | Mainnet (your Breez API key) and Testnet |
| 300 Identity Proofs | Experimental | Contract rebuilt 2026-09-23 |
| 301 Nostr | Experimental | Provider on the young contract |
| 3xx Nostr social | Experimental | Read on request, publication off by default |
| 3xx Profile DID (did:dht) | Experimental | Public links opt-in, new |
| 3xx Pubky | Experimental | Merged 2026-09-25 |
| 3xx Keet | Experimental | Blocked on a Keet API |
| 3xx Domain | Experimental | Identity provider |
| 3xx OpenPGP | Experimental | Identity provider |
| 3xx Bitcoin address | Experimental | Identity provider |
| 3xx SSH | Experimental | Identity provider |
| 3xx OpenID Connect | Experimental | Blocked on OAuth client registrations |
| 3xx AT Protocol | Experimental | Blocked on the client-metadata file going live |
| 3xx DID | Experimental | Advanced provider |
| 400 Chat Messaging | Stable 1.0 | The one chat |
| 401 Chat Session | Stable 1.0 | Layer 1 of every chat |
| 402 Compatibility Chat | Stable 1.0, compatibility only | v0.4 contacts; candidate to drop later |
| 403 DHT Text | Stable 1.0 | First contact and floor of every chat |
| 4xx Store-and-forward | Experimental | Opt-in, needs the sender's own S3 |
| 500 File Transfer | Stable 1.0 | Files in every chat |
| 501 Chat Files | Stable 1.0 | `files/2` and `files/3` on the live link |
| 502 Compatibility File Frames | Stable 1.0, compatibility only | v0.4 contacts; candidate to drop later |
| 600 Voice and Video | Stable 1.0 | Calls in every chat, Linux Desktop included (no screen sharing there yet) |
| 601 WebRTC Media | Stable 1.0 | The media profile calls use |
| 700 Local Services | Stable 1.0 | In v0.4 already, now in every chat |
| 701 HTTP Local Service Profile | Stable 1.0 | `ph` frames under `services/1` |
| 800 Invite and Join | Stable 1.0 | The `ghostly1` bearer invite; admission protocol still proposed |
| 801 Invitation Profiles | Stable 1.0 | One invite format |
| 900 Group Sessions | Experimental | Groups merged from 2026-09-24, still changing (#300 on 2026-09-26) |
| 9xx Group Mesh | Experimental | Up to eight, one admin |
| 9xx Group Community | Experimental | Cap measured by a load test, hubs new |
| 9xx GossipSub | Experimental | No code; stays a Draft proposal |
| 1000 Storage Contract | Experimental | Used by backups and held items only |
| 1001 Local File Storage | Experimental | Adapter of 1000 |
| 1002 S3-Compatible Storage | Experimental | Adapter of 1000; the person's own bucket |

## Revision record

2026-09-27 (evening): the chat family after typing, replies, reactions, edits, file replies, videos in the chat and message text (400 0.2.9, 401 0.10, 403 0.6, 4xx 0.3.1, 501 0.4.2, group mesh 0.7, group community 0.8), the headless runtime at 0.8 with voice calls, Fedimint, Spark and Breez on Mainnet (#341). Group mesh, group community and 11xx gained a revision log. Numbers, file names, wire identifiers and Draft status unchanged.

2026-09-27: the headless runtime (11xx) through its fourth phase, calls on Desktop on Linux (601), the count of entries (53). Numbers, file names, wire identifiers and Draft status unchanged.

2026-09-26: the index follows what is merged on `dev`: one chat and the `ghostly1` invite implemented, rows for OpenID Connect and AT Protocol added, identity providers and wallets brought up to date. Numbers, file names, wire identifiers and Draft status unchanged.

2026-09-25: chat family revision 0.2 (01, 03, 100 to 103, 400 to 403, 4xx, 500 to 502, 800, 801): one chat with a DHT floor and a peer-to-peer upgrade, one invite format, compatibility profiles for v0.4. Numbers, file names and wire identifiers unchanged; all entries remain Draft.

2026-09-23: identity proofs rebuilt on a provider contract ([300](300-peer-proofs.md#implementation-2026-09-23-identity-proofs)); the 2026-09-21 release decision that deferred external identity proofs and profile lookup no longer holds.

2026-09-22: approved editorial family migration; old reader URLs remain aliases; protocol identifiers and Draft status unchanged.

2026-09-21: release decision: external identity proofs and external profile lookup deferred; Pubky, Keet, local imports and Ring UI disabled, their experiments and stored data preserved.

2026-09-20: initial review drafts; source audit distinguishes deployed legacy behavior from candidate modular/group architecture. See [evidence](IMPLEMENTATION.md) for scope and limitations.

## Optional Nostr proof increment (2026-09-20, history)

Superseded by the rebuilt identity proofs (2026-09-23). The [proof increment](PROOF-INCREMENT.md) recorded an experimental `proof-*` protocol with external-signer Nostr and local imports of Pubky and Keet-compatible keys, several proofs per conversation. That protocol and its imports stay off (`EXTERNAL_IDENTITIES_ENABLED = false`); old evidence is preserved.
