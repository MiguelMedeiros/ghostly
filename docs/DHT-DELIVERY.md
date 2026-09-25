# DHT delivery for modern conversations

> **One chat, one invite (decided 2026-09-25, implemented).** Every chat runs this DHT delivery from its first contact, in parallel with a stream attempt, falls back to it whenever no stream connects, and upgrades to a stream by itself. There is one `ghostly1…` invite (shared as `https://ghostly.tools/#ghostly1…`) and DHT only is a per-chat choice in the Connection menu. See [WISP 400](wisps/400-chat.md), [WISP 403](wisps/403-dht-text.md), [WISP 03](wisps/03-capabilities.md) and [WISP 801](wisps/801-invitation-profiles.md).

Implementation contract for the current work. Integration and public-network validation are tracked separately; this document is not a release or security-audit claim.

## One conversation, two delivery methods

An invitation creates one conversation, participation identity, durable contact pin and message history, shared by the DHT and live streams. There is no delivery choice in the invite: a joined `pair2d/` code starts like any other and upgrades by itself. Prefix-less v0.4 codes still open a compatibility chat ([WISP 402](wisps/402-legacy-chat.md)).

A chat is `live` (a stream carries it), `on-dht` (no stream; retried in the background: at once when the contact is seen, then 20 s doubling to 3 min, forever while the app runs) or `dht-chosen` (either side chose DHT only). DHT only does not register native endpoints, start stream discovery or dial WebRTC/Iroh/HyperDHT. Changing delivery mode preserves the conversation and accepted pending message IDs.

Either side being DHT-only keeps both off live streams, so leaving it takes both, and each learns the other's choice from its envelopes. The contact's mailbox is read every 4 s while this side is DHT-only, for two minutes when a first contact shows up (a fresh packet of the contact, or right after joining) and while a text of ours awaits its receipt; every 10 s while the chat is open on the DHT; every 30 s in the background; every 5 minutes while live, and at once when the stream is lost. The slow periodic reads use the relays' background share. The relays allow a browser 30 requests a minute per relay, reads and publishes together, shared by every chat: the in-process harness measures the floor's reads at 0.4 a minute for a live chat and 1.8 a minute on the DHT, both sides together (`packages/core/test/oneChat.test.ts`). When the delivery mode changes, the new mode goes out in an envelope at once, not after the usual spacing between publications. After this side leaves DHT-only, it reads a contact that is still DHT-only every 4 s for two more minutes. A DHT-only contact runs no stream discovery, so as soon as it advertises itself on the link's Pkarr record again, its mailbox is read right away. Once neither side is blocked, the link is dialled or answered at once. A connection offer that came in while blocked is answered then, the wait between failed attempts starts over, and the side that does not dial watches fast for the offer. Once both sides have left, the stream is back in seconds rather than after a timed-out offer.

First contact runs on the DHT and on a stream at once; whichever verifies first pins the contact's participation key, and a different key on the other path is a security rejection that stops the chat on both layers. A first pairing whose streams do not connect ends `on-dht`, never `failed` (the pairing progress reserves `failed` for a key mismatch, a rejected session, a failed publish or being offline). A security rejection never triggers the fallback.

