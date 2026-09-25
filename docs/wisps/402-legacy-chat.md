# WISP 402: Compatibility Chat (v0.4 Timestamp Profile)

| Field | Value |
|---|---|
| Candidate number | 402; editorial family allocation |
| Status | Draft |
| Revision | 0.2 |
| Updated | 2026-09-25 |
| Document kind | Profile |
| Disposition | Retained for compatibility: existing chats and v0.4 codes only; no new chat is created with it |
| Dependencies | [400](400-chat.md) |
| Implementation | Existing legacy 1:1 clients (v0.4 and earlier, the Rust CLI) and the read/write path kept in current apps |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Disposition (revision 0.2)

Formerly "Legacy Timestamp Chat". This profile is **not withdrawn**: withdrawing it would cut off every contact still on Ghostly 0.4 and every chat made with it. It is **retained for compatibility** with a narrowed scope:

- Chats that already use it keep working, both ways, over both of its layers (below). They are never silently converted to the one chat of [400](400-chat.md).
- A prefix-less invite code (the v0.4 format) pasted into a current app creates a chat in this profile, because the app that made the code speaks only this ([801](801-invitation-profiles.md#reading-an-invite)).
- A current app never creates a new chat, or a new invite, in this profile.

The number and file name stay, as [numbering](NUMBERING.md) requires.

## The same two layers, older wire

This profile already had the shape [400](400-chat.md) now specifies for every chat, without its authentication and delivery guarantees:

| Layer | In this profile | In the one chat |
|---|---|---|
| 0, the DHT | Encrypted `_msgs` batches on the link's own Pkarr record, timestamp acknowledgements, 500-byte input | Directional mailboxes and signed envelopes ([403](403-dht-text.md)), 256 bytes, per-message ids and receipts |
| 1, peer to peer | The legacy WebRTC data channel (`ghostly/1`), legacy frames, calls ([601](601-webrtc-media.md)), legacy files ([502](502-legacy-files.md)), hosted HTTP ([701](701-http-services.md)) | `paired-chat/1` over WebRTC, Iroh or HyperDHT ([401](401-paired-chat.md)) |
| Identity | The invite's rendezvous keys and shared secret only | A pinned participation key per side |

So a 0.4 contact keeps talking over DHT text: when the legacy WebRTC link does not connect, messages go through `_msgs` records, as they always have.

## Wire binding

Legacy live text is `{t:"m",ts,m}` on the data channel. Offline small-record text uses encrypted `_msgs` batches with timestamp acknowledgements. `LinkSession.sendMessage` limits input to 500 UTF-8 bytes; record packing can truncate a single message to 400 characters or omit older content to fit its total budget. The 500-byte input limit is therefore not a delivery guarantee. Live sender and parser bounds differ; callers must respect the tighter applicable bound.

Deduplication/high-water marks use timestamps, not collision-free sender message IDs. Handing buffered text to a live stream can clear the local buffer and emit an acknowledgement event; this MUST NOT be presented as remote durable storage or reading.

## Moving a compatibility chat to the one chat

There is no in-place upgrade: this profile has no participation keys to pin, and guessing that a contact runs a newer app would be a silent conversion. Proposed:

1. A current app marks a compatibility chat as such in its header ("Compatibility chat · older Ghostly").
2. Its menu offers **Continue in a new chat**: the app creates a one-chat invite and sends it as a message in this chat. A contact on a current app opens it and a new chat pairs as in [400](400-chat.md); a contact still on 0.4 sees a code its app cannot read ([801](801-invitation-profiles.md#reading-an-invite)) and a line explaining that it needs an update.
3. Once the new chat is paired, the old one says so and stays readable. Whether the two histories are shown as one thread is a UI decision, not a wire one.

## Compatibility and limitations

Keep legacy parsing separate from [the chat session 401](401-paired-chat.md) and [DHT text 403](403-dht-text.md). This profile makes no group fanout, durable mailbox or global single-use invite guarantee, and its holders of a copied invite obtain the chat's signing and decryption credentials. [LinkSession](../../packages/core/src/link.ts), [frames](../../packages/core/src/frames.ts), [record packing](../../packages/core/src/records.ts) and [implemented protocol](../PROTOCOL.md) define the concrete encoding. Test equal timestamps, packing limits and duplicate delivery across paths, and that a current app still exchanges text both ways with a v0.4 app over `_msgs` and over the legacy link.

## Revision log

- 0.2 (2026-09-25): renamed Compatibility Chat; retained, not withdrawn; scope narrowed to existing chats and v0.4 codes; layer mapping; proposed move to the one chat.
- 0.1 (2026-09-22): legacy timestamp chat profile.
