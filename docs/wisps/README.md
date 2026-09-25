# WISP working catalogue

> Release decision (2026-09-21): external identity proofs and external profile lookup were deferred; Pubky, Keet, local imports and Ring UI remain disabled, their experiments and stored data preserved.
>
> Update (2026-09-23): **identity proofs are back, rebuilt** ([WISP 300 implementation](300-peer-proofs.md#implementation-2026-09-23-identity-proofs)): made once per profile, shared per contact only by choice, with a provider contract ([PROOFS.md](../../packages/browser/src/proofs/PROOFS.md)). Nostr (NIP-07, NIP-46) is the first provider; domain, Bitcoin, SSH, PGP and OpenID Connect providers plug into the same contract. A public profile is looked up only on the person's request.

> Decided (2026-09-25), chat family revision 0.2: **one chat, one invite.** The DHT is the rendezvous of every 1:1 chat and its floor; the apps upgrade to WebRTC, Iroh or HyperDHT when one connects, fall back to DHT text when none does, and come back by themselves. A person can keep a chat on DHT only. Chats with Ghostly 0.4 contacts keep working as compatibility chats ([402](402-legacy-chat.md)). The invite is one bech32m code, `ghostly1…`, also shared as `https://ghostly.tools/#ghostly1…`. Start at [400](400-chat.md); the invite is in [801](801-invitation-profiles.md).
>
> **Implemented today** (dev): every new chat is a chat session ([401](401-paired-chat.md)) over WebRTC, or Iroh/HyperDHT between desktops; short texts fall back to the DHT after a live link drops; DHT only per chat; held items; hosted local apps. **Being implemented:** the `ghostly1` invite and its ghostly.tools link; a first pairing with no direct path starting on the DHT and every chat upgrading by itself; calls in the chat session (today calls exist only in compatibility chats).

**All 31 entries remain Drafts.** The maintainer approved family-based numbering on 2026-09-22. This editorial migration does not assign new wire identifiers or claim new implementation support. See [numbering and compatibility](NUMBERING.md) for the old-to-new map and independent families. Future adapters need substantive contracts, not empty numbered placeholders.

Ghost is the minimal Pkarr/DHT rendezvous and small-record primitive. Ghostly is the reference application composing that primitive with local state, transports and capabilities. WISPs make those boundaries reviewable; this series does not rename the current wire protocol or expand the WISP acronym by decree.

## Read first

- [Adapter and ecosystem roadmap](ADAPTER-ROADMAP.md): broad candidate inventory, official sources, dependencies and release gates; candidate inventory, not implementation claims.
- [Implemented experimental paired-chat increment](PAIRED-CHAT-INCREMENT.md)
- [Native Iroh/HyperDHT transport increment](TRANSPORT-INCREMENT.md)
- [Process and required format](00-process.md)
- [Composable architecture map](MAP.md)
- [Implementation evidence and security limits](IMPLEMENTATION.md)
- [Interoperability plan](INTEROP.md)
- [Current implemented wire protocol](../PROTOCOL.md)

The implementation column is independent of document status. Existing features can be Draft documentation; proposed adapters are not shipped merely because their draft exists. New semantic envelopes in these documents are sketches, not assigned wire formats. Existing records/frames continue to mean what the implemented protocol specifies.

## Draft catalogue by family

| Candidate | Document | Status | Implementation evidence |
|---|---|---|---|
| [00](00-process.md) | WISP process and document format | Draft | Process proposal |
| [01](01-ghost-core.md) | Ghost Core Protocol | Draft | Existing rendezvous; modular boundary proposed |
| [02](02-peer-keys.md) | Peer Keys | Draft | Existing per-link keys; lifecycle extensions proposed |
| [03](03-capabilities.md) | Capability Negotiation | Draft | Existing advertisements; negotiation proposed |
| [04](04-profiles.md) | Local Profiles | Draft | Experimental: web and desktop; extension runs one profile |
| [05](05-backups.md) | Profile Backups | Draft | Experimental: whole-profile encrypted bundles, restore as a new profile |
| [100](100-transports.md) | Transport Negotiation | Draft | Rank-sum negotiation in every new chat; DHT floor, retry and upgrade being implemented |
| [101](101-webrtc.md) | WebRTC | Draft | Existing adapter behavior; WISP binding proposed |
| [102](102-iroh.md) | Iroh | Draft | Native chat-session adapter (desktop); local validation |
| [103](103-hyperdht.md) | HyperDHT | Draft | Native chat-session adapter (desktop); local validation |
| [200](200-payments.md) | Payment Negotiation | Draft | Existing payment frames; generic integration proposed |
| [201](201-cashu.md) | Cashu | Draft | Existing application integration |
| [202](202-arkade.md) | Ark via Arkade | Draft | Experimental test-network adapter; regtest verified; encrypted restore tested; exits pending |
| [203](203-lightning.md) | Lightning | Draft | Existing invoice integration |
| [204](204-bark.md) | Ark via Bark | Draft | Experimental, Testnet only; regtest verified; not compatible with Arkade; exits pending |
| [205](205-lnurl.md) | Lightning Addresses and LNURL-pay | Draft | Paying an address or LNURL through the Lightning source; strict checks; no receiving |
| [Fedimint · 2xx planned](2xx-fedimint.md) | Fedimint ecash and Lightning through a federation | Draft | Experimental, Testnet only; web SDK canary; regtest verified (ecash in chats, Lightning through the gateway); Mainnet off |
| [Spark · 2xx planned](2xx-spark.md) | Spark payments | Draft | Experimental: Spark to Spark (addresses and invoices) through the Breez SDK; Testnet on Breez's regtest; Mainnet behind a Breez API key |
| [300](300-peer-proofs.md) | Identity Proofs | Draft | Experimental Nostr subset |
| [301](301-nostr.md) | Nostr | Draft | Implemented experimental proof; signer/runtime limits below |
| [Nostr social · 3xx planned](3xx-nostr-social.md) | Nostr social layer | Draft | Experimental: profile, follows, notes on request; publication through the person's signer, off by default |
| [Pubky · 3xx planned](302-pubky.md) | Pubky | Draft | Local import experimental; Ring bridge blocked |
| [Keet · 3xx planned](303-keet.md) | Keet | Draft | Compatible local import experimental; app bridge blocked |
| [Domain · 3xx planned](3xx-domain.md) | Domain Proofs | Draft | Experimental provider: DNS TXT, /.well-known/ghostly.json, NIP-05 |
| [OpenPGP · 3xx planned](3xx-openpgp.md) | OpenPGP | Draft | Experimental provider `openpgp`; gpg-made vectors, contract suite and e2e |
| [Bitcoin address · 3xx planned](3xx-bitcoin.md) | Bitcoin Address Proof | Draft | Experimental provider: BIP-322 2.0.0 and legacy P2PKH, verified locally |
| [SSH · 3xx planned](3xx-ssh.md) | SSH keys | Draft | Experimental `ssh`, `ssh-github`, `ssh-gitlab` providers |
| [400](400-chat.md) | Chat Messaging | Draft | One chat on two layers: live link and DHT fallback today; DHT start and self-upgrade being implemented |
| [401](401-paired-chat.md) | Chat Session (formerly Paired Chat) | Draft | Layer-1 session of every new chat: WebRTC, native Iroh/HyperDHT where supported; DHT first contact, automatic upgrade and calls being implemented |
| [402](402-legacy-chat.md) | Compatibility Chat (formerly Legacy Timestamp Chat) | Draft; retained for compatibility | v0.4 and CLI clients; existing chats and v0.4 codes only |
| [403](403-dht-text.md) | DHT Text (formerly Bounded DHT Text) | Draft | Existing envelope, fallback after a drop and DHT only; first contact of every chat being implemented |
| [Store-and-forward · 4xx planned](4xx-store-and-forward.md) | Store-and-Forward for an Away Contact | Draft | Experimental `hold/1`: sealed items in the sender's own S3 storage, a signed DHT pointer; text, pictures and payment requests |
| [500](500-files.md) | File Transfer | Draft | Existing 1:1 transfer |
| [501](501-paired-files.md) | Chat Files (formerly Paired Files) | Draft | Every new chat's live link; WebRTC and supported native adapters |
| [502](502-legacy-files.md) | Compatibility File Frames | Draft; retained for compatibility | Compatibility chats only; both peers online |
| [600](600-media.md) | Voice and Video | Draft | 1:1 calls and screen sharing in compatibility chats; every chat being implemented |
| [601](601-webrtc-media.md) | WebRTC Media | Draft | Compatibility chats; capture varies by platform; chat session being implemented |
| [700](700-local-services.md) | Local Services | Draft | Existing HTTP proxy, in every chat (desktop and extension hosts) |
| [701](701-http-services.md) | HTTP Local Service Profile | Draft | Desktop/extension hosting in every chat (`ph` frames in the chat session); web viewer where supported |
| [800](800-invite-join.md) | Invite and Join | Draft | Existing bearer invite; admission protocol proposed |
| [801](801-invitation-profiles.md) | Implemented Invitation Profiles | Draft | Today pair1/pair2d plus v0.4 imports; one bech32m `ghostly1…` format being implemented |
| [900](900-group-sessions.md) | Group Session Negotiation | Draft | Contract of the first profile; implemented as `group-mesh/1`, text only |
| [Group Mesh · 9xx planned](9xx-group-mesh.md) | Group Mesh Distribution Profile | Draft | `group-mesh/1` and its entry link `group-entry/1`: core, engine and UI; unit and four-browser e2e; web, extension and desktop |
| [Group Community · 9xx planned](9xx-group-community.md) | Group Community Distribution Profile | Draft | `group-community/1`: a link anyone can open, admission by any member, elected hubs, up to 256 members; core, engine and UI; unit, six-browser e2e and a headless load test |
| [GossipSub · 9xx planned](901-gossipsub.md) | GossipSub Transport | Draft | Proposed; no adapter found |
| [1000](1000-storage.md) | Storage Contract | Draft | Experimental: object contract, naming and adapter rules |
| [1001](1001-local-storage.md) | Local File Storage | Draft | Experimental adapter |
| [1002](1002-s3-storage.md) | S3-Compatible Storage | Draft | Experimental adapter; local S3 server end-to-end |

Dependencies in headers describe the candidate modular design. Conditional dependencies are stated in the body (for example, existing media requires WebRTC). A document can refer to another without making its entire capability mandatory. In particular, 100 does not require a particular transport, 300 does not require an external identity, and 900 does not require GossipSub; the group mesh (9xx) is the first profile of 900 and 901 an optional later one. Group chat uses 400, group file sharing uses 500, and neither implies group payments or localhost permissions.

## Proposed milestones and exit evidence

1. **00-03, 100-101:** review process/Core/key lifecycle, then capability/transport agreement and the WebRTC binding. Exit: exact profiles and two independent implementations with downgrade, invite and reconnect tests.
2. **102-103:** demonstrate interchangeable data adapters using the same application capability. Exit: measured supported platforms, endpoint authentication and policy-respecting failure/fallback; not just sockets connecting.
3. **300-302:** demonstrate optional external proofs and no-proof sessions. Exit: independent verification, replay/rotation tests and explicit correlation tradeoffs. Keet remains gated by API feasibility in 303.
4. **Groups:** 800 and 901 remain review drafts; 900 has its first profile, the [group mesh](9xx-group-mesh.md), implemented for text between up to eight members. The authorized implementation sequence was the paired-chat base, then Iroh, then HyperDHT/Holepunch. The subsequently authorized proof sequence is Nostr, then Pubky, then Keet in 1:1 sessions. Nostr and explicit Pubky/Keet-compatible local imports are implemented experimentally; external Pubky/Keet signer bridges remain blocked. Group implementation still needs its own scope decision.

400, 500, 600, 700 and 200/201/203 document existing application capabilities and their modular evolution. These milestones do not promise implementation dates or claim that all adapters exist. Group security, topology and abuse limits must be validated before release claims.

## Out of scope for this series

The [local paired-chat base](PAIRED-CHAT-INCREMENT.md) and [native transport increment](TRANSPORT-INCREMENT.md) implement a bounded text-chat experiment separately from full draft conformance. No deployment, new wallet, public lobby or Ghostly OS is implemented. Preset wizards are product UX, not an extra WISP. PGP, passkeys/hardware signers, Tor research, centralized proofs, Bitcoin query/broadcast services and on-chain/Spark payment methods remain possible future work. [Ark via Arkade 202](202-arkade.md) documents the experimental implementation and real regtest evidence; exits and broader platform coverage remain release gates. The erroneous WebLN/gateway/backup/compliance catalogue is not adopted.

## Revision record

2026-09-25: chat family revision 0.2 (01, 03, 100 to 103, 400 to 403, 4xx, 500 to 502, 800, 801): one chat with a DHT floor and a peer-to-peer upgrade, one invite format, compatibility profiles for v0.4. Numbers, file names and wire identifiers unchanged; all entries remain Draft.

2026-09-22: approved editorial family migration; old reader URLs remain aliases; protocol identifiers and Draft status unchanged.

2026-09-20: initial review drafts; source audit distinguishes deployed legacy behavior from candidate modular/group architecture. See [evidence](IMPLEMENTATION.md) for scope and limitations.

## Optional Nostr proof increment (2026-09-20)

The [proof increment](PROOF-INCREMENT.md) now includes explicit experimental local imports for Pubky and Keet-compatible keys, alongside external-signer Nostr. Multiple proofs coexist per conversation. Ghostly participation remains the default. Pubky Ring and existing Keet account signer bridges remain unavailable; local key control is not evidence of those integrations. All WISPs remain Draft; earlier baseline inspections are historical.
