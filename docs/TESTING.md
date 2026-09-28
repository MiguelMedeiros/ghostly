# Testing map

Every user-visible feature and every protocol capability of Ghostly is listed once in [`e2e/features.json`](../e2e/features.json), with a stable id, the WISP that describes it, the clients it exists in and the infrastructure it needs. Every test says which of those ids it covers. [`scripts/test-map.mjs`](../scripts/test-map.mjs) puts the two together: it runs no test, it reads the declarations, prints the matrix and fails when something is off. CI runs it on every pull request (Frontend lint and types job); it takes well under a second.

```bash
npm run test:map              # check, and print the summary
npm run test:map -- --matrix  # every feature's row
npm run test:map -- --warnings  # the test files that declare nothing
npm run test:map:write        # write the whole map to docs/test-map.md (not committed)
npm run coverage              # unit test line coverage per package (coverage/<package>/index.html)
npm run test:affected         # before pushing: only the tests your change can break (see below)
```

## What fails the check

- a feature with no test at all that is not on [`e2e/allow-untested.json`](../e2e/allow-untested.json): a list of today's real gaps, each with a one-line reason. It only shrinks: when a feature on it gets a test, the check fails until the line is taken off.
- a tag or a `covers` comment naming an id that is not in the inventory (a typo, or a feature nobody added);
- an allow-list entry that is not a feature, or has no reason;
- a malformed inventory entry: duplicate id, a WISP not in [`docs/wisps/numbering.json`](wisps/numbering.json), an unknown client or infrastructure.

A test file that declares nothing is a warning, not a failure (yet).

## Declaring what a test covers

**Playwright** (`e2e/**/*.spec.ts`): a tag on the test, or on a `describe` when every test in it covers the feature.

```ts
test("two people chat", { tag: ["@feature:chat.paired.pair", "@feature:chat.paired.send"] }, async ({ peer }) => { … });
test("LND pays a chat request", { tag: ["@feature:wallet.lightning.lnd.pay", "@gated"] }, async ({ peer }) => { … });
```

- `@gated`: the test runs only when its infrastructure is there (`GHOSTLY_*_REGTEST`, `GHOSTLY_S3_*`, …; `test.skip` otherwise). It counts in the Gated column, not in its client's. `@network` alone (the Cashu mint, which CI runs) is not gated.
- The folder decides the client: `e2e/web/` web, `e2e/extension/` extension, `e2e/desktop/` desktop. A spec elsewhere (a combination matrix, say) names its clients with `@client:web`, `@client:extension`, `@client:desktop` in the same tag array.
- Tags are plain string literals in `tag: [...]`: the check reads them without running Playwright. `npx playwright test --grep @feature:chat.paired.send` runs every test of one feature.

**vitest** (`*.test.ts`, `*.test.tsx`, anywhere but `e2e/`) and **Rust** (`#[cfg(test)]` modules): a comment line, usually just below the imports.

```ts
// covers: chat.paired.session, core.capabilities
// covers-gated: wallet.lightning.lnd.pay
```

`covers-gated:` is for tests that skip themselves unless an environment variable is set (`*.regtest.test.ts`, `TEST_NATIVE`, …).

Tag what the test would catch if it broke, not everything it happens to touch.

## Adding a feature

Add one line to `e2e/features.json`, in its alphabetical place by id (one feature per line; `npm run test:map -- --fix` sorts the file, and the check fails on a file out of order, so that pull requests adding features at the same time touch different lines; the ids are `area.thing[.detail]`, lowercase, dashes inside words), in the same pull request as the feature and its tests. `kind` is `feature` for something a person does or sees, `protocol` for a capability underneath (a record format, a handshake, a provider contract). `infra` names what it needs from outside the process, from the `infra` table at the top of the file; the entries with `fake` have a stand-in in `e2e/support/` already.

A new source file gets a line in the file's `paths` too (see below), or a glob that already matches it; otherwise `npm run test:affected` runs every e2e spec whenever it changes, and `npm run test:map -- --warnings` lists it.

## Testing only what changed

