# WISP numbering and compatibility

All 57 specifications have the document status Draft; each says in its header what is implemented, and the [index](README.md) lists them all. Family numbering was approved on 2026-09-22. This migration is editorial: wire capability names, versions, storage keys and implemented protocol behavior are unchanged.

## Independent families

| Range | Contract and scope |
|---|---|
| 00-99 | Foundations: process (00), Ghost Core (01), peer keys (02), capabilities (03), local profiles (04), profile backups (05) |
| 100-199 | Transport negotiation (100), WebRTC (101), Iroh (102), HyperDHT (103) |
| 200-299 | Payment negotiation (200), Cashu (201), Arkade (202), Lightning (203), Bark (204), Lightning addresses (205), Spark (206), Fedimint (207) |
| 300-399 | Identity proofs (300; external proofs optional), Nostr (301), domain (304), OpenPGP (305), Bitcoin address (306), SSH (307), the Nostr social layer (309), the profile DID (did:dht, 310), DIDs (311), AT Protocol (Bluesky, 312); Pubky, Keet and OpenID Connect (3xx, numbers to be defined) |
| 400-499 | Chat messaging (400), chat session (401), compatibility chat (402), DHT text (403), store-and-forward for an away contact (404), status cards (405), message buttons (406) |
| 500-599 | File transfer (500), chat files (501), compatibility file frames (502) |
| 600-699 | Voice and video (600), WebRTC media (601) |
| 700-799 | Local services (700), HTTP local service profile (701) |
| 800-899 | Invite and join (800), invitation profiles (801) |
| 900-999 | Group session negotiation (900), group mesh (902), group community (903); optional GossipSub distribution (9xx, number to be defined) |
| 1000-1099 | Storage contract (1000), local file storage (1001), S3-compatible storage (1002) |
| 1100-1199 | Headless runtime and its local control API (1100); local only, nothing on the wire |
| 1200-1299 | Apps and plugins: packages, catalogs, indexers and installing apps found in them or sent in a chat (12xx, number to be defined) |

A document describing an adapter does not establish that an adapter is implemented. A vendor/plugin does not automatically require a WISP. These families are not a mandatory stack; DHT text has its own bounded delivery path and external identity remains optional.

## Migration table

Generated from [numbering.json](numbering.json); edit that source instead of this table.

| Previous draft | Current draft |
|---|---|
| 01 | [00](00-process.md) |
| 02 | [01](01-ghost-core.md) |
| 03 | [02](02-peer-keys.md) |
| 04 | [03](03-capabilities.md) |
| none | [04](04-profiles.md) |
| none | [05](05-backups.md) |
| none | [06](06-devices.md) |
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
| 2xx-spark | [206](206-spark.md) |
| 2xx-fedimint | [207](207-fedimint.md) |
| 09 | [300](300-peer-proofs.md) |
| 10 | [301](301-nostr.md) |
| 11 | [3xx · pubky · number to be defined](302-pubky.md) |
| 12 | [3xx · keet · number to be defined](303-keet.md) |
| 3xx-domain | [304](304-domain.md) |
| 3xx-openpgp | [305](305-openpgp.md) |
| 3xx-bitcoin | [306](306-bitcoin.md) |
| 3xx-ssh | [307](307-ssh.md) |
| none | [3xx · oidc-proofs · number to be defined](3xx-oidc-proofs.md) |
| 3xx-nostr-social | [309](309-nostr-social.md) |
| 3xx-did-dht | [310](310-did-dht.md) |
| 3xx-did | [311](311-did.md) |
| 3xx-atproto | [312](312-atproto.md) |
| 13 | [400](400-chat.md) |
| 401 | [401](401-paired-chat.md) |
| 402 | [402](402-legacy-chat.md) |
| 403 | [403](403-dht-text.md) |
| 4xx-store-and-forward | [404](404-store-and-forward.md) |
| 4xx-status-cards | [405](405-status-cards.md) |
| 4xx-message-buttons | [406](406-message-buttons.md) |
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
| 9xx-group-mesh | [902](902-group-mesh.md) |
| 9xx-group-community | [903](903-group-community.md) |
| 22 | [9xx · gossipsub · number to be defined](901-gossipsub.md) |
| none | [1000](1000-storage.md) |
| none | [1001](1001-local-storage.md) |
| none | [1002](1002-s3-storage.md) |
| 11xx-headless | [1100](1100-headless.md) |
| none | [12xx · marketplace · number to be defined](12xx-marketplace.md) |

## Link compatibility

New profile entries describe existing wire behavior, not new implementations. No empty numbered specifications are generated.

Old website reader URLs render the current document with a canonical link and a migration notice. Old raw Markdown URLs remain downloadable aliases. Existing section fragments remain usable; renamed top-level WISP headings have legacy anchor aliases. Catalogue fragments use current IDs first. Old numeric-only fragments 01/02/03 are ambiguous after the foundations migration; current numbering wins. Legacy full-slug reader URLs remain unambiguous. Repository forwarding documents preserve old Markdown links. No server redirect is required, including for a static export.
