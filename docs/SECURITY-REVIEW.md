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
| S1 | High | Desktop | A contact's web app in a `ghostly-svc://` window could call every Tauri command (`local_fetch` to any loopback port): no ACL manifest, and Tauri treats app schemes as local | fixed: ACL manifest + capability for `main` only + `only_main` invoke guard. Proof: `cargo test` in src-tauri (`a_contacts_app_cannot_call_commands` fails on the old code) |
| S2 | High | Extension | Viewer intercepted every `*.ghostly.invalid` and all peers were one site: cross-peer requests as the user, cookie planting | fixed: `<svc>.<peer>.invalid` (peer = site), tab bound to its peer/service, `Domain` stripped from `Set-Cookie`. Proof: `npm run test:attacks -w @ghostly/extension` (3 of its attacks work on v0.3.1, none now) |
| S3 | High | Payments | Any `pay` with `rid` settled a request regardless of amount; test-mint ecash auto-added the test mint | fixed: full amount from a mint the request named; peers never add mints. Proof: `test:attacks` forges `pay` frames with test sats and with 5 sats claimed as 50 |
| S4 | High | Website | next 16.2.12 (RCE advisories), sharp 0.35.3 | fixed: next 16.3.3, sharp 0.35.4 |
| S5 | Med | App | Chat route `#/chat/<seed>/<peer>/<key>` put link secrets in history and Chrome Sync | fixed: `#/chat/<sessionId>`, secrets looked up from storage, invite URLs replaced on arrival |
| S6 | Med | App | Lock screen started unlocked after reload, app focusable under it, weak hash | fixed: starts locked, app not rendered or `inert` while locked, backoff, PBKDF2 600k with migration. Encryption at rest: see S18 |
| S7 | Med | Calls | `_call` fields went into the SDP unvalidated (line injection), no max age | fixed: `parseCallSignal`, 120 s window |
| S8 | Med | Files | Sent and received files shared a key space (peer could overwrite your file); no quota; peer MIME kept in blob; bidi names | fixed: `in`/`out` keys with local ids, 500 MiB per link, octet-stream unless raster preview, `\p{Cf}` stripped |
| S9 | Med | HTTP host | Redirects left the target; override headers (`X-HTTP-Method-Override`, …) passed; `%2f` escaped base path; req+rst bypassed the 32 limit | fixed. Left open: a browser host must follow redirects (it cannot see a manual one), so an open redirect in the shared app can still cause one blind local request (S20) |
| S10 | Med | Wallet | PENDING melt lost proofs; expired paid quotes deleted; in-flight proofs only in memory; reclaim race | fixed: in-flight proofs and melts persisted and reconciled with the mint, quotes checked before deletion, reclaims serialized (20 unit tests with a fake mint) |
| S11 | Med | Payments | Paying a request twice while the first ecash awaited an answer | fixed |
| S12 | Med | CI | Actions on movable tags, no dependency scanning, broad default token | fixed: SHA pins, Security workflow, Dependabot, read-only default |
| S13 | Med | Images | website on node 20 (EOL), web on nginx 1.27 | fixed: node 22, nginx 1.30 |
| S14 | Med | Protocol | Plaintext `_ts`/`_ack` let relays/DHT pair a link's two keys and time messages | open (needs a protocol change) |
| S15 | Low | Privacy | Google STUN always on, no relay-only mode; Google Analytics on the site | open |
| S16 | Low | Invite | Invite is a long-lived bearer secret, creator keeps the peer's seed, no forward secrecy | open |
| S17 | Low | CLI | `--seed`/`--key` on the command line (visible in `ps`, shell history) | open |
| S18 | Low | Storage | Seeds, messages and proofs are plaintext in localStorage/IndexedDB | open |
| S20 | Low | HTTP host | Browser hosts follow redirects and check the final URL afterwards: one blind request elsewhere on the machine via an open redirect in the shared app | open |
| S21 | Low | App | "Clear all data" keeps the wallet on purpose (ecash is money); a browser's global history may still list an invite URL opened once | accepted |
| S19 | Low | Deps | `lru` (via pkarr/mainline), `glib`/`unic-*`/`proc-macro-error` (via Tauri) | accepted until the dates in the allowlist |

### Routine run 2026-09-19 (area 3: UI and local storage)

Scanned: `package-lock.json`, `website/package-lock.json` and `Cargo.lock`. `scripts/security-scan.mjs` could not run here — this runner's egress policy answers 403 for `api.osv.dev` — so the same lock files were checked against `npm audit` (0 advisories in both trees) and against a clone of `rustsec/advisory-db` (8 advisories, all of them the ones already accepted in the allowlist, none expired). The scanner itself still runs in the Security workflow on every push, which is what the gate waits for.

