# WISP 500 — File Transfer

| Field | Value |
|---|---|
| Candidate number | 500; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-20 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [03](03-capabilities.md), [100](100-transports.md) |
| Implementation | Existing 1:1 transfer |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Contract and concrete profiles

This document defines common responsibilities and proposed extensions. Exact implemented encodings and runtime limits belong to [501 · Paired Files](501-paired-files.md), [502 · Legacy File Frames](502-legacy-files.md). Supporting a concrete profile does not establish full conformance to this Draft.

## Implemented scope

See the concrete profiles above for current fields, limits, receipt semantics and runtime availability. Contract requirements below are separately reviewable; proposed extensions are not shipped merely because a profile exists.

## Candidate requirements

Retain bounded admission before allocation, backpressure, explicit cancellation/reset, exact length checks and local storage accounting. Names are display/download suggestions, never paths; sanitize and store under locally chosen IDs. No automatic execution. An enabled file capability does not authorize unlimited disk writes.

For other adapters, preserve these semantics through their framing and flow-control mapping. Group files are not multicast file chunks by default: announce bounded authenticated metadata over the group channel and negotiate bulk transfer off the DHT with willing peers. Group access and encryption require 900; the existing pairwise profile does not provide them.

## Compatibility, security and open decisions

Preserve existing framing as a versioned profile. Paired 501 implements a SHA-256 integrity check and final durable-storage receipt; legacy 502 does not. Resume, multi-source content addressing, offline download and group distribution remain unsupported. Choose their semantics before advertising support. Cancelled partial files must release quota; MIME labels are untrusted.

## Conformance

Exact size, excess/truncated body, duplicate ID, malicious filename, disk quota, cancel from either end and idle timeout across two implementations. Check disconnect cleanup and no DHT bulk fallback. Existing [file tests](../../packages/core/test/files.test.ts) are supporting coverage, not full independent conformance.

## References

[FileTransfers](../../packages/core/src/files.ts), [frames and limits](../../packages/core/src/frames.ts), [current protocol](../PROTOCOL.md).
