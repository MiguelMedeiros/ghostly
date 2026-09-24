# DHT delivery for modern conversations

Implementation contract for the current work. Integration and public-network validation are tracked separately; this document is not a release or security-audit claim.

## One conversation, two delivery methods

A modern invitation creates the same conversation, participation identity, durable contact pin and message history used by live streams. `pair1/` chooses streams initially; `pair2d/` chooses DHT-only from the first start. Existing legacy invitations remain readable, but new creation produces modern invitations.

DHT-only does not register native endpoints, start stream discovery, dial WebRTC/Iroh/HyperDHT, or upgrade automatically. Stream fallback between those three transports remains a separate preference. Changing delivery mode preserves the conversation and accepted pending message IDs.

Either side being DHT-only keeps both off live streams, so leaving it takes both, and each learns the other's choice from its envelopes. The mailbox is read every 4 s while this side is DHT-only and every 30 s otherwise. When the delivery mode changes, the new mode goes out in an envelope at once, not after the usual spacing between publications. After this side leaves DHT-only, it reads a contact that is still DHT-only every 4 s for two more minutes. A DHT-only contact runs no stream discovery, so as soon as it advertises itself on the link's Pkarr record again, its mailbox is read right away. Once neither side is blocked, the link is dialled or answered at once. A connection offer that came in while blocked is answered then, the wait between failed attempts starts over, and the side that does not dial watches fast for the offer. Once both sides have left, the stream is back in seconds rather than after a timed-out offer.

When streams are preferred but unavailable, short text may use DHT only after the contact is authenticated and has advertised DHT support. The recipient can still prefer streams. A security rejection must not trigger this fallback. First contact without any stream requires the explicit DHT invitation mode.

## Invitation bootstrap and encryption

An invitation is a bearer capability. Its secret plus the ordered pair of rendezvous public keys derives, with HKDF-SHA256 and domain separation, a shared initial envelope key and two independent directional Pkarr mailbox identities. These mailboxes are separate from stream-discovery records.

Before the contact is pinned, an envelope is encrypted using the invitation-derived key. Its author signs the envelope using its independent participation identity. The signature binds both rendezvous roles, the intended recipient (`invite` for first contact), sequence, times, delivery mode, message and receipt. The receiver validates the signature, durably pins the first participation key, then stores content. Possession of the invite is sufficient to compete for first admission; share it privately. Optional comparison of the displayed code independently confirms the pinned keys.

After a peer key is known, envelope encryption additionally uses static X25519 agreement converted from the two Ed25519 participation identities, with the invitation key and domain separation in HKDF. `_dmk` contains the sender's public participation key encrypted under the invitation key; `_dm` contains the encrypted signed envelope. Knowing only a used invite does not decrypt this post-pin envelope. Participation private keys, plaintext and payment tokens are never published by this path.

This construction does **not** provide forward secrecy or post-compromise security. A transcript digest is not a secret and is not used as an encryption root. Changing a known participation key is rejected, not silently repinned.

## Packet and lifecycle limits

- Text only, at most 256 UTF-8 bytes. This is a ceiling: JSON escaping and authentication can exhaust the complete 1,000-byte DNS packet budget earlier. Preflight includes encryption, DNS encoding, a possible receipt and post-pin key hint. The signed relay packet adds 72 bytes. Oversized text is refused intact; there is no fragmentation or truncation.
- One outstanding text per direction. Other drafts remain in the composer until a receipt or expiry permits a new send.
- Message lifetime is five minutes from acceptance. At most eight publication attempts, with bounded backoff. Sequence, original expiry and attempt counters are saved before publishing and survive restarts. Changing mode does not reset the budget or extend the deadline.
- Control advertisements expire after ten minutes and refresh separately. Retrying an expired message is an explicit user action using the same stable ID and a new window.
- A publication is not a receipt. Only an authenticated receipt matching the stable ID marks delivery confirmed. Unconfirmed messages may already have arrived; retries deduplicate by durable message ID across DHT and streams.
- Receiver sequence state rejects replay. Content is durably stored before advancing this state or returning a receipt. A storage failure must not acknowledge uncommitted content.

Expiry means the application stops accepting/retransmitting the message. It does not erase other people's cached packets, screenshots or the recipient's local history. Availability and retention are best effort; both peers must get online within the usable window for delivery/receipt to complete.

## Platform and feature boundaries

Desktop uses its native Pkarr backend; browsers and extensions use HTTP Pkarr relays. A successful HTTP relay test does not independently prove Mainline UDP propagation. Relay/network observers can see addresses, timing and signed records; this is not network anonymity.

Files, calls, HTTP services and payment protocol operations require authenticated live streams. Cashu bearer tokens are explicitly refused as DHT text. A short pasted Lightning invoice can fit as text, but publication does not initiate a payment. No personal funds are needed for QA.

The header reports the actual delivery method separately from the preferred method. New/Join and the real QR share the parser-valid invitation, including initial DHT mode. Existing conversations are never silently converted to a different profile.

## Follow-up requested

Consider a Ghostly-operated Pkarr relay as an additional option after this delivery. The proposed destination is the server named Zero, running the relay in Docker with Cloudflare in front of HTTP/HTTPS. Mainline DHT UDP must reach the host/container directly with suitable firewall configuration; an HTTP proxy or Tunnel must not be assumed to carry that UDP traffic. Access, configuration and deployment authorization have not been verified. No infrastructure has been provisioned, and this is not a dependency for the current client integration.
