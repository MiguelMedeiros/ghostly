# Implementation evidence and security limits

What the WISPs are on `dev`: what is implemented and where, with the pull request that shipped it, and the series' working notes (milestones, scope, the 1.0 label proposal). The [index](README.md) lists every WISP; each WISP's header says what it implements.

## State on `dev` (2026-09-28)

One chat, one invite (chat family revision 0.2, decided 2026-09-25) is implemented:

- Every new chat starts from one bech32m code, `ghostly1…`, also shared as `https://ghostly.tools/#ghostly1…` ([801](801-invitation-profiles.md), #210).
- The DHT is the rendezvous and floor of every 1:1 chat. First contact goes over the DHT and a live link at once; the chat upgrades to WebRTC, Iroh or HyperDHT by itself and falls back to DHT text when none connects ([400](400-chat.md), #209, #229). A person can keep a chat on DHT only.
- Calls, shared apps, files of any size and payments run on the live session ([401](401-paired-chat.md), #207, #233). Desktop on Linux calls with its own media ([601](601-webrtc-media.md#desktop-on-linux), #331).
- Chats with Ghostly 0.4 contacts keep working as compatibility chats ([402](402-legacy-chat.md)).
- Chats carry replies, edits, emoji reactions, forwards and a typing indicator; message text shows lists, quotes, headings and links ([400](400-chat.md), [401](401-paired-chat.md), #344, #347, #351, #354, #370, #404).
- A contact's own app can wake a closed web app with a push that carries no content (`wake/1`, [401](401-paired-chat.md), #394). Private groups past 16 members run on hubs, members whose apps stay online ([Group Mesh](9xx-group-mesh.md), #402).
- Bots run the app's own engine without a screen: the `ghostly` CLI, its daemon and its event stream, voice calls included ([11xx](11xx-headless.md), #323 to #327, #350).
- Identity proofs are back, rebuilt (2026-09-23, [WISP 300](300-peer-proofs.md#implementation-2026-09-23-identity-proofs)): made once per profile, shared per contact by choice, through one provider contract ([PROOFS.md](../../packages/browser/src/proofs/PROOFS.md)). Identity cards of a verified Nostr, Pubky or Bluesky identity show its public profile ([PUBLIC-PROFILES.md](PUBLIC-PROFILES.md), #292).

Start at [400](400-chat.md); the invite is in [801](801-invitation-profiles.md).

## About the series

**All 53 entries remain Draft.** The maintainer approved family-based numbering on 2026-09-22. This editorial migration does not assign new wire identifiers or claim new implementation support. See [numbering and compatibility](NUMBERING.md) for the old-to-new map and independent families. Future adapters need substantive contracts, not empty numbered placeholders.

Ghost is the minimal Pkarr/DHT rendezvous and small-record primitive. Ghostly is the reference application composing that primitive with local state, transports and capabilities. WISPs make those boundaries reviewable; this series does not rename the current wire protocol or expand the WISP acronym by decree.

## Current matrix (2026-09-27)

What `dev` runs on each client today. This table and the evidence per WISP below are kept current; the sections from "Observed baseline" on are dated history. Update the current ones, not them.

| Capability | Web app | Extension | Desktop | Evidence |
|---|---|---|---|---|
| DHT (Pkarr) | HTTP relays | HTTP relays | Mainline DHT read directly; writes to the DHT and the relays | #289, #293 |
| One chat: `ghostly1` invite, DHT first contact and floor, self-upgrade | Yes | Yes | Yes | #209, #210, #229 |
| WebRTC | Yes | Yes | macOS and Windows (Linux WebKitGTK has none) | [101](101-webrtc.md) |
| Iroh | Relay only, on by default | Relay only, on by default | Native | #225, #270 |
| HyperDHT | Only through a relay the person sets | Same | Native sidecar | #187, #231 |
| Files (`files/2`, `files/3` of any size) | Yes | Yes | Yes | #233 |
| Calls, screen share inside a call | Yes | Yes | macOS; Linux with its own media (webrtc-rs, GStreamer), no screen share yet; Windows untested | #207, #253, #331 |
| Shared apps (host / open) | No / No | Yes / Yes | Yes / Yes | #207, #268 |
| Profiles and backups | Yes | Yes | Yes | #171 |
| Wallets (per network) | Yes; WebLN web only | Yes | Yes; Bitcoin Core RPC Desktop only | #276, #277, #314, #317 |
| Identity proofs | Yes | Yes | Yes | [300](300-peer-proofs.md) |
| Groups (mesh, community) | Yes | Yes | Yes | [900](900-group-sessions.md) |
| Headless CLI (`ghostly`) | The app's engine on Node, for bots: `ghostly1` invites, one chat, groups, wallets (not Bark), files, identity proofs, shared apps; DHT through relays only | | | [11xx](11xx-headless.md), #323 to #327 |
| Rust `ghostly-cli` | Compatibility client only: older DHT records, no `ghostly1` codes, no chat sessions | | | [cli/README.md](../../cli/README.md) |


## Evidence per WISP (2026-09-28)

Implementation evidence below is what is merged on `dev` on 2026-09-28. Pull request numbers point to the change that shipped it. The implementation column is independent of document status. Existing features can be Draft documentation; proposed adapters are not shipped merely because their draft exists. New semantic envelopes in these documents are sketches, not assigned wire formats. Existing records/frames continue to mean what the implemented protocol specifies.

| Candidate | Document | Status | Implementation evidence |
|---|---|---|---|
| [00](00-process.md) | WISP process and document format | Draft | Process proposal |
| [01](01-ghost-core.md) | Ghost Core Protocol | Draft | Rendezvous and the DHT floor of every chat; Desktop reads the Mainline DHT directly, browsers through Pkarr relays, a circuit breaker per relay (#289), asked again every 15 s while all fail (#382, #395); the CLI publishes to the DHT too (#392) |
| [02](02-peer-keys.md) | Peer Keys | Draft | Participation keys pinned per chat, the inviter's pinned from the invite; lifecycle extensions proposed |
| [03](03-capabilities.md) | Capability Negotiation | Draft | The paired `pair-offer`, the layer-0 capability record (#209) and the `paired-capabilities` frame; general negotiation proposed |
| [04](04-profiles.md) | Local Profiles | Draft | Experimental: web, desktop and browser extension (#171), and profile folders in the CLI; wallets per network and identity proofs per profile; what arrived for another profile, 1:1 chats and communities (#389, #396) |
| [05](05-backups.md) | Profile Backups | Draft | Experimental: web, desktop and extension; whole-profile encrypted bundles, restore as a new profile; the CLI seals its own profile folder |
| [100](100-transports.md) | Transport Negotiation | Draft | Rank-sum negotiation, the DHT floor, background retry and self-upgrade in every new chat (#209, #229); a per-chat transport choice (#204); live again within seconds after a contact's app restarts (#369), and an unanswered WebRTC offer no longer holds back the transports ranked after it (#408) |
| [101](101-webrtc.md) | WebRTC | Draft | The only direct transport in browsers; every client except Linux Desktop (no WebRTC in WebKitGTK) |
| [102](102-iroh.md) | Iroh | Draft | Native on Desktop; relay-only in the web app, the extension and the CLI, on by default (#225); a web chat reaches a Desktop over relayed Iroh (#270) |
| [103](103-hyperdht.md) | HyperDHT | Draft | Native sidecar on Desktop, in process in the CLI; web app and extension only through a HyperDHT relay the person sets, none by default (#231) |
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
| [400](400-chat.md) | Chat Messaging | Draft | One chat on two layers in every new chat: DHT first contact and floor, live link, self-upgrade, DHT only per chat (#209, #229); replies (#347), reactions (#354), edits (#351), lists, quotes, headings and links in the text (#370), forwards to other chats and groups (#404) |
| [401](401-paired-chat.md) | Chat Session (formerly Paired Chat) | Draft | Layer-1 session of every new chat: WebRTC, Iroh, HyperDHT; files, payments, calls (`calls/1`) and shared apps (`services/1`) while live; typing, recording or a bot's status (`typing/1`, #344, #361), reactions (`react/1`, #354), edits (`edit/1`, #351), replies on texts and files (#347, #359), forwards (`fw`, #404), a goodbye on the way out (`paired-bye`, #369), a wake-up push for a closed web app (`wake/1`, #394) |
| [402](402-legacy-chat.md) | Compatibility Chat (formerly Legacy Timestamp Chat) | Draft; retained for compatibility | v0.4 apps and the Rust compatibility CLI; existing chats and v0.4 codes only; "Continue in a new chat" |
| [403](403-dht-text.md) | DHT Text (formerly Bounded DHT Text) | Draft | First contact and floor of every chat, fallback after a drop, DHT only per chat; pinned mailboxes (#302); a reply's id, an edit, reactions and a forward's hop count ride in the envelope (#347, #351, #354, #404); one TTL and one packet size for every envelope (#399) |
| [Store-and-forward · 4xx planned](4xx-store-and-forward.md) | Store-and-Forward for an Away Contact | Draft | Experimental `hold/1` (#108), opt-in: sealed items in the sender's own S3 storage, a signed DHT pointer; text, pictures and payment requests; held replies (#347, #359), forwards (#404) and a picture's size (#420) |
| [500](500-files.md) | File Transfer | Draft | 1:1 files of any size, with consent, resume and a digest check (#228, #233) |
| [501](501-paired-files.md) | Chat Files (formerly Paired Files) | Draft | `files/2` (100 MiB) and `files/3` (any size) on every chat's live link; Send again and Ask again for a stuck transfer, backpressure on native links (#348, #352); a file can answer a message (#359); a video's length, size and poster on its offer (#371); a picture's size on its offer (#420); forwarded files carry `fw` (#404) |
| [502](502-legacy-files.md) | Compatibility File Frames | Draft; retained for compatibility | Compatibility chats only; both peers online |
| [600](600-media.md) | Voice and Video | Draft | 1:1 calls in every chat while live; screen sharing from inside a call (#253); Linux Desktop with native media, no screen sharing yet; the microphone, camera and speaker chosen in Settings and during a call (#388, #400, #406, #419) |
| [601](601-webrtc-media.md) | WebRTC Media | Draft | Compatibility chats and the chat session (`calls/1`); Desktop on Linux with WebRTC in Rust and GStreamer media (#331); signals carry up to eight candidates and calls use the profile's TURN relay (#375); on Linux, the chosen devices in GStreamer (#406, #419) |
| [700](700-local-services.md) | Local Services | Draft | HTTP proxy in every chat, hosted from Desktop, the extension and the CLI; Shared apps from the composer's + (#268) |
| [701](701-http-services.md) | HTTP Local Service Profile | Draft | `ph` frames in the chat session (`services/1`, #207); the web app can neither host nor open one |
| [800](800-invite-join.md) | Invite and Join | Draft | Bearer `ghostly1` invite that pins the inviter's participation key (#210); a copy cannot stop a paired chat (#302); admission protocol proposed |
| [801](801-invitation-profiles.md) | Implemented Invitation Profiles | Draft | Every new chat makes a `ghostly1…` code (#210); `pair1/`, `pair2d/` and v0.4 codes still read |
| [900](900-group-sessions.md) | Group Session Negotiation | Draft | Two profiles implemented: text, @mentions (#279), a group picture and payments between members; admin changes final in a community (#300) |
| [Group Mesh · 9xx planned](9xx-group-mesh.md) | Group Mesh Distribution Profile | Draft | `group-mesh/1` and its link `group-entry/1`: up to 32 members, any member hands on what another missed (#373), hubs past 16 members (`paired-groups` version 4, #402); core, engine and UI; unit and four-browser e2e; web, extension and desktop; replies, reactions, edits and forwards (#347, #354, #378, #404) |
| [Group Community · 9xx planned](9xx-group-community.md) | Group Community Distribution Profile | Draft | `group-community/1` (#153): a link anyone can open, admission by any member, elected hubs, up to 256 members; unit, six-browser e2e and a headless load test; replies, reactions, edits and forwards (#347, #354, #378, #404) |
| [GossipSub · 9xx planned](901-gossipsub.md) | GossipSub Transport | Draft | Proposed; no adapter |
| [1000](1000-storage.md) | Storage Contract | Draft | Experimental: object contract, naming and adapter rules |
| [1001](1001-local-storage.md) | Local File Storage | Draft | Experimental adapter |
| [1002](1002-s3-storage.md) | S3-Compatible Storage | Draft | Experimental adapter; local S3 server end-to-end |
| [Headless · 11xx planned](11xx-headless.md) | Headless Runtime and Local Control API | Draft | Experimental: the app's engine on Node for bots: a per-profile daemon, the `ghostly` CLI and its event stream; chats, groups, wallets, files, proofs and shared apps (#323 to #327); voice calls with the audio on a Unix socket (#350, #362); typing, replies, edits, reactions and forwards (#344, #347, #351, #354, #404); Pkarr over the Mainline DHT beside the relays (#392); agent turns and an allowlist on `listen` (#431); npm package not published |

Dependencies in headers describe the candidate modular design. Conditional dependencies are stated in the body (for example, existing media requires WebRTC). A document can refer to another without making its entire capability mandatory. In particular, 100 does not require a particular transport, 300 does not require an external identity, and 900 does not require GossipSub; the group mesh (9xx) is the first profile of 900 and 901 an optional later one. Group chat uses 400, group file sharing uses 500, and neither implies group payments or localhost permissions.

## Proposed milestones and exit evidence

1. **00-03, 100-101:** review process/Core/key lifecycle, then capability/transport agreement and the WebRTC binding. Exit: exact profiles and two independent implementations with downgrade, invite and reconnect tests.
2. **102-103:** demonstrate interchangeable data adapters using the same application capability. Exit: measured supported platforms, endpoint authentication and policy-respecting failure/fallback; not just sockets connecting.
3. **300-302:** demonstrate optional external proofs and no-proof sessions. Exit: independent verification, replay/rotation tests and explicit correlation tradeoffs. Keet remains gated by API feasibility in 303.
4. **Groups:** 800 and 901 remain review drafts. 900 has two implemented profiles: the [group mesh](9xx-group-mesh.md) (up to 32 members, hubs past 16) and the [group community](9xx-group-community.md) (up to 256), each with text, a picture and payments between members. Files and calls in groups, more than one admin and channels need their own scope decision.

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
| 9xx Group Mesh | Experimental | Up to 32, one admin |
| 9xx Group Community | Experimental | Cap measured by a load test, hubs new |
| 9xx GossipSub | Experimental | No code; stays a Draft proposal |
| 1000 Storage Contract | Experimental | Used by backups and held items only |
| 1001 Local File Storage | Experimental | Adapter of 1000 |
| 1002 S3-Compatible Storage | Experimental | Adapter of 1000; the person's own bucket |

## Observed baseline

Inspection date: 2026-09-20. Baseline commit: `bbe142f08d88cefa173d1dc586608f64b00e9a6c`, with pre-existing local website edits preserved. This is a source inspection, not a cryptographic audit or a claim that network/device tests passed today. Later implementation increments must update this ledger separately from draft status.

The subsequent [paired-chat increment](PAIRED-CHAT-INCREMENT.md) adds an opt-in participation-pinned WebRTC chat profile; the table below remains explicitly the pre-increment baseline.

| Area | Evidence | What it establishes / does not establish |
|---|---|---|
| Link identity/invite | [invite.ts](../../packages/core/src/invite.ts), [identity.ts](../../packages/core/src/identity.ts) | Two seeds plus shared symmetric key generated at creation. Creator initially knows both seeds. No cryptographic consumption/rotation in this legacy invite format. |
| Browser admission | [node.ts](../../packages/browser/src/engine/node.ts) `joinLink`, `onMessage` | Local duplicate lookup by seed; saved invite removed from UI state after incoming message. Neither prevents reuse of a copied invite on another device. |
| Persistence | [db.ts](../../packages/browser/src/engine/db.ts), [desktop host](../../src/desktop/host.ts) | Keys/messages persist locally; offline is not deletion. CLI callers supply their secrets explicitly. |
| Records | [records.ts](../../packages/core/src/records.ts), [crypto.ts](../../packages/core/src/crypto.ts) | TTL 300; 1000-byte DNS budget; secretbox with random nonce; plaintext `_ts`/`_ack`. No ratchet/key erasure schedule provides forward secrecy for stored records. |
| Messaging | [link.ts](../../packages/core/src/link.ts), [ghostlink.ts](../../packages/core/src/ghostlink.ts) | Small DHT fallback, live WebRTC, timestamp-based deduplication. Handing pending messages to a reliable channel is not remote durable acknowledgement. |
| Data transport | [ghostlink.ts](../../packages/core/src/ghostlink.ts), [datalink.ts](../../packages/core/src/datalink.ts) | WebRTC directly composed today. `PkarrTransport` abstracts rendezvous, not interchangeable data adapters. |
| Capabilities | [services.ts](../../packages/core/src/services.ts) | Validated advertisements and updates, not general version/permission negotiation. |
| Files/services/media | [files.ts](../../packages/core/src/files.ts), [http.ts](../../packages/core/src/http.ts), [callSignal.ts](../../packages/core/src/callSignal.ts), [React hooks](../../packages/react/src/useWebRTC.ts) | Existing bounded 1:1 capabilities, with platform constraints. Not group features. |
| Payments | [core payments](../../packages/core/src/payments.ts), [wallet](../../packages/browser/src/engine/wallet.ts), [coordinator](../../packages/browser/src/engine/payments.ts) | Cashu/Lightning application integration exists. Generic external wallet selection and every payment method do not. |
| Invoice display | [bolt11.ts](../../packages/core/src/bolt11.ts) | Checksum/display parser explicitly does not verify invoice signatures; the executing wallet must validate. |
| Proposed adapters/groups | Source search in core/browser/CLI/native directories | No Iroh, HyperDHT, external identity proof, MLS/group session or GossipSub adapter found. Pkarr/Paykit references are not proof of Pubky identity integration. |

## Security language to preserve

- Per-link identities reduce direct key reuse, but IP addresses, timing, capabilities, nicknames and optional external proofs can correlate activity. No anonymity guarantee.
- Pkarr signatures authenticate publishing keys; secretbox protects private values. Anyone who learns the link symmetric key can attempt to decrypt previously recorded ciphertext under that key. Unique links and random nonces do not provide forward secrecy by themselves.
- TTL and stopping refresh are availability/cache semantics. DHT nodes, relays, contacts or observers can retain copies; expiry is not verified erasure. Local history can outlive network presence.
- Legacy invite holders obtain sensitive signing/decryption credentials. Removing an invite from the screen cannot revoke them. A future consumed invite requires actual credential/state transition and explicit migration.
- Authenticated transport is not a human identity check, an authorization to spend, or permission to access every local service. Group routing is not group encryption.

## Platform evidence: implemented, available, selected

These are separate questions: **implemented** means a code path exists; **available** means this runtime and permission state can use it; **selected** means both peers and local policy agreed on its profile. Current service advertisements are not the proposed general negotiation.

| Capability | Web app baseline | Extension baseline | Native baseline | Session/runtime gate |
|---|---|---|---|---|
| Pkarr access | HTTP relays | HTTP relays | Injected Rust DHT/relay transport | Reachability, relay/network limits; an extension does not acquire native UDP merely by being installed |
| WebRTC data/chat/files | Shared core/engine | Shared core/engine in offscreen peer | Shared engine in WebView | WebRTC support, ICE path, peer compatibility; connectivity can fail |
| Voice/video | Shared UI/hook | Shared UI/hook | Shared UI/hook | Capture APIs, secure context, permissions, engine compatibility |
| Screen capture | When `getDisplayMedia` exists | Runtime dependent | WebView/OS dependent | Must detect availability; mobile support is not assumed |
| Host/open localhost | Host flags disabled | Host permissions and isolated viewer | Rust local fetch and viewer | Explicit enabled service, target validation; per-peer audience is not implemented in baseline |
| Persistent local state | IndexedDB; tab lifetime | IndexedDB; browser/offscreen lifecycle | Shared engine storage; app lifetime | Profile/device loss, storage failure, concurrent owner protection |
| Cashu/Lightning | Application integration | Same integration | Same integration | Mint/component access and explicit payment authorization |
| CLI | Separate Rust text client | Not an extension capability | Invokable CLI | No implied WebRTC/media/file support from sharing record format |
| Iroh/HyperDHT/proofs/groups | Proposed | Proposed | Proposed | Availability and interoperability unproven |

Sources: [host contract](../../packages/browser/src/host.ts), [web host](../../web/src/host.ts), [desktop host](../../src/desktop/host.ts), [extension source](../../extension/src), [web constraints](../WEB.md), [CLI](../CLI.md). Older release-specific prose in BROWSER.md is not evidence that the current native checkout ignores services; inspect the injected current engine/host wiring.

## Implementation sequence

Use a shared library for validated wire objects, version agreement and state machines, with host adapters for storage, keys, permissions and networking. Work in vertical flows: Draft → implementation → cross-platform tests → review/update Draft. First demonstrate pairwise invite, confirmation, negotiated WebRTC, message and restart/reconnect across web/native, then extension lifecycle. Preserve the legacy profile and make migration explicit; do not label automatic DHT fallback as a negotiated privacy choice.

Next, prove a second data adapter before claiming interchangeable transports. Groups follow with three peers, an agreed distribution/security profile, admission/removal and bounded failure cases. Runtime availability and negotiated compatibility should produce different user-visible unavailable/incompatible states. Reusing core across clients proves portability; independent implementation is a separate interoperability gate.


## One chat, revision 0.2 (2026-09-25): implemented versus decided

Inspection of `dev` at `802b48bc`, rechecked at `8670aeab`. The chat family's revision 0.2 describes one chat with the DHT as rendezvous and floor ([400](400-chat.md)); its decisions were recorded on 2026-09-25. The three implementation cards then queued have merged: the `ghostly1` invite and its ghostly.tools link (#210), DHT fallback and self-upgrade in every chat (#209, #229), and calls in the chat session (#207). The "Today" column is the 2026-09-25 inspection; rows it marks as different from the decision are now as decided.

| Behaviour | Today | Decided (2026-09-25) |
|---|---|---|
| Invite formats created | `pair1/` (streams first) or `pair2d/` (DHT only), chosen at creation ([invite.ts](../../packages/core/src/invite.ts)); since #210 only `ghostly1…` | One bech32m `ghostly1…` string (or `https://ghostly.tools/#ghostly1…`), no choice; `pair1/`, `pair2d/` and prefix-less still read ([801](801-invitation-profiles.md)) |
| First contact | Both at once in every chat: DHT envelope with recipient `invite` ([dhtDelivery.ts](../../packages/core/src/dhtDelivery.ts)) and a stream; a key mismatch on either path stops both ([ghostlink.ts](../../packages/core/src/ghostlink.ts)) | Both at once; pin on whichever verifies first; same key required on both |
| First pairing without a stream | Ends `on-dht` ([pairingProgress.ts](../../packages/core/src/pairingProgress.ts)) and chats | Ends `on-dht` and chats |
| Short-text fallback after a drop | Exists for `pair1/` chats once the contact announced DHT support (`GhostLink.textDelivery`, [ghostlink.ts](../../packages/core/src/ghostlink.ts)); every chat since #229 | The rule for every chat; every contact announces it from the first contact |
| Upgrade from DHT to a stream | Automatic in every chat that is not `dht-chosen`; a joined `pair2d/` code no longer sets DHT only | Automatic in every chat that is not `dht-chosen` |
| DHT only as a choice | Per chat, `setDeliveryMode("dht")`; either side blocks both | Same, listed as **DHT only** in the per-chat Connection menu |
| Capabilities before a stream exists | Layer-0 capability record ([capsRecord.ts](../../packages/core/src/capsRecord.ts)), revision in the envelope | Layer-0 capability record: transports, capabilities, native descriptors, name ([03](03-capabilities.md#layer-0-capability-record)) |
| Native transports without WebRTC first | Yes: descriptors from the record; demoted for 1 h after 3 failures | Yes, from the capability record |
| Second DHT text while one awaits a receipt | Waits in the outbox (`waiting`) ([outbox.ts](../../packages/browser/src/engine/outbox.ts)) | Queued in the outbox |
| Files, long text, requests while on the DHT | Held if both allow `hold/1` (DHT only too); otherwise wait for live with a cancel | Held in `on-dht` and `dht-chosen`; otherwise queued for layer 1 |
| Mailbox reads while live | Every 5 min, at once on a drop (10 s, not 4 s, while open on the DHT: relay budget) | Every 5 min, at once on a drop |
| Compatibility (prefix-less, v0.4) chats | Read and written, marked in the header, "Continue in a new chat" | Same; never created; "Continue in a new chat" |
| Hosted HTTP in new chats | Yes: `ph` frames on the chat session ([pairedHttp.ts](../../packages/core/src/pairedHttp.ts)) under `services/1` ([pairedCapabilities.ts](../../packages/core/src/pairedCapabilities.ts)), live only | Unchanged |
| Calls in new chats | Yes: `calls/1`, `paired-call` signals on the live session ([pairedCalls.ts](../../packages/core/src/pairedCalls.ts)), media on its own WebRTC connection; on Linux Desktop (no WebRTC in WebKitGTK) that connection runs in Rust, webrtc-rs and GStreamer, with no screen sharing yet | Unchanged |
| Pairing progress | Ends `live` or `on-dht`; `failed` only for key mismatch, rejection, publish, offline | Adds terminal `on-dht`; `failed` only for security or an unreachable DHT |
| CLI | Legacy `_msgs` only | Unchanged by the Drafts; a DHT-only client of 403 is the natural next step |

## Follow-up paired-chat implementation (2026-09-20)

The opt-in is available in both Home and **New**. Updated peers negotiate participation-signed RTC signaling and durably require it after authenticated migration; addresses/bootstrap encryption keys remain unchanged, so record overwrite and metadata exposure remain risks. Paired outgoing text now has a durable random ID and per-message sent/received/unconfirmed status, explicit retry after disconnect/restart and receiver deduplication. Legacy contacts retain their original profile.

Web ↔ extension and native ↔ extension exchanges were observed, including closed extension UI, stopped service worker with live offscreen engine, extension reload, storage retention and automatic reconnection. These clients share the core and do not establish independent implementation conformance. See [exact profile and limitations](PAIRED-CHAT-INCREMENT.md).

## Native paired-chat adapters (2026-09-20)

[Implemented profile](TRANSPORT-INCREMENT.md): Iroh 1.2.0 via Rust QUIC/TLS exporter and HyperDHT 6.34.0 via packaged native UDP/Noise runtime. Both reuse the shared participation/session authentication and durable chat engine. Web/extension advertise only their available WebRTC adapter. Real local transport integration tests and two Tauri app exchanges validated switching without changing conversation IDs, pins or history. No independent application implementation, external proof or group support is implied. The baseline tables above remain historical.

## Optional Nostr proof increment (2026-09-20, history)

The [proof increment](PROOF-INCREMENT.md) recorded external-signer Nostr and local imports of Pubky and Keet-compatible keys in an experimental `proof-*` protocol. It stays off (`EXTERNAL_IDENTITIES_ENABLED = false`), with its old evidence preserved: the rebuilt identity proofs (2026-09-23, [300](300-peer-proofs.md#implementation-2026-09-23-identity-proofs)) replaced it. Ghostly participation remains the default. All WISPs remain Draft; earlier baseline inspections are historical.

## Index revision record (history)

The catalogue in [README.md](README.md) kept this record until 2026-09-28, when it became a generated index and its notes moved here. Each WISP keeps its own revision log in [changes/](changes/).

2026-09-28: an audit of what merged on `dev` from 2026-09-26 to 2026-09-28 against each WISP (#441). Change files added where a change had none (04, 9xx Group Community 0.9, 9xx Group Mesh), texts written down for what the app already did (the voice description, video bounds, receiver bounds on names, previews, message times and mentions, call re-offers), the headless CLI named where it runs, and hubs, wake-up push, forwards and the relay shares in the catalogue. No new WISP: every new frame or field fits an existing one. Numbers, file names, wire identifiers and Draft status unchanged.

2026-09-27 (evening): the chat family after typing, replies, reactions, edits, file replies, videos in the chat and message text (400 0.2.9, 401 0.11, 403 0.6, 4xx 0.3.1, 501 0.4.2, 601 0.7, group mesh 0.7, group community 0.8), the headless runtime at 0.8 with voice calls, Fedimint, Spark and Breez on Mainnet (#341). Group mesh, group community and 11xx gained a revision log. Numbers, file names, wire identifiers and Draft status unchanged.

2026-09-27: the headless runtime (11xx) through its fourth phase, calls on Desktop on Linux (601), the count of entries (53). Numbers, file names, wire identifiers and Draft status unchanged.

2026-09-26: the index follows what is merged on `dev`: one chat and the `ghostly1` invite implemented, rows for OpenID Connect and AT Protocol added, identity providers and wallets brought up to date. Numbers, file names, wire identifiers and Draft status unchanged.

2026-09-25: chat family revision 0.2 (01, 03, 100 to 103, 400 to 403, 4xx, 500 to 502, 800, 801): one chat with a DHT floor and a peer-to-peer upgrade, one invite format, compatibility profiles for v0.4. Numbers, file names and wire identifiers unchanged; all entries remain Draft.

2026-09-23: identity proofs rebuilt on a provider contract ([300](300-peer-proofs.md#implementation-2026-09-23-identity-proofs)); the 2026-09-21 release decision that deferred external identity proofs and profile lookup no longer holds.

2026-09-22: approved editorial family migration; old reader URLs remain aliases; protocol identifiers and Draft status unchanged.

2026-09-21: release decision: external identity proofs and external profile lookup deferred; Pubky, Keet, local imports and Ring UI disabled, their experiments and stored data preserved.

2026-09-20: initial review drafts; source audit distinguishes deployed legacy behavior from candidate modular/group architecture. See [evidence](IMPLEMENTATION.md) for scope and limitations.
