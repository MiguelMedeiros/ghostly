# Security review log

What we know about Ghostly's security, what was fixed, how it was proven, and what is still open. The security routine reads this file before every run and updates it after. People reporting a vulnerability: see [SECURITY.md](../SECURITY.md).

## Threat model

| Attacker | Can | Must not be able to |
|---|---|---|
| **Linked contact** (holds a link with you) | send any frame, record, file, payment, web app | run code in the app, reach your local services or other contacts' apps, take or fake money, overwrite your data, fill your disk |
| **Relay / DHT node** | see signed, encrypted packets and who polls which key; withhold or replay old packets | read or forge records, make a stale signal act as a new one |
| **Network attacker** | see and delay traffic | read or alter traffic, impersonate a peer |
| **Malicious web page** (any site the user visits) | message the browser | drive the extension, read keys, frame the app |
| **Mint** | answer wallet requests | make the wallet lose or double-count proofs |
| **Supply chain** | publish a bad dependency or action version | get it into a release unnoticed |

## Invariants to check every review

1. Everything a contact sends is validated before use (frames, `_svc`, `_rtc`, `_call`, files, payments); nothing reaches an SDP, a URL, a header, a file path or the DOM raw.
2. Code a contact serves (web apps in the viewer) runs in an origin of its own, per peer: no Tauri IPC, no `chrome.*`, no other peer's origin, no cookies across peers.
3. The HTTP host keeps every guarantee in [PROTOCOL.md §6.4](PROTOCOL.md): loopback only, no escaping the base path, no redirects off target, no host credentials, limits hold.
4. A payment request is settled only by the full amount from a mint the request named; ecash is never lost or counted twice (persist before sending, reconcile after).
5. Secrets (seeds, link keys, wallet proofs) never land in URLs, history, logs or third-party requests.
6. CI actions are pinned to commits; `scripts/security-scan.mjs` is clean except for entries in `.github/security-allowlist.json`.

## Findings

Status: **open**, **fixed** (merged, with the proof), **accepted** (with why).

### 2026-09-19: first full review (v0.3.1)

| ID | Sev. | Area | Finding | Status |
|---|---|---|---|---|
| S1 | High | Desktop | A contact's web app in a `ghostly-svc://` window could call every Tauri command (`local_fetch` to any loopback port): no ACL manifest, and Tauri treats app schemes as local | fixed: ACL manifest + capability for `main` only + `only_main` invoke guard |
| S2 | High | Extension | Viewer intercepted every `*.ghostly.invalid` and all peers were one site: cross-peer requests as the user, cookie planting | fixed: `<svc>.<peer>.invalid` (peer = site), tab bound to its peer/service, `Domain` stripped from `Set-Cookie` |
| S3 | High | Payments | Any `pay` with `rid` settled a request regardless of amount; test-mint ecash auto-added the test mint | fixed: full amount from a mint the request named; peers never add mints |
| S4 | High | Website | next 16.2.12 (RCE advisories), sharp 0.35.3 | fixed: next 16.3.3, sharp 0.35.4 |
| S5 | Med | App | Chat route `#/chat/<seed>/<peer>/<key>` put link secrets in history and Chrome Sync | fix in progress |
| S6 | Med | App | Lock screen started unlocked after reload, app focusable under it, weak hash | fix in progress (encryption at rest: open) |
| S7 | Med | Calls | `_call` fields went into the SDP unvalidated (line injection), no max age | fixed: `parseCallSignal`, 120 s window |
| S8 | Med | Files | Sent and received files shared a key space (peer could overwrite your file); no quota; peer MIME kept in blob; bidi names | fixed: `in`/`out` keys, 500 MiB per link, octet-stream unless raster preview, `\p{Cf}` stripped |
| S9 | Med | HTTP host | Redirects left the target; override headers (`X-HTTP-Method-Override`, …) passed; `%2f` escaped base path; req+rst bypassed the 32 limit | fixed |
| S10 | Med | Wallet | PENDING melt lost proofs; expired paid quotes deleted; in-flight proofs only in memory; reclaim race | fix in progress |
| S11 | Med | Payments | Paying a request twice while the first ecash awaited an answer | fixed |
| S12 | Med | CI | Actions on movable tags, no dependency scanning, broad default token | fixed: SHA pins, Security workflow, Dependabot, read-only default |
| S13 | Med | Images | website on node 20 (EOL), web on nginx 1.27 | fixed: node 22, nginx 1.30 |
| S14 | Med | Protocol | Plaintext `_ts`/`_ack` let relays/DHT pair a link's two keys and time messages | open (needs a protocol change) |
| S15 | Low | Privacy | Google STUN always on, no relay-only mode; Google Analytics on the site | open |
| S16 | Low | Invite | Invite is a long-lived bearer secret, creator keeps the peer's seed, no forward secrecy | open |
| S17 | Low | CLI | `--seed`/`--key` on the command line (visible in `ps`, shell history) | open |
| S18 | Low | Storage | Seeds, messages and proofs are plaintext in localStorage/IndexedDB | open |
| S19 | Low | Deps | `lru` (via pkarr/mainline), `glib`/`unic-*`/`proc-macro-error` (via Tauri) | accepted until the dates in the allowlist |

## How to prove a fix

Every fix is verified in the client it affects, not only in unit tests.

| Client | Command / method |
|---|---|
| Protocol | `npm test` (packages/core), `npm run test:interop` for Rust ↔ TS |
| Extension | `npm run test:e2e` (two browsers, data link, HTTP service, viewer) |
| Web | `node web/test/e2e.mjs`; headers: `curl -sI https://app.ghostly.tools` |
| Desktop | `npm run tauri dev` with a web or extension peer; a shared app that tries `__TAURI_INTERNALS__.invoke` must be refused |
| CLI | `cargo test --manifest-path cli/Cargo.toml`, then a real message to a web peer |
| Website | `cd website && npx next build`; after deploy, `curl -sI https://ghostly.tools` |
| Dependencies | `node scripts/security-scan.mjs` |

## The security routine

A scheduled Claude Code agent reviews the repository a few times a week. Each run:

1. reads this file, runs `node scripts/security-scan.mjs`, and reviews what changed since the last run plus one area in depth (rotating);
2. fixes what it can prove, with a test, on a `claude/security-auto-<date>` branch that also bumps the patch version and adds a changelog entry;
3. `security-autorelease.yml` then checks the branch (`scripts/autorelease-gate.mjs`: no CI or release changes, no new dependencies, size cap, one patch bump, one release per 20 h, CI and Security green), merges, tags and publishes the release;
4. anything it cannot fix safely is added here as **open**.

The repository variable `SECURITY_AUTORELEASE` turns this down to `deps` (only dependency updates ship on their own) or `off`.
