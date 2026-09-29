# WISP 500: File Transfer

| Field | Value |
|---|---|
| Candidate number | 500; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [03](03-capabilities.md), [100](100-transports.md) |
| Implementation | 1:1 transfer in every chat: `files/3` (any size) and `files/2` on the chat session ([501](501-paired-files.md)), held files while not live ([4xx](4xx-store-and-forward.md)), [502](502-legacy-files.md) frames in compatibility chats |
| Summary | Send a file straight to a contact, checked and acknowledged on arrival. |
| Availability | Available |
| Notes | Any size, with both people online; above 25 MB the receiver accepts first, and a transfer resumes where it stopped. Chats with 0.4 contacts: up to 100 MiB. |
| Feature | [Send files](https://ghostly.tools/#next) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Files in the one chat (revision 0.2)

In the one chat of [400](400-chat.md), a file (a voice message included) travels over layer 1 with [501](501-paired-files.md), or, while the chat is not `live`, in a hold ([4xx](4xx-store-and-forward.md), at most 8 MiB) when both sides allow it. It never travels in DHT records, split or whole: the floor of [403](403-dht-text.md) carries text only. With neither available, the file waits in the sender's outbox with a cancel ("Sends when live") and goes when layer 1 is back. Queued files count against the sender's own storage, not the contact's quota.

[502](502-legacy-files.md) is kept for compatibility chats only.

## Contract and concrete profiles

This document defines common responsibilities and proposed extensions. Exact implemented encodings and runtime limits belong to [501 · Chat Files](501-paired-files.md) and, for compatibility chats, [502 · Compatibility File Frames](502-legacy-files.md). Supporting a concrete profile does not establish full conformance to this Draft.

## Implemented scope

See the concrete profiles above for current fields, limits, receipt semantics and runtime availability. Contract requirements below are separately reviewable; proposed extensions are not shipped merely because a profile exists.

## Candidate requirements

Retain bounded admission before allocation, backpressure, explicit cancellation/reset, exact length checks and local storage accounting. A file larger than an implementation takes by itself needs its person's consent before any byte is written; the size limit is the receiver's storage, which it advertises, not a constant. Received bytes should go to storage as they arrive rather than be gathered in memory. Names are display/download suggestions, never paths; sanitize and store under locally chosen IDs. No automatic execution. An enabled file capability does not authorize unlimited disk writes.

For other adapters, preserve these semantics through their framing and flow-control mapping. Group files are not multicast file chunks by default: announce bounded authenticated metadata over the group channel and negotiate bulk transfer off the DHT with willing peers. Group access and encryption require 900; the existing pairwise profile does not provide them.

## Compatibility, security and open decisions

Preserve existing framing as a versioned profile. Paired 501 implements a SHA-256 integrity check and final durable-storage receipt; legacy 502 does not. Since revision 0.3, 501's `files/3` resumes from the stored offset, asks the receiver's person before a large file and advertises the space the receiver has. Multi-source content addressing, offline download and group distribution remain unsupported. Choose their semantics before advertising support. Cancelled partial files must release quota; MIME labels are untrusted.

## Conformance

Exact size, excess/truncated body, duplicate ID, malicious filename, disk quota, cancel from either end and idle timeout across two implementations. Check disconnect cleanup and no DHT bulk fallback. Existing [file tests](../../packages/core/test/files.test.ts) are supporting coverage, not full independent conformance.

## References

[FileTransfers](../../packages/core/src/files.ts), [frames and limits](../../packages/core/src/frames.ts), [current protocol](../PROTOCOL.md).

## Revision log

One file per change in [changes/500-files/](changes/500-files/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