Reviewed: everything merged since the first review, which is all dependency work (#25, #26, #30, #34, #40, #42, #43, #44, #45, #46, #50, #51). Every workflow `uses:` is still pinned to a commit (invariant 6). Two of those bumps touch code that matters here and both hold up: the rand 0.10 migration replaces `OsRng.fill_bytes` with `SysRng.try_fill_bytes` for link keys and secretbox nonces, which is the same OS generator and now fails loudly instead of quietly, with no fallback to a seeded one; and the pkarr 8 migration replaces `resolve_most_recent` with `resolve(…, ResolvePolicy::NetworkOnly)`, which that crate documents as "guaranteed to return the newest valid signed packet", so a relay or DHT node still cannot make a stale packet look current.

Then, in depth, the shared UI and what it keeps on the device: `src/` (lock screen, settings, session store, chat, message, file, invoice and service bubbles), the peer-facing display text in `packages/core` and the join bookkeeping in `packages/browser/src/platform`. Nothing in `src/` writes peer content into HTML: there is no `dangerouslySetInnerHTML`, `innerHTML` or `eval` anywhere, links are only ever built from `http(s)` matches, and `img-src` in all three clients' policies keeps inline images to the two picker sources, so a contact cannot use one as a tracking pixel.

| ID | Sev. | Area | Finding | Status |
|---|---|---|---|---|
| S22 | Low | App | The flag saying "I already announced myself on this chat" was written as `joinSent_<session id>`, outside the `ghostly` namespace and outside the profile prefix: deleting a chat and "Clear all data" both left one key per chat behind, each carrying the random id of a conversation that existed, readable by any other profile sharing the storage area | fixed: namespaced and profile-scoped, removed with the chat, and the old keys are taken over and swept. Proof: `npm test -w @ghostly/browser` (`test/storage.test.ts` fails on the old code) |
| S23 | Low | Protocol/App | Display text a contact chooses was shown as it arrived: `_nick` had no length cap at all (the `hello` frame's 64 was not applied to the record) and neither nicknames nor service names had invisible or direction-changing characters removed, though file names have since S8. A contact could make the name it is known by read as another contact's, and a long nickname was copied onto every message the client stores | fixed: one `sanitizeDisplayText` in `packages/core/src/text.ts` on every receive path (record, `hello` frame, service advertisement) and where the UI reads a name back out of a "joined" message. Emoji and the joiners Indic and Arabic scripts need are kept. Proof: `npm test -w @ghostly/core` (`test/text.test.ts` fails on the old code) |
| S24 | Low | Desktop | The Tauri builder has no `on_navigation` guard, so nothing in the app's own code stops the `main` window from being navigated away by a link in a contact's message. Tauri's ACL still refuses IPC from a remote origin, and `only_main` is by window label, so this is about the window being replaced, not about commands | open: could not be reproduced or fixed here (this runner has no GTK/WebKit, so `src-tauri` cannot even be compiled); needs checking against a real desktop build on each platform |

Checks run: `npm run lint` (0 errors), `npm run typecheck`, `npm test` (98 tests), `npm run build`, `npm run build:extension`, `npm run build:web`, `cargo fmt --check` for both crates, `cargo clippy --all-targets -- -D warnings` and `cargo test` for `cli`. Not run here: `clippy`/`test` for `src-tauri` (no GTK/WebKit in the runner) and the Playwright suites (`cdn.playwright.dev` is blocked, and with the runner's own Chromium both `test:attacks` and `test:e2e` stop at the first step that needs the DHT or a relay — unmodified `main` stops at exactly the same step). CI runs all of them.

### Verified on 2026-09-19

Unit and protocol tests (86), extension e2e, `test:attacks`, web e2e against the Docker image (nginx 1.30), delete-chats, Tauri IPC tests, CLI interop over the real network, website image (Next 16.3.3, node 22). Before/after: `test:attacks` against v0.3.1 has 3 attacks succeed; the Tauri viewer test fails on v0.3.1.

## How to prove a fix

Every fix is verified in the client it affects, not only in unit tests.

| Client | Command / method |
|---|---|
| Protocol | `npm test` (packages/core), `npm run test:interop` for Rust ↔ TS |
| Extension | `npm run test:e2e` (two browsers, data link, HTTP service, viewer, sats, calls); `npm run test:attacks -w @ghostly/extension` (a malicious contact) |
| Web | `node web/test/e2e.mjs`; headers: `curl -sI https://app.ghostly.tools` |
| Desktop | `cargo test --manifest-path src-tauri/Cargo.toml` (IPC against the real capabilities); end to end: `npm run tauri dev` + `node extension/test/desktop-attacks.mjs` |
| CLI | `cargo build -p ghostly-cli && GHOSTLY_CLI=target/debug/ghostly-cli npm run test:interop` (Rust ↔ TS over the real network) |
| Website | `cd website && npx next build`; after deploy, `curl -sI https://ghostly.tools` |
| Dependencies | `node scripts/security-scan.mjs` |

## The security routine

A scheduled Claude Code agent reviews the repository a few times a week. Each run:

1. reads this file, runs `node scripts/security-scan.mjs`, and reviews what changed since the last run plus one area in depth (rotating);
2. fixes what it can prove, with a test, on a `claude/security-auto-<date>` branch that also bumps the patch version and adds a changelog entry;
3. `security-autorelease.yml` then checks the branch (`scripts/autorelease-gate.mjs`: no CI or release changes, no new dependencies, size cap, one patch bump, one release per 20 h, CI and Security green), fast-forwards main to it (no pull request), tags it and publishes the release;
4. anything it cannot fix safely is added here as **open**.

The repository variable `SECURITY_AUTORELEASE` turns this down to `deps` (only dependency updates ship on their own) or `off`.
