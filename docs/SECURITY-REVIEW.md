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

### Disclosure: nothing unfixed is described in public

This repository is public, so anything written here or in an issue or pull request is readable by an attacker the moment it lands. A finding that is **open**, or **fixed but not yet released**, is a working recipe against every user running the current version.

- **Never** open a public issue or pull request that describes an unfixed or unreleased flaw, and never leave a security issue open. `SECURITY.md` asks reporters not to; the repository's own practice has to match.
- The private channel is GitHub **private vulnerability reporting** (enabled) and a **draft security advisory**: the advisory carries the detail, its **private fork** carries the fix, and the advisory is published only after the release is out and people have had a chance to update.
- Findings recorded here while still **open** are written as the shape of the problem and the invariant it touches — not as steps to reproduce it, and not with the code path that makes it work. The reproduction lives in the private advisory.
- A finding that can be fixed and proven ships straight through the autorelease gate; that is the preferred path, because a released fix is also the shortest disclosure window.

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
| S19 | Low | Deps | `lru` (via pkarr/mainline), `glib`/`unic-*`/`proc-macro-error` (via Tauri) | accepted until the dates in the allowlist. Upstream-blocked, verified: `glib 0.18.5` (`RUSTSEC-2024-0429`) is fixed in `>=0.20.0`, but the Tauri 2 Linux stack needs the GTK3 `0.18` generation — remove when Tauri/Wry ships a Linux path on `glib >=0.20`. `lru 0.16.4` (`RUSTSEC-2026-0253`) comes through `mainline`, which still declares `lru ^0.16.2` even on 8.0.0, so a `pkarr 8` migration would not close it — remove when `mainline` moves to a fixed `lru`. Neither is vendored or forked to silence the alert |

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

### Routine run 2026-09-19, second (Desktop, following S24)

A second run the same day, on a runner where `src-tauri` does build: the GTK and WebKit packages install here, so `cargo clippy` and `cargo test` for `src-tauri` ran for the first time since the routine started, and S24 could finally be looked at.

The dependency picture is the one above and has not moved: `api.osv.dev` is still refused by this runner's egress policy, `npm audit` is clean in both trees, and `Cargo.lock` against `rustsec/advisory-db` gives exactly the eight accepted advisories, none expired. Nothing to update. The commits since that run are its own release (0.3.3) and #53.

Looking at S24 from the window rather than from the link turned up a real one, S25 below: the Tauri viewer decides where a request goes from the window's label, which was written down as the thing that keeps contacts apart, but nothing checked that the request was still *for* that window's address, and an origin is the address, not the label. S24 itself stays open: it is about the `main` window being replaced by a link, which is a different question and needs a real desktop build on each platform to judge, plus somewhere for an external link to go once it is refused.

| ID | Sev. | Area | Finding | Status |
|---|---|---|---|---|
| S25 | High | Desktop | A viewer window is bound to one contact and service by its label, and `viewer::handle` read only that label: nothing checked that the URL asked for was the one the window was opened for. A contact's app could navigate or frame `ghostly-svc://<service>.<other contact>/`, still be served by its own contact — the routing goes by label — and so run its own code in the other contact's origin, where that app keeps its storage, cookies and any session it holds. Invariant 2 ("no other peer's origin") and the Desktop counterpart of S2 | fixed: `handle` refuses any host that is not the window's own `<service>.<peer>` (and the `<scheme>.<service>.<peer>` spelling Windows and Android use) before anything is served there. Proof: `cargo test --manifest-path src-tauri/Cargo.toml` (`viewer::tests::another_contacts_origin_is_refused`; on the old code it gets 504 instead of 403, because the request is routed to the contact and only the timeout ends it) |

Checks run: `npm run lint`, `npm run typecheck`, `npm test` (98), `npm run build`, `npm run build:extension`, `npm run build:web`, and for both crates `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` — `src-tauri` included this time, 4 tests. Still not run: the Playwright suites; the browsers here do start, and the two peers do link up over the relays, but there is no UDP out of this runner, so the data link never opens and the suites stop at the first step that needs it.

This is a review branch, not an automatic release: 0.3.3 went out minutes earlier and the gate allows one automatic release per 20 hours, so the fix is left for a person to ship.

### Verified on 2026-09-19

Unit and protocol tests (86), extension e2e, `test:attacks`, web e2e against the Docker image (nginx 1.30), delete-chats, Tauri IPC tests, CLI interop over the real network, website image (Next 16.3.3, node 22). Before/after: `test:attacks` against v0.3.1 has 3 attacks succeed; the Tauri viewer test fails on v0.3.1.

### Routine run 2026-09-21 (area 5: CLI and Desktop Rust)

Scanned: `package-lock.json`, `website/package-lock.json` and `Cargo.lock`. `scripts/security-scan.mjs` still cannot run here — this runner's egress policy answers 403 for `api.osv.dev` — so the same lock files went through `npm audit` (0 advisories in both trees) and `cargo audit` against a fresh `rustsec/advisory-db` (1254 advisories, 572 crates in one workspace lock that covers both crates): **0 vulnerabilities**, 8 advisory warnings, and those 8 are exactly the distinct entries in `.github/security-allowlist.json`, none past its `until` date. Nothing to update.

Two of them were re-checked rather than carried over. `lru` is still the S19 case and still cannot be closed from here: `pkarr 8.0.1` has itself moved to `lru 0.18.4`, but `mainline 8.0.0` — the only other route in — still declares `^0.16`, `0.16.4` is the newest of that line, and no newer `mainline` is published, so both versions sit in the lock and the unsound one stays. `glib` is unchanged at 0.18.5. `cargo audit` also reported a yanked crate, naming `wasm-bindgen` on one run and `js-sys` on the next; both are wasm-target-only edges that `cargo tree` finds in no native build graph, and the registry lookup behind that check answers 503 through this runner's proxy, so it is noise rather than a finding.

