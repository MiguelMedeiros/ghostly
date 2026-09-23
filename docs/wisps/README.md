# WISP working catalogue

> Release decision (2026-09-21): external identity proofs and external profile lookup are deferred. This release exposes only Ghostly participation identity. Nostr, Pubky, Keet, imports and Ring UI are disabled; previous experiments and stored data are preserved for future work. Descriptions below are historical/research, not available release features.

**All 31 entries remain Drafts.** The maintainer approved family-based numbering on 2026-09-22. This editorial migration does not assign new wire identifiers or claim new implementation support. See [numbering and compatibility](NUMBERING.md) for the old-to-new map and independent families. Future adapters need substantive contracts, not empty numbered placeholders.

Ghost is the minimal Pkarr/DHT rendezvous and small-record primitive. Ghostly is the reference application composing that primitive with local state, transports and capabilities. WISPs make those boundaries reviewable; this series does not rename the current wire protocol or expand the WISP acronym by decree.

## Read first

- [Adapter and ecosystem roadmap](ADAPTER-ROADMAP.md) — broad candidate inventory, official sources, dependencies and release gates; candidate inventory, not implementation claims.
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
| [100](100-transports.md) | Transport Negotiation | Draft | Experimental deterministic paired-chat negotiation |
| [101](101-webrtc.md) | WebRTC | Draft | Existing adapter behavior; WISP binding proposed |
| [102](102-iroh.md) | Iroh | Draft | Native paired-chat adapter; local validation |
| [103](103-hyperdht.md) | HyperDHT | Draft | Native paired-chat adapter; local validation |
| [200](200-payments.md) | Payment Negotiation | Draft | Existing payment frames; generic integration proposed |
| [201](201-cashu.md) | Cashu | Draft | Existing application integration |
| [202](202-arkade.md) | Ark via Arkade | Draft | Experimental test-network adapter; regtest verified; encrypted restore tested; exits pending |
| [203](203-lightning.md) | Lightning | Draft | Existing invoice integration |
| [204](204-bark.md) | Ark via Bark | Draft | Experimental, Testnet only; regtest verified; not compatible with Arkade; exits pending |
| [300](300-peer-proofs.md) | Identity Proofs | Draft | Experimental Nostr subset |
| [301](301-nostr.md) | Nostr | Draft | Implemented experimental proof; signer/runtime limits below |
| [Pubky · 3xx planned](302-pubky.md) | Pubky | Draft | Local import experimental; Ring bridge blocked |
| [Keet · 3xx planned](303-keet.md) | Keet | Draft | Compatible local import experimental; app bridge blocked |
| [400](400-chat.md) | Chat Messaging | Draft | Existing 1:1 messages; stronger semantics proposed |
| [401](401-paired-chat.md) | Paired Chat | Draft | Current paired WebRTC; native Iroh/HyperDHT where supported. |
| [402](402-legacy-chat.md) | Legacy Timestamp Chat | Draft | Existing legacy 1:1 clients. |
| [403](403-dht-text.md) | Bounded DHT Text | Draft | Modern DHT-only and explicitly permitted fallback paths; native DHT versus browser relays differ. |
| [500](500-files.md) | File Transfer | Draft | Existing 1:1 transfer |
| [501](501-paired-files.md) | Paired Files | Draft | Negotiated paired data links; WebRTC and supported native adapters. |
| [502](502-legacy-files.md) | Legacy File Frames | Draft | Legacy live data links; both peers online. |
| [600](600-media.md) | Voice and Video | Draft | Existing 1:1 calls and screen sharing |
| [601](601-webrtc-media.md) | WebRTC Media | Draft | Compatible legacy WebRTC chats; capture varies by platform; not current paired sessions. |
| [700](700-local-services.md) | Local Services | Draft | Existing HTTP proxy |
| [701](701-http-services.md) | HTTP Local Service Profile | Draft | Legacy desktop/extension hosting; web viewer where supported; not paired hosted HTTP. |
| [800](800-invite-join.md) | Invite and Join | Draft | Existing bearer invite; admission protocol proposed |
| [801](801-invitation-profiles.md) | Implemented Invitation Profiles | Draft | Current modern pair1/pair2d creation plus legacy imports. |
| [900](900-group-sessions.md) | Group Session Negotiation | Draft | Proposed; no group implementation found |
| [GossipSub · 9xx planned](901-gossipsub.md) | GossipSub Transport | Draft | Proposed; no adapter found |
| [1000](1000-storage.md) | Storage Contract | Draft | Experimental: object contract, naming and adapter rules |
| [1001](1001-local-storage.md) | Local File Storage | Draft | Experimental adapter |
| [1002](1002-s3-storage.md) | S3-Compatible Storage | Draft | Experimental adapter; local S3 server end-to-end |