Before pushing, run what your change can break, not everything: CI runs the rest on the pull request (see [What CI runs](#what-ci-runs)).

```bash
npm run test:affected                     # vs origin/dev + your working tree: unit, lint, typecheck, Rust
npm run test:affected -- --port 50310     # also the e2e picked: builds web/, serves it on 50310, stops it after
npm run test:affected -- --list           # what would run, and why; runs nothing
npm run test:affected -- --no-e2e --no-rust
npm run test:affected -- --no-stack       # @gated tests: leave .env.e2e as it is, do not ask the shared stack
npm run test:affected -- --base HEAD~1    # another base;  --files a.ts b.tsx  instead of the diff
```

It prints each step with the reason it runs, runs whole, or is skipped, then a summary with timings, and exits non-zero when a step fails. [`scripts/test-affected.mjs`](../scripts/test-affected.mjs) runs it; what it picks is decided in [`scripts/affected/select.mjs`](../scripts/affected/select.mjs), which has its own tests (`npm run test:scripts`).

| Step | What runs |
|---|---|
| Unit | `vitest related <changed files> --run --maxWorkers=$JOBS` in each workspace whose tests can import them (core, browser, sdk, extension, ui, matrix, scripts); changed tests run themselves. A change in `packages/core/src` is followed through the `@ghostly/core` barrel to the files that import one of the changed module's names (type-only imports aside): through `index.ts`, every test is "related" to every core module. A test that imports a file outside its workspace by relative path (`packages/browser/test/chatConnection.test.ts` imports `src/components/ChatConnection.tsx`) runs when that file, or anything it imports that way, changes. |
| Lint | `eslint` on the changed files |
| Typecheck | `tsc --noEmit -p` of each touched package and of the packages importing it (a core change rechecks everything: its API breaks the importers, not core) |
| Rust | `cargo fmt --check`, `clippy -D warnings` and `test` for `src-tauri` (+ `native-transports`) or `cli`, only when they changed |
| E2E | changed file → features (`"paths"` in `e2e/features.json`) → the web and extension tests tagged with them (`--grep @feature:…`), plus changed specs and the specs importing a changed `e2e/support` helper, `--workers=$E2E_WORKERS`. Without `--port` (or `E2E_WEB_PORT`, or `E2E_WEB_URL` for a build you serve yourself) it says what it would run and runs none. Desktop specs run on Linux only: it prints the command instead. |

**Falling back.** When the diff cannot be narrowed, that area runs whole, and the plan says why: `package-lock.json`, a root `package.json` change other than `"scripts"`, or `patches/` run everything; a Vitest config or setup file runs its project whole; `eslint.config.mjs` the whole lint; a `tsconfig` every typecheck; `e2e/playwright.config.ts`, a file the `paths` map marks `"*"` (the app shell, `@ghostly/core`'s `index.ts`, the pairing path every spec walks through, `en.json`, whose strings the specs click) or a file no glob matches runs every e2e spec.

**The `paths` map.** At the end of `e2e/features.json`, sorted by glob like the features by id: a glob (`*`, `**/`, `{a,b}`) → the features a change there can break, as ids, `area.*` prefixes (the id `area` and everything under it), `"*"` for everything, or `[]` for nothing an e2e spec sees (docs, tests, tooling, Rust). A file matching several globs gets all their features. `npm run test:map` (in CI) fails on a pattern that names no feature and warns on a source file no glob matches.

**Gated tests and the shared stack.** When the e2e picked include `@gated` tests, the plan counts them: those whose spec reads one of the e2e stack's variables (`e2e/infra/env.mjs`) and those waiting on something the stack does not provide (Breez's hosted regtest, a measurement's `E2E_JOIN_RUNS`), which skip unless you set it. For the first kind it prefers the shared stack on the test server "one" ([e2e/README.md](../e2e/README.md#on-another-host-the-shared-stack-on-one)):

| | What `test:affected` does |
|---|---|
| a run with the e2e (`--port`, `E2E_WEB_URL`) | `node e2e/infra/infra.mjs status --host one` (opens this machine's connection to one and its port forwards); if it answers and `.env.e2e` does not point there, `npm run e2e:infra:use -- --host one` (forwards + `.env.e2e`) before Playwright |
| `--list` | `node e2e/infra/infra.mjs check --host one`: the same verdict through the connection this machine already has, read-only; with none running it says "not checked". It prints what a run would do, `use` command included, and writes nothing |
| one does not answer (or `use` fails) | says why and how many gated tests will skip. If `.env.e2e` points at one, its variables go to Playwright empty, so those tests skip instead of timing out on dead ports (and the Cashu tests use the public mint). A `.env.e2e` naming another stack (a local one) is used as it is |

It never starts, stops, resets or seeds a stack, here or on one, and never falls back to a local Docker stack: when one is down, `npm run e2e:infra:status -- --host one` tells you why, and bringing it up is a decision for whoever owns it. The decisions are pure functions in [`scripts/affected/stack.mjs`](../scripts/affected/stack.mjs), tested in `scripts/test/affected-stack.test.ts`.

**Workers.** Locally Vitest runs at most `JOBS` workers (default 2; [`vitest.shared.ts`](../vitest.shared.ts), shared by every Vitest config) and Playwright `E2E_WORKERS` (default 2; `MATRIX_WORKERS` for the matrix), so a plain `npm test` or `npx playwright test` no longer takes a worker per core. CI is unchanged (Vitest's default, 2 Playwright workers). `--maxWorkers` / `--workers` on the command line still win.

### When several sessions share a machine

- verify with `npm run test:affected` (2 workers), never the whole `npm test` / `npm run typecheck` / `test:e2e`: those are CI's job, on the draft pull request;
- serve e2e builds only on your session's port range (`--port`); `test:affected` stops the preview it started, and you stop every other server or container you started when you finish;
- a known flaky or load-sensitive test failing locally is not a reason to rerun the whole suite: rerun that file, and let CI judge.

## What CI runs

**CI** (`.github/workflows/ci.yml`) runs on every pull request into `dev` or `main` and on every push to them. A new push to a pull request cancels the run it replaces. It takes about 3.5 minutes.

| Job | What it runs | When |
|---|---|---|
| Changed paths | [`scripts/ci-changes.mjs`](../scripts/ci-changes.mjs): which path-gated jobs below this pull request needs | pull requests (pushes run everything) |
| Frontend lint and types | `npm run lint`, `npm run typecheck`, `npm run test:map` | always |
| Frontend tests (app) | `npm run test:app` (UI components, matrix, scripts) | always |
| Frontend tests (packages 1/4 to 4/4) | `npm run test:packages` (core, browser, sdk, extension and the headless CLI, whose tests build it and pair two bots) in 4 shards balanced by time ([`scripts/test-shards.mjs`](../scripts/test-shards.mjs), `scripts/test-durations.json`); the CLI's two-peer story has a shard of its own. The two jobs together are `npm test` | skipped only when every change is under `docs/`, or under `website/` outside the site files the packages' tests read |
| Frontend builds | `npm run build`, `check:desktop-bundle`, `build:extension`, `build:web`, `test:sdk-example` | always |
| Tauri Backend, CLI | `cargo fmt --check`, `clippy -D warnings`, `build`, `test` for `src-tauri` (+ `native-transports`) and `cli` | a draft skips them unless it changed `src-tauri/`, `cli/`, `native-transports/`, `Cargo.*` or `ci.yml`; leaving draft runs them |
| Website, Website browser checks (1/4 to 4/4) | the site's deck check, lint and types; its Playwright checks in 4 shards balanced by time (`website/e2e/shard.mjs`, `website/e2e/durations.json`) | only when something the site reads changed (`WEBSITE_INPUTS` in `ci-changes.mjs`) |
| Desktop media, Desktop on macOS | voice recordings in WKWebView; two Desktop apps on a Mac call and share an app (`desktop-macos.yml`) | skipped only when every change is under `website/` or `docs/` |
| CI Success | the required check: fails if any job failed, or was skipped without the gate saying so | always |

The gates are tested in `scripts/test/ci-changes.test.ts`. If the file lookup fails, CI Success fails: nothing is skipped by accident.

Other workflows:

| Workflow | What | When |
|---|---|---|
| Security (`security.yml`) | known advisories in the lock files (OSV, `scripts/security-scan.mjs`) | pull requests, pushes, every morning |
| E2E (`e2e.yml`) | web and extension e2e, the Desktop specs on Linux, compatibility with v0.4.0 | before every release (`release.yml` calls it) and by hand |
| E2E (full) (`e2e-full.yml`) | `npm run e2e:full` (gated suites included) and the combination matrix | nightly on `dev` and by hand |
| E2E (compatibility) (`e2e-compat.yml`) | the current web app against a real v0.4.0 | nightly, before every release, by hand |
| Desktop on macOS (`desktop-macos.yml`) | as in CI | also nightly, and by hand with `repeat` |

The app's e2e suites do not run on pull requests: they would hold up every merge. See [e2e/README.md](../e2e/README.md#when-they-run).

## Coverage

`npm run coverage` runs each package's unit tests with V8 coverage and writes the table below. There is no threshold in CI yet.

<!-- coverage:start (generated by `npm run coverage`; do not edit by hand) -->

Unit tests only, measured on 2026-09-24 with `npm run coverage` (gated suites skipped).

| Package | Lines | Statements | Functions | Branches |
|---|---:|---:|---:|---:|
| core (`packages/core`) | 99.27% | 97.74% | 96.76% | 96.61% |
| browser (`packages/browser`) (some tests failed) | 75.12% | 70.08% | 64.17% | 64.17% |
| sdk (`packages/sdk`) | n/a | n/a | n/a | n/a |
| ui (`.`) | 2.87% | 2.52% | 1.97% | 2.25% |

n/a: the package only re-exports code that lives (and is counted) elsewhere.

<!-- coverage:end -->

## The map

The map itself (every feature's row per kind of test, the gaps, the test files that declare nothing) is not committed: it changed with every feature, and pull requests open at the same time conflicted in it. Get it when you need it:

- `npm run test:map -- --matrix` prints every feature's row;
- `npm run test:map:write` writes it as Markdown to `docs/test-map.md` (ignored by git);
- every CI run shows it on the run's summary page (Frontend lint and types job).

## Combination matrix

Each feature is tested on its own elsewhere; this section is about the pieces together. `e2e/matrix/` describes the
dimensions (clients, transport, delivery, wallet, rail and source, identity proof, groups, profile, locale, viewport)
and their constraints as data, generates the fewest scenarios that put every pair of values together at least once
(and every client × transport × delivery combination), and runs each one as a whole story: pair, talk both ways,
send a file, share a proof, pay, go offline and back, restore. A scenario whose infrastructure is not up is skipped
with the reason, not failed.

```bash
npm run e2e:matrix                          # every scenario (reads .env.e2e from npm run e2e:infra:up)
npm run e2e:matrix -- --only <id>           # reproduce one
npm run e2e:matrix -- --list                # print the matrix
npm run e2e:matrix -- --docs                # and write the table below
```

What the first full run found (2026-09-24, dev at `8fd41d4`, a local mint and MinIO, the regtest stacks down):

- **Restoring a backup in the extension leads nowhere.** The extension has one profile only, and the restore adds a new profile it cannot switch to, so the restored chats are out of reach (on the web, Ghostly switches to the restored profile). This is all 20 failures: every scenario where B is the extension and restores. Fixed since: the extension keeps several profiles and switches to the restored one (#171, `e2e/extension/profiles.spec.ts`).
- **Leaving DHT-only after the contact reloaded was slow to go live again.** WebRTC came back after about 70 s in one repro, and not within 3 minutes once (`mx-656deae3`, which passed when run again). Fixed since. Each side learned the other's switch only at its next 30 s mailbox read, and the switch itself could wait for that read before it went out. An offer that arrived while one side was still blocked was dropped for good, so the dialler waited out its 90 s connect timeout. Measured with `E2E_DHT_BACK_RUNS=20 npx playwright test e2e/web/dht-back-timing.spec.ts`: 33 to 128 s before, seconds after (see [DHT delivery](DHT-DELIVERY.md)).
- A message sent while the contact's old session is still closing ended "Delivery unconfirmed" with a Retry button, and was not sent again by itself once the link was back. Fixed: it is `queued` and sent again by itself under the same id ([automatic resend](wisps/PAIRED-CHAT-INCREMENT.md#automatic-resend)). The `restore` block now writes at once, and `e2e/web/auto-resend.spec.ts` covers it.
- The harness had to learn a few things the app does on purpose:
  - NIP-07 is never offered in the extension.
  - A DHT chat carries one text at a time until its receipt arrives.
  - The invite card keeps the last delivery choice.
  - An extension peer only goes away through the Offline switch.
  - Nicknames travel with messages.
- Switching the language left `<html lang>` unchanged. Fixed since: `<html lang>` and `<html dir>` follow the language from the first paint.

Blocks not run in that run: every Testnet payment on LND, Core Lightning, NWC, Breez, Arkade, Bark, BDK and USDT, which needed their regtest stacks. The Desktop scenarios needed a pairing adapter for the Linux harness.

What the second full run found (2026-09-24, dev at `145aef7` with the payment blocks of `e2e/matrix/rails.ts`, `e2e/infra` up, 3 workers on a Mac; the table below). Every rail's payment step ran except Breez's, whose regtest `e2e/infra` cannot host (a funded `GHOSTLY_BREEZ_COUNTERPART` turns it on). Per rail, the scenarios whose payment step ran:

| rail | scenarios with Testnet payments | payments passed | where the others stopped |
|---|---|---|---|
| Lightning · LND | `mx-a5a6a591`, `mx-b0ef6dcb` | 2 (one after the harness fix) | |
| Lightning · Core Lightning | `mx-5157e729`, `mx-645445f7`, `mx-81f3e761` | 3 | |
| Lightning · NWC | `mx-1935a65f`, `mx-6f03ddb7` | 2 | |
| Lightning · Breez | 6 scenarios | skipped: Breez's hosted regtest, no counterpart wallet | |
| Ark · Arkade | `mx-3baa1439`, `mx-9acd4293`, `mx-be9c550d`, `mx-c9cc118b`, `mx-d6f3c59a` | 0 | expired coins that cannot be recovered (below) |
| Ark · Bark | `mx-341a13bf`, `mx-d905a954` | 2 (both then stop at the extension restore) | |
| Bitcoin · BDK | `mx-337ad5a9`, `mx-7e9761e0`, `mx-d182760c` | 3 (one then stops at the extension restore) | |
| USDT | `mx-3fdf6123`, `mx-7ce4862a`, `mx-afa22259`, `mx-e5939806` | 4 (one then stops at the extension restore) | |

New failures, each reproducible with `npm run e2e:matrix -- --only <id>` (or `--combo` with the values, since ids change with the table):

- **Arkade: coins past their expiry are shown as recoverable, but cannot be recovered or spent** (`mx-be9c550d`, `mx-c9cc118b`, `mx-d6f3c59a`, `mx-3baa1439`, `mx-9acd4293`; also `--combo client=web-web,transport=webrtc,delivery=live,wallet=testnet,rail=ark-arkade,identity=none,group=none,profile=fresh,locale=en,viewport=desktop`). About three minutes after A is funded (arkd's regtest expiry, `ARKD_VTXO_TREE_EXPIRY: 180`), the wallet says "… test sats expired before they were renewed … recover them", **Recover** answers "No recoverable VTXOs found", and paying says "Insufficient Ark balance". The SDK counts a coin recoverable once its expiry time has passed (`isExpired`), while `recoverVtxos` takes only coins the server has swept, and the sweep waits for the chain's time to pass the expiry, and on an idle regtest chain no block moves it. With blocks mined (the block mines while it recovers) the coins are recovered, but the balance does not come back within two minutes. On a real network the window is shorter, but it is the same gap: a balance the wallet shows, cannot spend and cannot recover.
- **USDT (and Ark): after a chat Send, the payer's composer shows a fresh review of the same payment**, status "pending", with **Approve payment** again, once the payee's request turns Paid (`--combo client=web-web,transport=webrtc,delivery=live,wallet=testnet,rail=usdt,identity=none,group=none,profile=fresh,locale=en,viewport=desktop` three runs out of three; `mx-3fdf6123` and `mx-7ce4862a` on a second pass after dev's new Select, though not in the full run: it depends on timing). Approving it again is refused ("This payment was already submitted or could not be saved"), so nothing is paid twice, but the person is asked to pay again. The block records it as a soft failure and goes on.
- **USDT: a second payment approved while the first is unconfirmed fails with "This payment was already submitted or could not be saved"** instead of saying to wait for the first one (one unconfirmed payment per EVM account, `persistence.ts` `pendingNonce`).
- **BDK: a chat Send cannot raise its fee cap.** It is a fixed 2,000 sats (`ONCHAIN_FEE_CAP`); a request's bubble has a "Maximum fee" field, the composer has none. On the shared regtest chain (about 10 sat/vB) a two-input Send is refused with "The fee (2294 sats) is above your limit of 2000" and the person has no way past it.
- **The extension restore gap from the first run is unchanged**: every scenario where B is the extension and restores still ends at "the restored profile is the one in use" (18 of the 27 failures). Their payment steps ran first and passed. Fixed since (#171).
- Intermittent, store-and-forward with a restored web profile: `mx-ece0bc5f` failed in a different place on each run, and `mx-d182760c` (which passed in the full run) failed on a second pass after its payments had passed: "welcome back" not received by the restored profile within 2 min, then A's hold indicator staying after B had picked the held items up.

The harness learned, in this run: the extension's offscreen engine is not covered by a context's `ignoreHTTPSErrors` (it gets Chromium's `--ignore-certificate-errors`); two workers must not pay over one pair of Lightning nodes at once, nor mine next to an Ark payment (`rails.ts` locks); a slow local mint must not fail whatever test is running when the app polls it.

The Desktop scenarios (2026-09-25, the Linux harness in an `ubuntu:22.04` container on the Mac, `--grep @clients:desktop`, one and then two workers). The client dimension gained `desktop-desktop`, so the table was generated again: the ids of the 82 browser scenarios in the table below are those of the run above, and are reproduced with `--combo` and their values. Desktop drives the chat only (pair, talk, go away and back, pick a transport); its files and wallet steps are skipped with that reason.

| id | clients | transport | result |
|---|---|---|---|
| `mx-19d7784b` | desktop-web | webrtc | ❌ never live: "alice is connected over WebRTC" (Linux Desktop has no WebRTC) |
| `mx-41eb51f3` | desktop-web | webrtc-strict | ❌ never live: "alice is connected over WebRTC" |
| `mx-4b821dc6` | desktop-web | native-fallback | ❌ never live: "alice is connected over WebRTC" |
| `mx-7ff28d43` | desktop-web | iroh-only | ✅ once (native refused cleanly, texts over the DHT); ❌ once: the web peer, back after closing its page, did not get Desktop's text within 4 min |
| `mx-7cb6de71` | desktop-web | hyperdht-only | ✅ partial (files and wallet skipped) |
| `mx-cd74c451` | desktop-desktop | webrtc | ❌ never live: "alice is connected over WebRTC" |
| `mx-85475df9` | desktop-desktop | webrtc-strict | ❌ never live: "alice is connected over WebRTC" |
| `mx-435b1b98` | desktop-desktop | native-fallback | ❌ never live: "alice is connected over Iroh" |
| `mx-61e467e5` | desktop-desktop | iroh-only | ❌ never live: "alice is connected over Iroh" |
| `mx-fd30bf3f` | desktop-desktop | hyperdht-only | ❌ never live: "alice is connected over HyperDHT" |

What they found:

- **On Linux, Desktop never had a live link, with anyone, so Iroh and HyperDHT were never used** (superseded: since the one-chat model, #209, #229 and #235, two Linux Desktops go live natively from the DHT; see the next run below). WebKitGTK (Ubuntu 22.04's `libwebkit2gtk-4.1`) has no `RTCPeerConnection` at all, and a first session needs WebRTC on both sides. `GhostLink.dial` says so: "No common available transport. Initial pairing requires WebRTC on both peers." The native transports' addresses are exchanged inside a session WebRTC authenticated first ("Peer native address unavailable; reconnect WebRTC once to exchange endpoints"). Two Linux Desktop apps pair, and they talk, go away and come back, but always over the DHT ("DHT · offline text"). Both offer Iroh and HyperDHT, show no transport error, and never dial either. A Linux Desktop and a browser meet the same way. On macOS (WKWebView) and Windows (WebView2) WebRTC exists, so this is Linux's own. Nothing here exercises Iroh or HyperDHT until a pair can start without WebRTC, or the harness drives Desktop on Windows.
- The harness learned: WebKitGTK draws an emoji as an image, which a text match does not see (Desktop texts have none); Desktop reads the clipboard natively, so its join types the invite in the field an empty clipboard opens; two apps need a home each, or they share one WebKit store.
- Intermittent (`mx-7ff28d43`): after the web peer closed its page and opened it again, the text the Desktop peer wrote meanwhile over the DHT did not arrive within 4 minutes. It arrived in the other run.

The Desktop scenarios again (2026-09-25, #244, the nightly job "Combination matrix (Desktop)" on `ubuntu-22.04`, run by hand with `jobs: desktop`). Since the one-chat model a first contact does not need WebRTC: the pair opens On DHT, each side publishes its native descriptors in its capability record, and the other dials them (`e2e/desktop/native-upgrade.spec.ts`, about 40 s to live). The matrix's `wanted()` (e2e/matrix/desktop.ts) now expects:

| transport | desktop-desktop | desktop-web |
|---|---|---|
| `webrtc` (Automatic, fallback on) | live on Iroh or HyperDHT | not live, texts over the DHT |
| `webrtc-strict` | live on Iroh: a Linux Desktop cannot choose WebRTC (its option is off, with the reason), and Fallback off keeps it to its first transport | not live, texts over the DHT |
| `native-fallback` | live on Iroh | not live, texts over the DHT |
| `iroh-only` | live on Iroh | not live, texts over the DHT |
| `hyperdht-only` | live on HyperDHT | not live, texts over the DHT |

Desktop↔web has no live transport in common: the matrix's browser has WebRTC only (its fixture keeps Iroh off, having no relay to give it, and HyperDHT needs a relay too), and WebKitGTK has none. The Connection options say so: an option is off for what either app lacks, so the Desktop offers its browser contact nothing.

Run [36150795904](https://github.com/MiguelMedeiros/ghostly/actions/runs/36150795904): **10 of 10 passed** in 8.6 min (2 workers), and so did the Desktop specs, `native-upgrade.spec.ts` included. Each desktop-desktop scenario took about 2 min, and each desktop-web one about 1 min. The runs before it found what is below. One was left as a finding: in the third run, `mx-fd30bf3f` (`hyperdht-only`) asked for HyperDHT while the pair was live on Iroh but before the contact's record had named HyperDHT. The switch failed ("no permitted transport connected"), and with Fallback off the chat stayed on "Connection issue" for 3 minutes without trying HyperDHT again. Fixed in #256 (WISP 100, "A chosen transport not reached yet"): the chat waits for it ("On DHT · waiting for HyperDHT"), tries again when the contact's record names it and on the background pace, and lands. The `hyperdht-only` block now asks for HyperDHT before the pair is live, the order that failed, and checks both sides reach it without ever reading "Connection issue"; the other values still act on a pair already live, as a person meets the menu. The same order is proven in-process (`packages/browser/test/transportPending.test.ts`, both key orders) and on the web with Iroh (`e2e/web/transport-wait.spec.ts`).

To run only these, dispatch "E2E (full)" with `jobs: desktop` (the Desktop scenarios and specs, then the matrix report):

```bash
gh workflow run e2e-full.yml --ref <branch> -f jobs=desktop
```

What it found:

- **Turning Fallback off failed on a Linux Desktop in Automatic** with "Transport unavailable". The popover's switch sends the chat's preference back, and Automatic reported WebRTC, which the app does not have. Automatic now reports the app's own first transport (`automaticTransport`: WebRTC where there is one, else Iroh, then HyperDHT), which is also what choosing Automatic asks the link for (before, whichever endpoint had started first).
- The harness learned: the Connection options are `role=radio` buttons (no longer inputs), and the Desktop person must wait for its choice to be drawn before flipping Fallback, which sends the preference the page shows.

<!-- matrix:begin (scripts/matrix-docs.mjs writes this section; edit the text above it) -->

Last full run: 2026-09-24.

**82 scenarios**: 50 passed (5 of them with blocks skipped), 27 failed, 5 skipped · 63 min · seed 20260924; 25 failed after the two reruns marked in the table, once the harness was fixed

| id | clients (A↔B) | transport | delivery | wallet network | rail · source | identity proof | group | B's profile | B's language | B's screen | result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `mx-00812e0d` | web-web | webrtc | dht | testnet | ln-breez | domain | link | restored | en | phone | ✅ partial; payments: needs Breez's hosted regtest, which e2e/infra cannot run offline, with a funded counterpart wallet (GHOSTLY_BREEZ_COUNTERPART; its |
| `mx-01bfacbf` | web-web | webrtc | store-forward | testnet | cashu | ssh | mesh | restored | pt | phone | ✅ |
| `mx-049fe697` | web-web | webrtc-strict | dht | testnet | ln-mint | domain | mesh | fresh | pt | phone | ✅ |
| `mx-04ceb838` | web-web | webrtc-strict | store-forward | mainnet | ln-lnd | nostr | mesh | restored | en | desktop | ✅ |
| `mx-0cbf88d2` | web-web | webrtc-strict | dht | mainnet | usdt | oidc | link | restored | en | desktop | ✅ |
| `mx-117f3606` | web-web | webrtc-strict | live | testnet | ln-breez | oidc | mesh | fresh | pt | desktop | ✅ partial; payments: needs Breez's hosted regtest, which e2e/infra cannot run offline, with a funded counterpart wallet (GHOSTLY_BREEZ_COUNTERPART; its |
| `mx-11cbc491` | web-extension | webrtc | dht | mainnet | ln-nwc | nostr | mesh | fresh | pt | desktop | ✅ |
| `mx-124526e9` | extension-web | webrtc-strict | dht | mainnet | ln-lnd | pgp | none | restored | pt | phone | ✅ |
| `mx-13ebe93c` | web-web | webrtc-strict | live | mainnet | btc-bdk | domain | none | fresh | en | phone | ✅ |
| `mx-184f599d` | web-extension | webrtc-strict | store-forward | mainnet | ln-cln | pgp | link | restored | pt | desktop | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-1935a65f` | extension-web | webrtc-strict | live | testnet | ln-nwc | pgp | none | fresh | en | desktop | ✅ |
| `mx-19d7784b` | desktop-web | webrtc | live | mainnet | cashu | none | none | fresh | en | desktop | ⏭️ needs a Desktop peer: the Linux harness drives one app and has no pairing adapter yet (Linux + tauri-driver only) |
| `mx-21e913b7` | extension-extension | webrtc-strict | live | mainnet | ln-lnd | none | mesh | restored | en | desktop | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-295308fa` | extension-extension | webrtc | dht | mainnet | ln-breez | bitcoin | none | restored | en | phone | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-301c9017` | extension-web | webrtc | dht | mainnet | ln-mint | ssh | mesh | restored | pt | desktop | ✅ |
| `mx-33159ca5` | extension-web | webrtc-strict | store-forward | mainnet | btc-bdk | none | mesh | fresh | en | phone | ✅ |
| `mx-337ad5a9` | web-extension | webrtc-strict | live | testnet | btc-bdk | ssh | link | restored | pt | desktop | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-341a13bf` | extension-extension | webrtc-strict | live | testnet | bark | none | mesh | restored | en | desktop | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-3500014e` | web-web | webrtc-strict | dht | mainnet | usdt | domain | none | restored | pt | desktop | ✅ |
| `mx-3baa1439` | extension-web | webrtc | live | testnet | ark-arkade | pgp | mesh | restored | pt | phone | ❌ alice's recovered coins are back: Error: alice's recovered coins are back |
| `mx-3d75786a` | extension-web | webrtc-strict | dht | testnet | cashu | bitcoin | link | restored | pt | phone | ✅ |
| `mx-3f04ec2c` | web-extension | webrtc-strict | store-forward | mainnet | ln-webln | bitcoin | mesh | restored | pt | desktop | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-3f9f2686` | extension-web | webrtc-strict | dht | mainnet | bark | pgp | none | restored | pt | phone | ✅ |
| `mx-3fdf6123` | web-extension | webrtc-strict | live | testnet | usdt | pgp | none | fresh | pt | desktop | ✅ |
| `mx-41eb51f3` | desktop-web | webrtc-strict | live | mainnet | cashu | none | none | fresh | en | desktop | ⏭️ needs a Desktop peer: the Linux harness drives one app and has no pairing adapter yet (Linux + tauri-driver only) |
| `mx-4b821dc6` | desktop-web | native-fallback | live | mainnet | cashu | none | none | fresh | en | desktop | ⏭️ needs a Desktop peer: the Linux harness drives one app and has no pairing adapter yet (Linux + tauri-driver only) |
| `mx-5157e729` | web-web | webrtc-strict | store-forward | testnet | ln-cln | domain | mesh | restored | pt | desktop | ✅ |
| `mx-51a33a14` | extension-web | webrtc-strict | dht | testnet | ln-breez | ssh | mesh | restored | pt | desktop | ✅ partial; payments: needs Breez's hosted regtest, which e2e/infra cannot run offline, with a funded counterpart wallet (GHOSTLY_BREEZ_COUNTERPART; its |
| `mx-55192bc3` | extension-web | webrtc-strict | live | mainnet | ln-webln | none | mesh | fresh | pt | desktop | ✅ |
| `mx-58b78852` | web-extension | webrtc | live | mainnet | ln-cln | nostr | mesh | restored | pt | phone | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-5e6df188` | web-web | webrtc-strict | dht | mainnet | cashu | oidc | none | restored | en | phone | ✅ |
| `mx-645445f7` | web-web | webrtc | dht | testnet | ln-cln | oidc | none | fresh | en | desktop | ✅ |
| `mx-656deae3` | web-web | webrtc-strict | dht | mainnet | bark | oidc | mesh | fresh | en | desktop | ✅ |
| `mx-68e19e49` | web-web | webrtc | live | testnet | ln-webln | domain | link | fresh | en | phone | ✅ |
| `mx-6af1a98b` | web-web | webrtc-strict | dht | mainnet | ln-mint | nostr | mesh | fresh | en | desktop | ✅ |
| `mx-6cd04c4c` | extension-extension | webrtc-strict | dht | mainnet | ln-nwc | bitcoin | mesh | restored | pt | phone | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-6d3c4d08` | extension-extension | webrtc-strict | dht | mainnet | ln-cln | bitcoin | none | restored | pt | desktop | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-6d4ae5d2` | extension-extension | webrtc | store-forward | mainnet | btc-bdk | bitcoin | link | fresh | pt | phone | ✅ |
| `mx-6f03ddb7` | web-extension | webrtc-strict | dht | testnet | ln-nwc | ssh | none | fresh | pt | desktop | ✅ |
| `mx-6f68cb51` | extension-extension | webrtc-strict | dht | mainnet | ln-webln | pgp | none | restored | en | desktop | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-79a3142e` | extension-extension | webrtc | live | testnet | cashu | pgp | none | fresh | pt | desktop | ✅ |
| `mx-7af621a3` | web-web | webrtc-strict | store-forward | mainnet | ln-nwc | domain | none | restored | en | desktop | ✅ |
| `mx-7b7ecf7e` | web-extension | webrtc-strict | store-forward | mainnet | ln-lnd | ssh | mesh | restored | pt | desktop | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-7cb6de71` | desktop-web | hyperdht-only | live | mainnet | cashu | none | none | fresh | en | desktop | ⏭️ needs a Desktop peer: the Linux harness drives one app and has no pairing adapter yet (Linux + tauri-driver only) |
| `mx-7ce4862a` | web-extension | webrtc | store-forward | testnet | usdt | nostr | link | fresh | en | phone | ✅ |
| `mx-7e6dfe22` | web-extension | webrtc-strict | store-forward | mainnet | ln-webln | nostr | none | restored | en | phone | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-7e9761e0` | web-web | webrtc | dht | testnet | btc-bdk | pgp | none | fresh | en | desktop | ✅ |
| `mx-7ff28d43` | desktop-web | iroh-only | live | mainnet | cashu | none | none | fresh | en | desktop | ⏭️ needs a Desktop peer: the Linux harness drives one app and has no pairing adapter yet (Linux + tauri-driver only) |
| `mx-80ae853f` | extension-extension | webrtc-strict | store-forward | mainnet | ark-arkade | ssh | none | fresh | en | phone | ✅ |
| `mx-8107c82d` | web-extension | webrtc-strict | dht | testnet | ln-mint | pgp | link | fresh | en | phone | ✅ |
| `mx-81f3e761` | extension-web | webrtc | dht | testnet | ln-cln | ssh | mesh | restored | pt | desktop | ✅ |
| `mx-85249bc1` | extension-extension | webrtc-strict | store-forward | mainnet | ln-nwc | none | link | fresh | en | desktop | ✅ |
| `mx-87b4fede` | web-extension | webrtc-strict | store-forward | testnet | ln-mint | none | none | restored | pt | desktop | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-87f6b54a` | extension-web | webrtc | store-forward | mainnet | bark | bitcoin | link | restored | pt | phone | ✅ |
| `mx-9acd4293` | web-extension | webrtc | dht | testnet | ark-arkade | nostr | mesh | restored | en | desktop | ❌ Expect "toHaveCount": Error: bob's expired coins are recovered |
| `mx-9d9c0dda` | extension-extension | webrtc | store-forward | mainnet | ln-mint | pgp | mesh | restored | pt | desktop | ❌ environment: Chromium did not launch within 3 min under load; the rerun failed on `gpgconf --launch gpg-agent` (the known gpg-agent flake on the Mac) |
| `mx-9da39cc9` | extension-extension | webrtc-strict | live | mainnet | ln-cln | none | none | fresh | en | phone | ✅ |
| `mx-a0dc2a7b` | web-web | webrtc | live | testnet | cashu | domain | none | restored | pt | phone | ✅ |
| `mx-a1e06ffb` | web-extension | webrtc | dht | mainnet | btc-bdk | nostr | mesh | fresh | pt | phone | ✅ |
| `mx-a5a6a591` | extension-extension | webrtc | live | testnet | ln-lnd | bitcoin | link | fresh | en | desktop | ✅ rerun. First run: LND refused from the extension (the harness trusted its self-signed certificate in pages only); passed once the extension was launched trusting it too |
| `mx-af79be02` | web-extension | webrtc | store-forward | testnet | ln-breez | none | link | fresh | pt | phone | ✅ partial; payments: needs Breez's hosted regtest, which e2e/infra cannot run offline, with a funded counterpart wallet (GHOSTLY_BREEZ_COUNTERPART; its |
| `mx-afa22259` | web-extension | webrtc | store-forward | testnet | usdt | ssh | none | restored | pt | phone | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-b0ef6dcb` | web-web | webrtc | dht | testnet | ln-lnd | oidc | none | fresh | pt | phone | ✅ |
| `mx-b6684fa6` | web-web | webrtc | live | testnet | ln-mint | bitcoin | none | fresh | pt | desktop | ✅ |
| `mx-b69daf69` | web-web | webrtc-strict | live | mainnet | ln-mint | oidc | mesh | restored | pt | phone | ✅ |
| `mx-b9a59a32` | web-extension | webrtc-strict | live | testnet | ln-breez | nostr | mesh | fresh | pt | desktop | ✅ partial; payments: needs Breez's hosted regtest, which e2e/infra cannot run offline, with a funded counterpart wallet (GHOSTLY_BREEZ_COUNTERPART; its |
| `mx-bc34cb3d` | web-web | webrtc-strict | live | mainnet | ark-arkade | bitcoin | none | restored | pt | phone | ✅ |
| `mx-be9c550d` | web-web | webrtc-strict | live | testnet | ark-arkade | domain | link | fresh | en | phone | ❌ bob's recovered coins are back: Error: bob's recovered coins are back |
| `mx-beb1331c` | web-web | webrtc | dht | mainnet | ln-lnd | domain | none | fresh | en | phone | ✅ |
| `mx-bf57a381` | extension-extension | webrtc-strict | live | mainnet | usdt | bitcoin | mesh | restored | pt | desktop | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-c20b65f4` | web-web | webrtc | dht | mainnet | ln-webln | oidc | none | restored | pt | phone | ✅ |
| `mx-c9cc118b` | web-web | webrtc | store-forward | testnet | ark-arkade | oidc | mesh | restored | pt | desktop | ❌ bob's recovered coins are back: Error: bob's recovered coins are back |
| `mx-d0daad6e` | extension-web | webrtc-strict | live | mainnet | ln-webln | ssh | link | restored | pt | desktop | ✅ |
| `mx-d182760c` | web-web | webrtc | store-forward | testnet | btc-bdk | oidc | none | restored | pt | phone | ✅ |
| `mx-d24c674a` | web-web | webrtc-strict | store-forward | mainnet | bark | domain | mesh | restored | pt | phone | ✅ rerun. First run: the hash navigation raced the reload after the restore switched profiles (harness); passed once it waits the reload out |
| `mx-d6f3c59a` | web-web | webrtc | dht | testnet | ark-arkade | none | link | restored | pt | desktop | ❌ bob's recovered coins are back: Error: bob's recovered coins are back |
| `mx-d905a954` | web-extension | webrtc | live | testnet | bark | nostr | none | restored | pt | phone | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-e22ae62d` | extension-extension | webrtc | dht | testnet | ln-breez | pgp | mesh | restored | en | desktop | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-e4f0c268` | web-extension | webrtc-strict | dht | testnet | cashu | nostr | none | restored | pt | phone | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-e5939806` | extension-web | webrtc-strict | live | testnet | usdt | none | mesh | restored | en | desktop | ✅ |
| `mx-ece0bc5f` | web-web | webrtc | store-forward | mainnet | ln-nwc | oidc | link | restored | pt | phone | ❌ intermittent. First run: the restored web profile did not receive "welcome back" within 2 min; rerun: A's hold indicator stayed after B picked the held items up |
| `mx-fab5c587` | web-extension | webrtc | store-forward | mainnet | bark | ssh | none | fresh | en | desktop | ✅ |

Reproduce one: `npm run e2e:matrix -- --only <id>`.

<!-- matrix:end -->