Reviewed: everything merged since the last run — 0.4.0 and the work in it (#57 to #67). Most is UI and calls, but three pieces touch findings already marked fixed, so those were re-checked instead of trusted:

- **#59 gave Desktop an updater, and with it two plugins and three permissions in the capability file** — the first change to that file since S1. It still reads `"windows": ["main"]`, `only_main` still wraps the whole invoke handler, `build.rs` declares the new `updater_can_install` so it is checked like the rest, and both IPC tests pass. This matters more than the diff looks: plugin commands (`updater:default`, `process:allow-restart`) never pass through `invoke_handler`, so `only_main` is not what keeps them away from a contact's window — the capability's window list is, on its own. The update path holds up: the manifest is fetched over HTTPS and every bundle has to verify against the minisign key built into the app, `scripts/updater-manifest.mjs` refuses to publish a release with an unsigned platform, and a bundle that does not match its signature is refused rather than installed. What the browser clients read instead is parsed by `checkVersionFeed`, which caps the body at 4 KiB, reads two string fields and nothing else, and puts the version through `compareVersions`, where anything that is not three numbers sorts as older and so never reads as an update. The download link is a constant, never a field from the feed.
- **#64 moved chats out of the router** and hung the call window on a layer of its own. That layer is inside `LockGate`, which still renders `inert` and `aria-hidden` while locked, and the lock screen now sits above the call, so S6 holds. `UpdateProvider` is inside the gate too, which is what keeps the update check — a request that says this device runs Ghostly — from going out before the password. `src/lib/url.ts` still addresses a chat by session id and only takes keys out of an arriving invite, so S5 holds.
- **#67 is a chore commit that edited call-signal code**, which is worth recording as read: it only drops a parameter `buildSdpFromSignal` never looked at. `parseCallSignal` is untouched, and #62's v2 additions (`v`, `k`) are checked against exact values before anything is kept.

Then, in depth, the CLI and the Desktop Rust. The WebKitGTK packages install on this runner, so `src-tauri` built here and its `clippy` and `cargo test` ran. Nothing new was found. What was checked and holds:

- **The viewer** (S25) refuses any host that is not the window's own `<service>.<peer>`, in both spellings, before anything is served there. Frames and subresources are covered with it, since a frame inside a viewer window carries that window's label, and the main window is not in the map at all. Neither a port nor a host spelling that is not byte-equal widens it in either direction: each of those fails closed.
- **A contact's response headers** reach the viewer without `decodeControl` checking more than their types and lengths, but the `http` crate refuses a malformed name or a value carrying CR, LF or NUL, and `handle` turns that refusal into a 502 — so nothing splits a header there. Checked against `http` directly rather than assumed. A peer only ever shapes the response for its own origin in any case.
- **`local_fetch`** takes only `http`/`https` on a loopback host and never follows a redirect; everything that is not plainly loopback fails closed. Credentials in a target are refused on the TypeScript side (`parseLocalTarget`, `resolveTargetUrl`) rather than in Rust, and nothing a peer sends reaches that far: a path may not begin with `//`, and the origin and base path are re-checked after normalization.
- **Desktop does not strip `Domain` from a contact's `Set-Cookie`, where the extension has since S2.** That difference is fine to leave: a viewer origin ends in the contact's own public key, so two contacts' hosts share no suffix at all, and the widest `Domain` a contact may set reaches only its own other services.
- **The CLI** prints peer text and nicknames as JSON, where `serde_json` escapes every control character, so a contact cannot put an escape sequence on a bot's terminal. `parse_invite` validates nothing itself, but every value it returns is checked where it is used (z-base-32 for the key, 32 bytes for the secret), so a malformed invite fails at use rather than travelling. It has no tests of its own, which is worth fixing when something there next changes. S17 is unchanged: `--seed` and `--key` are still arguments, and the fix (reading them from the environment or stdin) wants the interop suite to prove it, which this runner cannot run.

S24 stays open. The ways a contact could reach it are narrower than they first look, but whether a navigation guard would break how the app opens a link still needs a real desktop build on each platform — not something to change blind on a branch that releases itself.

Checks run: `npm run lint` (0 errors), `npm run typecheck`, `npm test` (115 passed, 1 skipped), `npm run build`, `npm run build:extension`, `npm run build:web`, and for both crates `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` — `src-tauri` included, 4 tests. Not run: the Playwright suites. `cdn.playwright.dev` is blocked, so the pinned browser cannot be fetched, and the Chromium this runner ships is a different build from the one this Playwright expects; even with it there is no UDP out of here, so the data link never opens and both suites stop at the first step that needs it. `website/` did not change, so its build was not run. CI runs all of them.

No new findings, so nothing ships: this note alone, on a review branch, with no version bump.

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
4. anything it cannot fix safely is added here as **open**, in the shape described under [Disclosure](#disclosure-nothing-unfixed-is-described-in-public), and the reproduction goes into a **draft security advisory**, never into an issue or pull request.

When the gate refuses a run (the 20 h window, a change outside its limits, a red check), the fix does **not** become a public pull request describing the flaw. It waits for the next window, or goes through a draft advisory and its private fork and is released from there. A run that opens a public branch or pull request must not say what the flaw lets an attacker do until the release carrying the fix is out.

The repository variable `SECURITY_AUTORELEASE` turns this down to `deps` (only dependency updates ship on their own) or `off`.
