# WISP numbering and compatibility

All 48 specifications remain Draft. Family numbering was approved on 2026-09-22. This migration is editorial: wire capability names, versions, storage keys and implemented protocol behavior are unchanged.

## Independent families

| Range | Contract and scope |
|---|---|
| 00–99 | Foundations: process, Ghost Core, peer keys, common capabilities |
| 100–199 | Transport negotiation (100), WebRTC (101), Iroh (102), HyperDHT (103) |
| 200–299 | Payment negotiation (200), Cashu (201), experimental Arkade (202), Lightning (203), Bark (204), Lightning addresses (205) |
| 300–399 | Identity proofs (300; external proofs optional), Nostr (301), Pubky, Keet, domain, OpenPGP, Bitcoin address, SSH and OpenID Connect providers, and the Nostr social layer (3xx; planned, number to be defined) |
| 400–499 | Chat messaging (400), an independent application capability; store-and-forward for an away contact (4xx; planned, number to be defined) |
| 500–599 | File transfer (500), an independent application capability |
| 600–699 | Voice and video (600), an independent application capability |
| 700–799 | Local services (700), an independent application capability |
| 800–899 | Invite and join (800), an independent admission contract |
| 900–999 | Group session negotiation (900), the group mesh profile and optional GossipSub distribution (9xx; planned, number to be defined) |

202 documents the experimental Arkade integration, its regtest evidence and unfinished release gates. A document describing an adapter does not establish that an adapter is implemented. A vendor/plugin does not automatically require a WISP. These families are not a mandatory stack; DHT text has its own bounded delivery path and external identity remains optional.

## Migration table

Generated from [numbering.json](numbering.json); edit that source instead of this table.

| Previous draft | Current draft |
|---|---|
| 01 | [00](00-process.md) |
| 02 | [01](01-ghost-core.md) |
| 03 | [02](02-peer-keys.md) |
| 04 | [03](03-capabilities.md) |
| — 04 | [04](04-profiles.md) |
| — 05 | [05](05-backups.md) |
| 05 | [100](100-transports.md) |
| 06 | [101](101-webrtc.md) |
| 07 | [102](102-iroh.md) |
| 08 | [103](103-hyperdht.md) |
| 17 | [200](200-payments.md) |
| 18 | [201](201-cashu.md) |
| 202 | [202](202-arkade.md) |
| 19 | [203](203-lightning.md) |
| 204 | [204](204-bark.md) |
| 205 | [205](205-lnurl.md) |
| — | [2xx · fedimint · planned; number to be defined](2xx-fedimint.md) |
| 09 | [300](300-peer-proofs.md) |
| 10 | [301](301-nostr.md) |
| 11 | [3xx · pubky · planned; number to be defined](302-pubky.md) |
| 12 | [3xx · keet · planned; number to be defined](303-keet.md) |
| — | [3xx · domain · planned; number to be defined](3xx-domain.md) |
| — | [3xx · openpgp · planned; number to be defined](3xx-openpgp.md) |
| — | [3xx · bitcoin · planned; number to be defined](3xx-bitcoin.md) |
| — | [3xx · ssh · planned; number to be defined](3xx-ssh.md) |
| — | [3xx · oidc-proofs · planned; number to be defined](3xx-oidc-proofs.md) |
| — | [3xx · nostr-social · planned; number to be defined](3xx-nostr-social.md) |
| 13 | [400](400-chat.md) |
| 401 | [401](401-paired-chat.md) |
| 402 | [402](402-legacy-chat.md) |
| 403 | [403](403-dht-text.md) |
| — | [4xx · store-and-forward · planned; number to be defined](4xx-store-and-forward.md) |
| 14 | [500](500-files.md) |
| 501 | [501](501-paired-files.md) |
| 502 | [502](502-legacy-files.md) |
| 15 | [600](600-media.md) |
| 601 | [601](601-webrtc-media.md) |
| 16 | [700](700-local-services.md) |
| 701 | [701](701-http-services.md) |
| 20 | [800](800-invite-join.md) |
| 801 | [801](801-invitation-profiles.md) |
| 21 | [900](900-group-sessions.md) |
| — | [9xx · group-mesh · planned; number to be defined](9xx-group-mesh.md) |
| — | [9xx · group-community · planned; number to be defined](9xx-group-community.md) |
| 22 | [9xx · gossipsub · planned; number to be defined](901-gossipsub.md) |
| — 1000 | [1000](1000-storage.md) |
| — 1001 | [1001](1001-local-storage.md) |
| — 1002 | [1002](1002-s3-storage.md) |

## Link compatibility

New profile entries describe existing wire behavior, not new implementations. No empty numbered specifications are generated.

Old website reader URLs render the current document with a canonical link and a migration notice. Old raw Markdown URLs remain downloadable aliases. Existing section fragments remain usable; renamed top-level WISP headings have legacy anchor aliases. Catalogue fragments use current IDs first. Old numeric-only fragments 01/02/03 are ambiguous after the foundations migration; current numbering wins. Legacy full-slug reader URLs remain unambiguous. Repository forwarding documents preserve old Markdown links. No server redirect is required, including for a static export.