Dependencies in headers describe the candidate modular design. Conditional dependencies are stated in the body (for example, existing media requires WebRTC). A document can refer to another without making its entire capability mandatory. In particular, 100 does not require a particular transport, 300 does not require an external identity, and 900 does not require GossipSub; 901 is an optional profile of 900. Group chat uses 400, group file sharing uses 500, and neither implies group payments or localhost permissions.

## Proposed milestones and exit evidence

1. **00–03, 100–101:** review process/Core/key lifecycle, then capability/transport agreement and the WebRTC binding. Exit: exact profiles and two independent implementations with downgrade, invite and reconnect tests.
2. **102–103:** demonstrate interchangeable data adapters using the same application capability. Exit: measured supported platforms, endpoint authentication and policy-respecting failure/fallback; not just sockets connecting.
3. **300–302:** demonstrate optional external proofs and no-proof sessions. Exit: independent verification, replay/rotation tests and explicit correlation tradeoffs. Keet remains gated by API feasibility in 303.
4. **Groups are documented now, implementation later:** 800, 900 and 901 remain review drafts. The authorized implementation sequence is the paired-chat base, then Iroh, then HyperDHT/Holepunch. The subsequently authorized proof sequence is Nostr, then Pubky, then Keet in 1:1 sessions. Nostr and explicit Pubky/Keet-compatible local imports are implemented experimentally; external Pubky/Keet signer bridges remain blocked. Group implementation still needs its own scope decision.

400, 500, 600, 700 and 200/201/203 document existing application capabilities and their modular evolution. These milestones do not promise implementation dates or claim that all adapters exist. Group security, topology and abuse limits must be validated before release claims.

## Out of scope for this series

The [local paired-chat base](PAIRED-CHAT-INCREMENT.md) and [native transport increment](TRANSPORT-INCREMENT.md) implement a bounded text-chat experiment separately from full draft conformance. No deployment, new wallet, public lobby or Ghostly OS is implemented. Preset wizards are product UX, not an extra WISP. PGP, passkeys/hardware signers, Tor research, centralized proofs, Bitcoin query/broadcast services and on-chain/Spark payment methods remain possible future work. [Ark via Arkade 202](202-arkade.md) documents the experimental implementation and real regtest evidence; exits and broader platform coverage remain release gates. The erroneous WebLN/gateway/backup/compliance catalogue is not adopted.

## Revision record

2026-09-22: approved editorial family migration; old reader URLs remain aliases; protocol identifiers and Draft status unchanged.

2026-09-20: initial review drafts; source audit distinguishes deployed legacy behavior from candidate modular/group architecture. See [evidence](IMPLEMENTATION.md) for scope and limitations.

## Optional Nostr proof increment (2026-09-20)

The [proof increment](PROOF-INCREMENT.md) now includes explicit experimental local imports for Pubky and Keet-compatible keys, alongside external-signer Nostr. Multiple proofs coexist per conversation. Ghostly participation remains the default. Pubky Ring and existing Keet account signer bridges remain unavailable; local key control is not evidence of those integrations. All WISPs remain Draft; earlier baseline inspections are historical.