Each side also publishes a **capability record** ([WISP 03](wisps/03-capabilities.md#layer-0-capability-record)) on its own derived key: `dht-text/1`, `hold/1` when Hold messages is on, what layer 1 would carry, the minimum to dial its native transports (Iroh id, HyperDHT key, no addresses) and the shared name, sealed with the invite key before the pin and with the participation keys after it, signed, within 1,000 bytes. It is published at start, when it changes (changes within 30 s coalesce) and hourly; every envelope carries its revision as an optional ninth element, and the contact's record is read when that revision is newer, at a new pin and when the stream drops. While no session is open it gives the contact's name, hold consent and ways of paying, and the native transports to try without WebRTC first. A native transport that fails three attempts in a row is tried last for an hour.

## Invitation bootstrap and encryption

An invitation is a bearer capability. Its secret plus the ordered pair of rendezvous public keys derives, with HKDF-SHA256 and domain separation, a shared initial envelope key and two independent directional Pkarr mailbox identities. These mailboxes are separate from stream-discovery records.

Before the contact is pinned, an envelope is encrypted using the invitation-derived key. Its author signs the envelope using its independent participation identity. The signature binds both rendezvous roles, the intended recipient (`invite` for first contact), sequence, times, delivery mode, message and receipt. The receiver validates the signature, durably pins the first participation key, then stores content. Possession of the invite is sufficient to compete for first admission; share it privately. Optional comparison of the displayed code independently confirms the pinned keys.

After a peer key is known, envelope encryption additionally uses static X25519 agreement converted from the two Ed25519 participation identities, with the invitation key and domain separation in HKDF. `_dmk` contains the sender's public participation key encrypted under the invitation key; `_dm` contains the encrypted signed envelope. Knowing only a used invite does not decrypt this post-pin envelope. Participation private keys, plaintext and payment tokens are never published by this path.

This construction does **not** provide forward secrecy or post-compromise security. A transcript digest is not a secret and is not used as an encryption root. Changing a known participation key is rejected, not silently repinned.

## Packet and lifecycle limits

- Text only, at most 256 UTF-8 bytes. This is a ceiling: JSON escaping and authentication can exhaust the complete 1,000-byte DNS packet budget earlier. Preflight includes encryption, DNS encoding, a possible receipt and post-pin key hint. The signed relay packet adds 72 bytes. Oversized text is refused intact; there is no fragmentation or truncation.
- One outstanding text per direction. A second text waits in the outbox (`waiting`, "Sends when live" with a cancel) and goes when the first is confirmed or expires, or on a stream when one opens. Text over 256 bytes, files and Cashu/Lightning requests are held when both sides allow `hold/1` (in DHT only too), and otherwise wait for a live connection the same way; paying never waits.
- Message lifetime is five minutes from acceptance. At most eight publication attempts, with bounded backoff. Sequence, original expiry and attempt counters are saved before publishing and survive restarts. Changing mode does not reset the budget or extend the deadline.
- Control advertisements expire after ten minutes and refresh separately. Retrying an expired message is an explicit user action using the same stable ID and a new window.
- A publication is not a receipt. Only an authenticated receipt matching the stable ID marks delivery confirmed. Unconfirmed messages may already have arrived; retries deduplicate by durable message ID across DHT and streams.
- Receiver sequence state rejects replay. Content is durably stored before advancing this state or returning a receipt. A storage failure must not acknowledge uncommitted content.

Expiry means the application stops accepting/retransmitting the message. It does not erase other people's cached packets, screenshots or the recipient's local history. Availability and retention are best effort; both peers must get online within the usable window for delivery/receipt to complete.

## Platform and feature boundaries

Desktop uses its native Pkarr backend; browsers and extensions use HTTP Pkarr relays. A successful HTTP relay test does not independently prove Mainline UDP propagation. Relay/network observers can see addresses, timing and signed records; this is not network anonymity.

Files, calls, HTTP services and payment protocol operations travel only on authenticated live streams (or, for files and requests, a hold). Cashu bearer tokens are explicitly refused as DHT text. A short pasted Lightning invoice can fit as text, but publication does not initiate a payment. No personal funds are needed for QA.

The header reports the actual state ("Connected · WebRTC", "On DHT · retrying live", "DHT only · chosen by you" or "by your contact") separately from the preferred method. Existing conversations are never silently converted to a different profile; a compatibility chat offers "Continue in a new chat".

## Follow-up requested

Consider a Ghostly-operated Pkarr relay as an additional option after this delivery. The proposed destination is the server named Zero, running the relay in Docker with Cloudflare in front of HTTP/HTTPS. Mainline DHT UDP must reach the host/container directly with suitable firewall configuration; an HTTP proxy or Tunnel must not be assumed to carry that UDP traffic. Access, configuration and deployment authorization have not been verified. No infrastructure has been provisioned, and this is not a dependency for the current client integration.
