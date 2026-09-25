# Testing map

Every user-visible feature and every protocol capability of Ghostly is listed once in [`e2e/features.json`](../e2e/features.json), with a stable id, the WISP that describes it, the clients it exists in and the infrastructure it needs. Every test says which of those ids it covers. [`scripts/test-map.mjs`](../scripts/test-map.mjs) puts the two together: it runs no test, it reads the declarations, prints the matrix and fails when something is off. CI runs it on every pull request (Frontend job); it takes well under a second.

```bash
npm run test:map              # check, and print the summary
npm run test:map -- --matrix  # every feature's row
npm run test:map -- --warnings  # the test files that declare nothing
npm run test:map:write        # rewrite the generated part of this page
npm run coverage              # unit test line coverage per package (coverage/<package>/index.html)
npm run test:affected         # before pushing: only the tests your change can break (see below)
```

## What fails the check

- a feature with no test at all that is not on [`e2e/allow-untested.json`](../e2e/allow-untested.json) — a list of today's real gaps, each with a one-line reason. It only shrinks: when a feature on it gets a test, the check fails until the line is taken off.
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

- `@gated` — the test runs only when its infrastructure is there (`GHOSTLY_*_REGTEST`, `GHOSTLY_S3_*`, …; `test.skip` otherwise). It counts in the Gated column, not in its client's. `@network` alone (the Cashu mint, which CI runs) is not gated.
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

Add one line to `e2e/features.json` (keep one feature per line; the ids are `area.thing[.detail]`, lowercase, dashes inside words), in the same pull request as the feature and its tests. `kind` is `feature` for something a person does or sees, `protocol` for a capability underneath (a record format, a handshake, a provider contract). `infra` names what it needs from outside the process, from the `infra` table at the top of the file; the entries with `fake` have a stand-in in `e2e/support/` already.

A new source file gets a line in the file's `paths` too (see below), or a glob that already matches it; otherwise `npm run test:affected` runs every e2e spec whenever it changes, and `npm run test:map -- --warnings` lists it.

## Testing only what changed

Before pushing, run what your change can break, not everything: **CI runs the whole suite on every push** (lint, typecheck, every unit test, the builds; the E2E workflow runs every spec).

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
| Unit | `vitest related <changed files> --run --maxWorkers=$JOBS` in each workspace whose tests can import them (core, browser, sdk, extension, ui, matrix, scripts); changed tests run themselves. A change in `packages/core/src` is followed through the `@ghostly/core` barrel to the files that import one of the changed module's names (type-only imports aside): through `index.ts`, every test is "related" to every core module. |
| Lint | `eslint` on the changed files |
| Typecheck | `tsc --noEmit -p` of each touched package and of the packages importing it (a core change rechecks everything: its API breaks the importers, not core) |
| Rust | `cargo fmt --check`, `clippy -D warnings` and `test` for `src-tauri` (+ `native-transports`) or `cli`, only when they changed |
| E2E | changed file → features (`"paths"` in `e2e/features.json`) → the web and extension tests tagged with them (`--grep @feature:…`), plus changed specs and the specs importing a changed `e2e/support` helper, `--workers=$E2E_WORKERS`. Without `--port` (or `E2E_WEB_PORT`, or `E2E_WEB_URL` for a build you serve yourself) it says what it would run and runs none. Desktop specs run on Linux only: it prints the command instead. |

**Falling back.** When the diff cannot be narrowed, that area runs whole, and the plan says why: `package-lock.json`, a root `package.json` change other than `"scripts"`, or `patches/` run everything; a Vitest config or setup file runs its project whole; `eslint.config.mjs` the whole lint; a `tsconfig` every typecheck; `e2e/playwright.config.ts`, a file the `paths` map marks `"*"` (the app shell, `@ghostly/core`'s `index.ts`, the pairing path every spec walks through, `en.json`, whose strings the specs click) or a file no glob matches runs every e2e spec.

**The `paths` map.** At the end of `e2e/features.json`: a glob (`*`, `**/`, `{a,b}`) → the features a change there can break, as ids, `area.*` prefixes (the id `area` and everything under it), `"*"` for everything, or `[]` for nothing an e2e spec sees (docs, tests, tooling, Rust). A file matching several globs gets all their features. `npm run test:map` (in CI) fails on a pattern that names no feature and warns on a source file no glob matches.

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

## Coverage

`npm run coverage` runs each package's unit tests with V8 coverage and writes the table below. There is no threshold in CI yet.

<!-- coverage:start (generated by `npm run coverage`; do not edit by hand) -->

Unit tests only, measured on 2026-09-24 with `npm run coverage` (gated suites skipped).

| Package | Lines | Statements | Functions | Branches |
|---|---:|---:|---:|---:|
| core (`packages/core`) | 99.27% | 97.74% | 96.76% | 96.61% |
| browser (`packages/browser`) — some tests failed | 75.12% | 70.08% | 64.17% | 64.17% |
| sdk (`packages/sdk`) | n/a | n/a | n/a | n/a |
| ui (`.`) | 2.87% | 2.52% | 1.97% | 2.25% |

n/a: the package only re-exports code that lives (and is counted) elsewhere.

<!-- coverage:end -->

## The map

<!-- test-map:start (generated by `npm run test:map:write`; do not edit by hand) -->

**322 features**, 316 covered by at least one test (98%), 6 on the [allow-untested list](../e2e/allow-untested.json).

| | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---:|---:|---:|---:|---:|---:|
| features with one | 260 | 19 | 213 | 54 | 2 | 95 |

E2E in any client: 220. Unit tests only: 62. Gated suites only: 2. User-visible features of a client with no E2E test in that client: web 40, extension 192, desktop 243.

Tests read: 102 E2E specs (102 tagged), 275 unit test files (275 tagged), 14 Rust files with `// covers:`.

### Gaps

| Feature | WISP | Clients | Needs | Why untested |
|---|---|---|---|---|
| `app.updates.desktop` |  | desktop | update-feed | The Tauri updater needs a signed release feed; the Desktop harness only has a boot smoke test |
| `settings.storage-used` |  | web, extension, desktop |  | Nothing asserts the storage figure in Settings; a component test (npm run test:ui) can |
| `storage.local` | 1001 | web, extension, desktop |  | The local file storage adapter (WISP 1001) is exercised only through backup.profile.file, never on its own |
| `core.dht-direct` | 01 | desktop, cli | mainline-dht | src-tauri/src/pkarr_client.rs is tested against an in-process relay (commands.rs); nothing reaches the Mainline DHT over UDP |
| `desktop.bundle-wiring` |  | desktop |  | Guarded by npm run check:desktop-bundle in PR CI, a build assertion the test map does not read |
| `desktop.notifications` |  | desktop |  | Native notifications need the Desktop harness (Linux only) and no spec drives them |

### Matrix

Numbers are test files. Gated: runs only with its infrastructure (`@gated`, `// covers-gated:`).


#### app

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `app.home` |  | WED | · | · | 5 | · | · | · |
| `app.navigation` |  | WED | 1 | · | 4 | · | · | · |
| `app.navigation.back` |  | WED | 1 | · | 1 | · | · | · |
| `app.offline-switch` |  | WED | 1 | · | 2 | 1 | · | 1 |
| `app.single-peer-per-browser` |  | W | 1 | · | 1 | · | · | · |
| `app.web-limits` |  | W | · | · | 2 | · | · | · |
| `app.project-links` |  | WED | · | 1 | 1 | · | · | · |
| `app.tech-info` | 01 | WED | · | · | 2 | · | · | · |
| `app.clear-data` | 04 | WED | 3 | · | 1 | · | · | · |
| `app.mobile-layout` |  | W | 1 | · | 7 | 1 | · | 1 |
| `app.responsive` |  | WED | 2 | · | 2 | 1 | · | 1 |
| `app.sidebar-resize` |  | WED | · | · | 3 | · | · | · |
| `app.popovers` |  | WED | · | · | 4 | · | · | · |
| `app.select` |  | WED | 1 | · | · | · | · | · |
| `app.menus` |  | WED | 1 | · | 1 | · | · | · |
| `app.emoji-picker` |  | WED | · | · | 1 | · | · | · |
| `app.i18n` |  | WED | 4 | · | 3 | 2 | 1 | 1 |
| `app.theme` |  | WED | · | · | 2 | · | · | · |
| `app.reduce-motion` |  | WED | · | · | 1 | · | · | · |
| `app.version` |  | WED | · | · | 1 | · | · | · |
| `app.error-boundary` |  | WED | 1 | · | · | · | · | · |
| `app.attention.notifications` |  | WED | · | · | 1 | · | · | · |
| `app.attention.sounds` |  | WED | 1 | · | 2 | · | · | · |
| `app.attention.unread` |  | WED | · | · | 1 | · | · | · |

#### chats

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `chats.created-marker` |  | WED | 1 | · | 1 | · | · | · |

#### app

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `app.updates.web` |  | W | 1 | · | 1 | · | · | · |
| `app.updates.extension` |  | E | 3 | · | · | 1 | · | · |
| `app.updates.desktop` |  | D | · | · | · | · | · | · |

#### settings

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `settings.nickname` | 04 | WED | 2 | · | 2 | · | · | · |
| `settings.lock.password` | 04 | WED | · | · | 2 | · | · | · |
| `settings.lock.idle` | 04 | WED | · | · | 1 | · | · | · |
| `settings.lock.now` | 04 | WED | · | · | 2 | · | · | · |
| `settings.lock.startup` | 04 | WED | · | · | 1 | · | · | · |
| `settings.network.relays` | 01 | WED | 1 | · | 2 | · | · | · |
| `settings.network.turn` | 101 | WED | 2 | · | 1 | · | · | · |
| `settings.storage-used` |  | WED | · | · | · | · | · | · |

#### profiles

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `profiles.create` | 04 | WED | 2 | · | 4 | 1 | · | · |
| `profiles.switch` | 04 | WED | 3 | · | 6 | 2 | · | 1 |
| `profiles.switcher` | 04 | WED | 1 | · | 2 | 1 | · | · |
| `profiles.delete` | 04 | WED | 1 | · | 3 | 1 | · | · |
| `profiles.lock` | 04 | WED | 1 | · | 2 | · | · | · |
| `profiles.name-optional` | 04 | WED | · | · | 2 | · | · | · |
| `profiles.picture` | 04 | WED | 1 | · | 2 | · | · | · |
| `profiles.share` | 401 | WED | 1 | · | 1 | · | · | · |
| `profiles.picture.sanitize` (protocol) | 04 | WEDC | 4 | · | 1 | · | · | · |
| `profiles.public` | 04 | WED | 3 | · | · | · | · | · |

#### backup

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `backup.profile.file` | 1001 | WED | 1 | · | 3 | 2 | · | 2 |
| `backup.profile.s3` | 1002 | WED | · | · | · | · | · | 1 |
| `backup.passphrase-rules` | 05 | WED | 3 | · | 1 | · | · | 1 |
| `backup.envelope` (protocol) | 05 | WED | 4 | · | 1 | · | · | · |
| `backup.database-snapshot` (protocol) | 05 | WED | 2 | · | · | · | · | · |

#### storage

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `storage.local` (protocol) | 1001 | WED | · | · | · | · | · | · |
| `storage.s3` (protocol) | 1002 | WED | 2 | · | · | · | · | · |
| `storage.indexeddb` (protocol) | 04 | WE | 2 | · | · | · | · | · |

#### core

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `core.records` (protocol) | 01 | WEDC | 5 | · | · | · | · | 1 |
| `core.relay-client` (protocol) | 01 | WEDC | 2 | · | · | · | · | 2 |
| `core.dht-direct` (protocol) | 01 | DC | · | · | · | · | · | · |
| `core.crypto` (protocol) | 01 | WEDC | 2 | · | · | · | · | · |
| `core.peer-keys` (protocol) | 02 | WEDC | 9 | · | 1 | · | · | 1 |
| `core.capabilities` (protocol) | 03 | WED | 5 | · | · | · | · | · |
| `core.version` (protocol) | 03 | WEDC | 4 | · | · | · | · | · |
| `core.frames` (protocol) | 400 | WED | 4 | · | · | · | · | · |
| `core.text-limits` (protocol) | 400 | WEDC | 4 | · | · | · | · | · |
| `core.liveness` (protocol) | 401 | WED | 2 | · | 1 | · | · | · |
| `core.ring-link` (protocol) | 302 | WED | 4 | · | · | · | · | 1 |
| `core.keet-identity` (protocol) | 303 | WED | 1 | · | · | · | · | · |
| `core.bitcoin-address` (protocol) | 200 | WEDC | 4 | · | · | · | · | · |

#### transport

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `transport.webrtc` (protocol) | 101 | WED | 6 | · | 4 | 1 | · | 1 |
| `transport.iroh` (protocol) | 102 | D | 2 | 2 | · | · | · | 2 |
| `transport.hyperdht` (protocol) | 103 | D | · | 1 | · | · | · | 1 |
| `transport.switch` (protocol) | 100 | WED | 5 | · | 1 | 1 | · | 2 |
| `transport.preference` | 100 | D | 7 | · | · | · | · | 1 |
| `transport.native-pool` (protocol) | 100 | D | 1 | 2 | · | · | · | · |

#### invite

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `invite.create` | 801 | WED | · | · | 3 | 1 | · | 1 |
| `invite.delivery-mode` | 801 | WED | 1 | · | 3 | 1 | · | 1 |
| `invite.copy` | 801 | WED | · | · | 2 | 1 | · | 1 |
| `invite.share` | 801 | WED | · | · | 1 | · | · | · |
| `invite.qr.show` | 801 | WED | · | · | 1 | · | · | · |
| `invite.qr.camera` | 801 | WED | · | · | 1 | · | · | · |
| `invite.qr.image` | 801 | WED | · | · | 2 | 1 | · | · |
| `invite.clipboard` | 801 | WED | 2 | 1 | 2 | 1 | · | 1 |
| `invite.link` | 801 | WD | 1 | · | 1 | · | · | · |
| `invite.invalid` | 801 | WED | 2 | · | 4 | · | · | · |
| `invite.formats` (protocol) | 801 | WEDC | 3 | · | · | · | · | · |
| `invite.dht` | 801 | WED | · | · | 3 | 2 | · | 1 |
| `invite.discovery-errors` | 801 | WED | 1 | · | 1 | · | · | · |

#### chats

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `chats.list.rename` | 400 | WED | 1 | · | 2 | · | · | · |
| `chats.list.unnamed-contact` | 400 | WED | 1 | · | 1 | · | · | · |
| `chats.list.search` | 400 | WED | · | · | 1 | · | · | · |
| `chats.list.delete` | 400 | WED | 2 | · | 2 | · | · | · |
| `chats.list.delete-all` | 400 | WED | · | · | 1 | · | · | · |
| `chats.list.pin` |  | WED | 1 | · | 2 | · | · | · |
| `chats.list.key-label` |  | WED | 1 | · | · | · | · | · |
| `chats.list.rows` |  | WED | 1 | · | 1 | · | · | · |

#### settings

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `settings.chat-list-density` |  | WED | 1 | · | 1 | · | · | · |

#### chat

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `chat.paired.pair` | 401 | WED | 1 | 1 | 5 | 1 | · | 1 |
| `chat.paired.send` | 401 | WED | 2 | · | 7 | 1 | · | 1 |
| `chat.paired.receipts` | 401 | WED | 4 | · | 2 | · | · | 1 |
| `chat.paired.verify` | 401 | WED | 5 | · | 2 | · | · | · |
| `chat.paired.status` | 401 | WED | 4 | · | 5 | · | · | · |
| `chat.paired.reconnect` | 401 | WED | 7 | · | 3 | · | · | 1 |
| `chat.paired.offline-send` | 401 | WED | 1 | · | 3 | 1 | · | 2 |
| `chat.paired.delete-message` | 400 | WED | 4 | · | 1 | · | · | · |
| `chat.paired.message-details` | 400 | WED | 1 | · | 1 | · | · | · |
| `chat.paired.links` | 400 | WED | 2 | · | 1 | · | · | · |
| `chat.paired.image-links` | 400 | WED | 1 | · | 1 | · | · | · |
| `chat.paired.emoji` |  | WED | · | · | 2 | · | · | · |
| `chat.paired.gifs` |  | WED | · | · | 1 | · | · | · |
| `chat.paired.nickname-sync` | 401 | WED | 4 | · | 3 | · | · | · |
| `chat.paired.join-notice` | 401 | WED | 3 | · | · | · | · | · |
| `chat.paired.draft` |  | WED | · | · | 2 | · | · | · |
| `chat.paired.session` (protocol) | 401 | WED | 6 | · | · | · | · | · |
| `chat.paired.storage` (protocol) | 401 | WED | 3 | · | 1 | · | · | · |
| `chat.legacy.send` | 402 | WEDC | 2 | · | 1 | · | · | · |
| `chat.legacy.limits` | 402 | WED | · | · | 1 | · | · | · |
| `chat.dht.send` | 403 | WED | 5 | · | 2 | 2 | · | 1 |
| `chat.dht.offline` | 403 | WED | 1 | · | 2 | 1 | · | 2 |
| `chat.dht.fallback` | 403 | WED | 1 | · | 1 | · | · | · |
| `chat.dht.errors` | 403 | WED | 2 | · | 1 | · | · | · |
| `chat.dht.key-change` | 403 | WED | 1 | · | 1 | · | · | · |
| `chat.dht.delivery` (protocol) | 403 | WEDC | 3 | 3 | · | · | · | 1 |

#### delivery

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `delivery.hold.enable` | 404 | WED | 3 | · | 1 | · | · | 2 |
| `delivery.hold.storage` | 404 | WED | · | · | · | · | · | 2 |
| `delivery.hold.text` | 404 | WED | 3 | · | · | · | · | 2 |
| `delivery.hold.picture` | 404 | WED | 2 | · | · | · | · | 2 |
| `delivery.hold.request` | 404 | WED | 3 | · | · | · | · | 1 |
| `delivery.hold.tamper` | 404 | WED | 4 | · | · | · | · | 1 |
| `delivery.hold.expiry` | 404 | WED | 3 | · | · | · | · | 1 |
| `delivery.hold.legacy-peer` | 404 | WED | 1 | · | 1 | · | · | · |
| `delivery.hold.protocol` (protocol) | 404 | WED | 5 | · | · | · | · | · |

#### files

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `files.paired.send` | 501 | WED | 3 | · | 4 | 2 | · | 2 |
| `files.paired.images` | 501 | WED | · | · | 2 | 1 | · | 1 |
| `files.legacy.send` | 502 | WED | 2 | · | 1 | 1 | · | · |
| `files.size-limit` | 500 | WED | 4 | · | 1 | · | · | · |
| `files.size-label` |  | WED | 1 | · | · | · | · | · |
| `files.persistence` (protocol) | 500 | WED | 2 | · | 1 | · | · | · |

#### calls

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `calls.video` | 601 | WED | 1 | · | 2 | 1 | · | · |
| `calls.audio` | 601 | WED | 1 | · | 2 | · | · | · |
| `calls.screen-share` | 601 | WED | 1 | · | 1 | · | · | · |
| `calls.upgrade` | 601 | WED | 1 | · | 1 | · | · | · |
| `calls.decline` | 601 | WED | 1 | · | 2 | · | · | · |
| `calls.cancel` | 601 | WED | 2 | · | 1 | · | · | · |
| `calls.ring-elsewhere` | 601 | WED | · | · | 1 | · | · | · |
| `calls.self-view` | 601 | WED | · | · | 1 | · | · | · |
| `calls.mini-window` | 601 | WED | · | · | 2 | · | · | · |
| `calls.route-keep` | 601 | WED | 1 | · | · | · | · | · |
| `calls.lock` | 601 | WED | · | · | 1 | · | · | · |
| `calls.signal` (protocol) | 600 | WED | 2 | · | · | · | · | · |

#### groups

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `groups.create` | 900 | WED | 5 | · | 3 | 1 | · | 1 |
| `groups.invite` | 900 | WED | 6 | · | 2 | 1 | · | 1 |
| `groups.send` | 902 | WED | 4 | · | 3 | 1 | · | 1 |
| `groups.catch-up` | 902 | WED | 2 | · | 1 | · | · | · |
| `groups.remove-member` | 900 | WED | 5 | · | 1 | · | · | · |
| `groups.admin-change` | 900 | WED | 3 | · | 2 | · | · | · |
| `groups.rotate` | 900 | WED | 4 | · | 1 | · | · | · |
| `groups.leave` | 900 | WED | 5 | · | 2 | · | · | · |
| `groups.forget` | 900 | WED | 3 | · | · | · | · | · |
| `groups.link.enable` | 900 | WED | 3 | · | 3 | 1 | · | 1 |
| `groups.link.join` | 900 | WED | 4 | · | 3 | 1 | · | 2 |
| `groups.link.replace` | 900 | WED | 3 | · | 1 | · | · | · |
| `groups.picture.protocol` (protocol) | 900 | WED | 2 | · | · | · | · | · |
| `groups.picture.set` | 900 | WED | 4 | · | 1 | · | · | · |
| `groups.picture.late-joiner` | 900 | WED | 2 | · | 1 | · | · | · |
| `groups.payments.member` | 900 | WED | 3 | · | 1 | · | · | · |
| `groups.payments.group-request` | 900 | WED | 3 | · | 1 | · | · | · |
| `groups.payments.notes` (protocol) | 900 | WED | 2 | · | 1 | · | · | · |
| `groups.connection` | 900 | WED | 2 | · | 1 | · | · | · |
| `groups.protocol.commits` (protocol) | 900 | WED | 3 | · | · | · | · | · |
| `groups.protocol.crypto` (protocol) | 900 | WED | 2 | · | · | · | · | · |
| `groups.protocol.entry` (protocol) | 900 | WED | 4 | · | · | · | · | · |
| `groups.protocol.link-frames` (protocol) | 900 | WED | 2 | · | · | · | · | · |
| `groups.link.share` | 900 | WED | 1 | · | 2 | · | · | · |
| `groups.community.create` | 903 | WED | · | · | 1 | · | · | · |
| `groups.community.join` | 903 | WED | 4 | · | 2 | · | · | · |
| `groups.community.send` | 903 | WED | 1 | · | 1 | · | · | · |
| `groups.community.catch-up` | 903 | WED | 1 | · | 1 | · | · | · |
| `groups.community.remove` | 903 | WED | 2 | · | 1 | · | · | · |
| `groups.community.leave` | 903 | WED | 2 | · | · | · | · | · |
| `groups.community.late-joiner` | 903 | WED | 1 | · | 1 | · | · | · |
| `groups.protocol.community-commits` (protocol) | 903 | WED | 1 | · | · | · | · | · |
| `groups.community.payments.member` | 903 | WED | 2 | · | 1 | · | · | · |
| `groups.community.payments.group-request` | 903 | WED | 2 | · | 1 | · | · | · |
| `groups.protocol.community-pair` (protocol) | 903 | WED | 3 | · | · | · | · | · |
| `groups.protocol.community-topology` (protocol) | 903 | WED | 4 | · | · | · | · | · |

#### services

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `services.add` | 701 | ED | 2 | · | · | 3 | · | · |
| `services.share` | 701 | ED | 4 | · | · | 3 | · | · |
| `services.open` | 701 | ED | 3 | · | · | 3 | · | · |
| `services.stop` | 701 | ED | 1 | · | · | 3 | · | · |
| `services.web-unavailable` | 700 | W | · | · | 2 | · | · | · |
| `services.http` (protocol) | 701 | WED | 5 | · | · | 2 | · | · |
| `services.desktop-viewer` | 701 | D | · | 2 | · | · | · | · |

#### payments

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `payments.chat.methods` | 200 | WED | 5 | · | 2 | · | · | · |
| `payments.chat.review` | 200 | WED | 5 | · | 6 | 1 | · | 4 |
| `payments.chat.refused` | 200 | WED | 2 | · | 1 | · | · | · |
| `payments.chat.method-off` | 200 | WED | 2 | · | 2 | · | · | 1 |
| `payments.chat.memo` | 200 | WED | · | · | 1 | · | · | · |
| `payments.chat.cards` | 200 | WED | 3 | · | 3 | 1 | · | 1 |
| `payments.chat.reconcile` (protocol) | 200 | WED | 12 | · | · | · | · | 4 |
| `payments.chat.frames` (protocol) | 200 | WED | 4 | · | · | · | · | · |
| `payments.targets` (protocol) | 200 | WEDC | 5 | · | · | · | · | · |
| `payments.cashu.send` | 201 | WED | 5 | · | 6 | 1 | · | 2 |
| `payments.cashu.request` | 201 | WED | 4 | · | 4 | 1 | · | 1 |
| `payments.cashu.reclaim` | 201 | WED | 3 | · | 1 | · | · | · |
| `payments.cashu.test-sats` | 201 | WED | 3 | · | 2 | · | · | · |
| `payments.cashu.token-card` | 201 | WED | 2 | · | 1 | · | · | · |
| `payments.lightning.request` | 203 | WED | 3 | · | 2 | · | · | 5 |
| `payments.lightning.invoice-card` | 203 | WED | 3 | · | 2 | · | · | · |
| `payments.arkade.send` | 202 | WED | 3 | · | · | · | · | 3 |
| `payments.arkade.request` | 202 | WED | 2 | · | · | · | · | 3 |
| `payments.bark.offer` | 204 | WED | 2 | · | 1 | · | · | · |
| `payments.bark.send` | 204 | WED | 5 | · | · | · | · | 2 |
| `payments.usdt.send` | 200 | WED | 6 | · | · | · | · | 3 |
| `payments.bitcoin.send` | 200 | WED | 5 | · | · | · | · | 2 |
| `payments.bitcoin.offer` | 200 | WED | 2 | · | 1 | · | · | · |
| `payments.external` | 205 | WED | 7 | · | 1 | · | · | · |
| `payments.lnurl.card` | 205 | WED | · | · | 1 | · | · | · |
| `payments.uri` (protocol) | 205 | WEDC | 2 | · | · | · | · | · |
| `payments.bolt11` (protocol) | 203 | WEDC | 2 | · | · | · | · | · |
| `payments.amounts` (protocol) | 200 | WEDC | 4 | · | · | · | · | · |

#### wallet

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `wallet.mode` | 200 | WED | 7 | · | 4 | 1 | · | 1 |
| `wallet.ready` | 200 | WED | 2 | · | 1 | · | · | · |
| `wallet.badge` | 200 | WED | · | · | 1 | · | · | · |
| `wallet.deck` |  | WED | 5 | · | 4 | 1 | · | 1 |
| `wallet.history` | 200 | WED | 1 | · | 3 | · | · | · |
| `wallet.cashu.mint.add` | 201 | WED | 1 | · | 3 | 1 | · | 1 |
| `wallet.cashu.mint.manage` | 201 | WED | 2 | · | 2 | 1 | · | · |
| `wallet.cashu.receive-lightning` | 201 | WED | 2 | · | 4 | · | · | 1 |
| `wallet.cashu.pay-invoice` | 201 | WED | 2 | · | 1 | · | · | · |
| `wallet.cashu.receive-token` | 201 | WED | 1 | · | · | · | · | · |
| `wallet.cashu.test-sats` | 201 | WED | 3 | · | 1 | · | · | · |
| `wallet.cashu.export` | 201 | WED | 1 | · | · | · | · | · |
| `wallet.lightning.sources` | 203 | WED | 7 | · | 2 | · | · | 1 |
| `wallet.lightning.card` | 203 | WED | · | · | 1 | · | · | · |
| `wallet.lightning.cashu-mint.receive` | 203 | WED | 2 | · | 2 | · | · | 1 |
| `wallet.lightning.cashu-mint.pay` | 203 | WED | 2 | · | 1 | · | · | 1 |
| `wallet.lightning.breez.connect` | 203 | WED | 2 | · | 1 | · | · | 3 |
| `wallet.lightning.breez.pay` | 203 | WED | 1 | · | · | · | · | 4 |
| `wallet.lightning.nwc.connect` | 203 | WED | 1 | · | 1 | · | · | 2 |
| `wallet.lightning.nwc.pay` | 203 | WED | 1 | · | 1 | · | · | 3 |
| `wallet.lightning.cln.connect` | 203 | WED | 2 | · | · | · | · | 3 |
| `wallet.lightning.cln.pay` | 203 | WED | 2 | · | · | · | · | 3 |
| `wallet.lightning.cln.commando` (protocol) | 203 | WED | 1 | · | · | · | · | 1 |
| `wallet.lightning.webln.connect` | 203 | WE | 2 | · | 2 | · | · | · |
| `wallet.lightning.webln.pay` | 203 | WE | 1 | · | 2 | · | · | 2 |
| `wallet.lightning.lnd.connect` | 203 | WED | 2 | 1 | · | · | · | 4 |
| `wallet.lightning.lnd.pay` | 203 | WED | 1 | 1 | · | · | · | 3 |
| `wallet.lightning.provider-contract` (protocol) | 203 | WED | 11 | · | · | · | · | 4 |
| `wallet.lnurl.address` | 205 | WED | 1 | · | 1 | · | · | · |
| `wallet.lnurl.protocol` (protocol) | 205 | WEDC | 3 | · | · | · | · | · |
| `wallet.onchain.sources` | 200 | WED | 7 | · | 2 | · | · | 2 |
| `wallet.onchain.bdk.create` | 200 | WED | 2 | · | 1 | · | · | · |
| `wallet.onchain.bdk.send` | 200 | WE | 1 | · | · | · | · | 3 |
| `wallet.onchain.bitcoind` | 200 | D | 2 | 1 | · | · | · | 1 |
| `wallet.onchain.provider-contract` (protocol) | 200 | WED | 5 | · | · | · | · | 2 |
| `wallet.ark.create` | 202 | WED | 2 | · | 1 | · | · | · |
| `wallet.ark.backup` | 202 | WED | 5 | · | 1 | · | · | 1 |
| `wallet.ark.boarding` | 202 | WED | 1 | · | 1 | · | · | · |
| `wallet.ark.send` | 202 | WED | 1 | · | · | · | · | 2 |
| `wallet.ark.recover` | 202 | WED | 1 | · | · | · | · | · |
| `wallet.bark.mainnet-off` | 204 | WED | 1 | · | 1 | · | · | · |
| `wallet.bark.create` | 204 | WED | 2 | · | 1 | · | · | · |
| `wallet.bark.send` | 204 | WED | 2 | · | · | · | · | 1 |
| `wallet.bark.backup` | 204 | WED | 2 | · | · | · | · | · |
| `wallet.usdt.create` | 200 | WED | 3 | · | 2 | · | · | 1 |
| `wallet.usdt.backup` | 200 | WED | 3 | · | 1 | · | · | 1 |
| `wallet.usdt.send` | 200 | WED | 1 | · | · | · | · | 2 |
| `wallet.usdt.faucet` | 200 | WED | 1 | · | · | · | · | · |

#### proofs

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `proofs.page` | 300 | WED | 1 | · | 4 | · | · | · |
| `proofs.deck` | 300 | WED | 3 | · | 2 | · | · | · |
| `proofs.picker` | 300 | WED | 3 | · | 2 | 1 | · | 1 |
| `proofs.composer` | 300 | WED | 1 | · | 2 | · | · | · |
| `proofs.badges` | 300 | WED | 2 | · | 1 | · | · | · |
| `proofs.share` | 300 | WED | 6 | · | 11 | 1 | · | 1 |
| `proofs.withdraw` | 300 | WED | 6 | · | 2 | · | · | · |
| `proofs.revoke` | 300 | WED | 5 | · | 1 | · | · | · |
| `proofs.expiry` | 300 | WED | 8 | · | 2 | · | · | · |
| `proofs.recheck` | 300 | WED | 2 | · | 2 | · | · | · |
| `proofs.unverifiable` | 300 | WED | 1 | · | 1 | · | · | · |
| `proofs.binding` (protocol) | 300 | WED | 4 | · | 2 | 1 | · | 1 |
| `proofs.contract` (protocol) | 300 | WED | 10 | · | · | · | · | · |
| `proofs.nostr` | 301 | WED | 3 | · | 4 | 1 | · | 1 |
| `proofs.domain.dns` | 304 | WED | 5 | · | 2 | · | · | 1 |
| `proofs.domain.https` | 304 | WED | 4 | · | 1 | · | · | · |
| `proofs.domain.resolver` | 304 | WED | 1 | · | 1 | · | · | · |
| `proofs.openpgp` | 305 | WED | 2 | · | 2 | 1 | · | 1 |
| `proofs.openpgp.keyserver` | 305 | WED | 2 | · | · | · | · | · |
| `proofs.bitcoin` | 306 | WED | 6 | · | 2 | 1 | · | 1 |
| `proofs.ssh` | 307 | WED | 4 | · | 2 | 1 | · | 1 |
| `proofs.ssh.github` | 307 | WED | 2 | · | 1 | · | · | · |
| `proofs.ssh.gitlab` | 307 | WED | 2 | · | · | · | · | · |
| `proofs.oidc` | 308 | WED | 5 | · | 2 | · | · | 1 |
| `proofs.oidc.nonce` | 308 | WED | 2 | · | 1 | · | · | · |
| `proofs.oidc.callback.web` | 308 | W | 2 | · | 1 | · | · | · |
| `proofs.oidc.callback.desktop` | 308 | WD | 1 | 1 | 1 | · | · | · |
| `proofs.oidc.callback.extension` | 308 | E | 1 | · | · | · | · | · |
| `proofs.pubky` | 302 | WED | 3 | · | · | · | · | · |
| `proofs.keet` | 303 | WED | 2 | · | · | · | · | · |
| `proofs.peer-proofs` (protocol) | 300 | WED | 7 | · | · | · | · | · |

#### nostr

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `nostr.social.profile` | 309 | WED | 4 | · | 2 | · | · | · |
| `nostr.social.follows` | 309 | WED | 2 | · | 1 | · | · | · |
| `nostr.social.notes` | 309 | WED | 3 | · | 1 | · | · | · |
| `nostr.social.no-proof` | 309 | WED | 2 | · | 1 | · | · | · |
| `nostr.social.publish` | 309 | WED | 4 | · | 1 | · | · | · |
| `nostr.signer` (protocol) | 309 | WED | 2 | · | · | · | · | · |

#### sdk

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `sdk.plugin.lightning` |  | WED | · | · | 1 | · | · | · |
| `sdk.plugin.identity` |  | WED | · | · | 1 | · | · | · |
| `sdk.registry` (protocol) |  | WED | 4 | · | · | · | · | · |
| `sdk.plugin.bundled` (protocol) |  | WED | 1 | · | · | · | · | · |
| `sdk.package` (protocol) |  | WED | 3 | · | · | · | · | · |

#### extension

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `extension.engine` |  | E | 7 | · | 1 | 1 | · | 2 |
| `extension.interop` | 401 | WE | · | · | 2 | 3 | · | · |

#### desktop

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `desktop.boot` |  | D | · | · | · | · | 1 | · |
| `desktop.bundle-wiring` |  | D | · | · | · | · | · | · |
| `desktop.notifications` |  | D | · | · | · | · | · | · |
| `desktop.payment-links` | 205 | D | · | 1 | · | · | · | · |
| `desktop.local-fetch` | 701 | D | · | 1 | · | · | · | · |
| `desktop.crypto` (protocol) | 01 | D | · | 1 | · | · | · | · |

#### cli

| Feature | WISP | Clients | Unit | Rust | E2E web | E2E ext | E2E desktop | Gated |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `cli.identity` | 01 | C | · | 2 | · | · | · | · |
| `cli.invite` | 801 | C | · | 2 | · | · | · | · |
| `cli.send` | 402 | C | · | 2 | · | · | · | · |
| `cli.recv` | 402 | C | · | 1 | · | · | · | · |
| `cli.interop` (protocol) | 402 | WC | 1 | · | · | · | · | 1 |

<!-- test-map:end -->

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

- **Restoring a backup in the extension leads nowhere.** The extension has one profile only, and the restore adds a new profile it cannot switch to, so the restored chats are out of reach (on the web, Ghostly switches to the restored profile). This is all 20 failures: every scenario where B is the extension and restores.
- **Leaving DHT-only after the contact reloaded was slow to go live again.** WebRTC came back after about 70 s in one repro, and not within 3 minutes once (`mx-656deae3`, which passed when run again). Fixed since. Each side learned the other's switch only at its next 30 s mailbox read, and the switch itself could wait for that read before it went out. An offer that arrived while one side was still blocked was dropped for good, so the dialler waited out its 90 s connect timeout. Measured with `E2E_DHT_BACK_RUNS=20 npx playwright test e2e/web/dht-back-timing.spec.ts`: 33–128 s before, seconds after (see [DHT delivery](DHT-DELIVERY.md)).
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
| Lightning · LND | `mx-a5a6a591`, `mx-b0ef6dcb` | 2 (one after the harness fix) | — |
| Lightning · Core Lightning | `mx-5157e729`, `mx-645445f7`, `mx-81f3e761` | 3 | — |
| Lightning · NWC | `mx-1935a65f`, `mx-6f03ddb7` | 2 | — |
| Lightning · Breez | 6 scenarios | skipped: Breez's hosted regtest, no counterpart wallet | — |
| Ark · Arkade | `mx-3baa1439`, `mx-9acd4293`, `mx-be9c550d`, `mx-c9cc118b`, `mx-d6f3c59a` | 0 | expired coins that cannot be recovered (below) |
| Ark · Bark | `mx-341a13bf`, `mx-d905a954` | 2 (both then stop at the extension restore) | — |
| Bitcoin · BDK | `mx-337ad5a9`, `mx-7e9761e0`, `mx-d182760c` | 3 (one then stops at the extension restore) | — |
| USDT | `mx-3fdf6123`, `mx-7ce4862a`, `mx-afa22259`, `mx-e5939806` | 4 (one then stops at the extension restore) | — |

New failures, each reproducible with `npm run e2e:matrix -- --only <id>` (or `--combo` with the values, since ids change with the table):

- **Arkade: coins past their expiry are shown as recoverable, but cannot be recovered or spent** (`mx-be9c550d`, `mx-c9cc118b`, `mx-d6f3c59a`, `mx-3baa1439`, `mx-9acd4293`; also `--combo client=web-web,transport=webrtc,delivery=live,wallet=testnet,rail=ark-arkade,identity=none,group=none,profile=fresh,locale=en,viewport=desktop`). About three minutes after A is funded (arkd's regtest expiry, `ARKD_VTXO_TREE_EXPIRY: 180`), the wallet says "… test sats expired before they were renewed … recover them", **Recover** answers "No recoverable VTXOs found", and paying says "Insufficient Ark balance". The SDK counts a coin recoverable once its expiry time has passed (`isExpired`), while `recoverVtxos` takes only coins the server has swept, and the sweep waits for the chain's time to pass the expiry — on an idle regtest chain no block moves it. With blocks mined (the block mines while it recovers) the coins are recovered, but the balance does not come back within two minutes. On a real network the window is shorter, but it is the same gap: a balance the wallet shows, cannot spend and cannot recover.
- **USDT (and Ark): after a chat Send, the payer's composer shows a fresh review of the same payment**, status "pending", with **Approve payment** again, once the payee's request turns Paid (`--combo client=web-web,transport=webrtc,delivery=live,wallet=testnet,rail=usdt,identity=none,group=none,profile=fresh,locale=en,viewport=desktop` three runs out of three; `mx-3fdf6123` and `mx-7ce4862a` on a second pass after dev's new Select, though not in the full run: it depends on timing). Approving it again is refused ("This payment was already submitted or could not be saved"), so nothing is paid twice, but the person is asked to pay again. The block records it as a soft failure and goes on.
- **USDT: a second payment approved while the first is unconfirmed fails with "This payment was already submitted or could not be saved"** instead of saying to wait for the first one (one unconfirmed payment per EVM account, `persistence.ts` `pendingNonce`).
- **BDK: a chat Send cannot raise its fee cap.** It is a fixed 2,000 sats (`ONCHAIN_FEE_CAP`); a request's bubble has a "Maximum fee" field, the composer has none. On the shared regtest chain (about 10 sat/vB) a two-input Send is refused with "The fee (2294 sats) is above your limit of 2000" and the person has no way past it.
- **The extension restore gap from the first run is unchanged**: every scenario where B is the extension and restores still ends at "the restored profile is the one in use" (18 of the 27 failures). Their payment steps ran first and passed.
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

**82 scenarios**: 50 passed (5 of them with blocks skipped), 27 failed, 5 skipped · 63 min · seed 20260924 — 25 failed after the two reruns marked in the table, once the harness was fixed

| id | clients (A↔B) | transport | delivery | wallet mode | rail · source | identity proof | group | B's profile | B's language | B's screen | result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `mx-00812e0d` | web-web | webrtc | dht | testnet | ln-breez | domain | link | restored | en | phone | ✅ partial — payments: needs Breez's hosted regtest, which e2e/infra cannot run offline, with a funded counterpart wallet (GHOSTLY_BREEZ_COUNTERPART; its |
| `mx-01bfacbf` | web-web | webrtc | store-forward | testnet | cashu | ssh | mesh | restored | pt | phone | ✅ |
| `mx-049fe697` | web-web | webrtc-strict | dht | testnet | ln-mint | domain | mesh | fresh | pt | phone | ✅ |
| `mx-04ceb838` | web-web | webrtc-strict | store-forward | mainnet | ln-lnd | nostr | mesh | restored | en | desktop | ✅ |
| `mx-0cbf88d2` | web-web | webrtc-strict | dht | mainnet | usdt | oidc | link | restored | en | desktop | ✅ |
| `mx-117f3606` | web-web | webrtc-strict | live | testnet | ln-breez | oidc | mesh | fresh | pt | desktop | ✅ partial — payments: needs Breez's hosted regtest, which e2e/infra cannot run offline, with a funded counterpart wallet (GHOSTLY_BREEZ_COUNTERPART; its |
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
| `mx-51a33a14` | extension-web | webrtc-strict | dht | testnet | ln-breez | ssh | mesh | restored | pt | desktop | ✅ partial — payments: needs Breez's hosted regtest, which e2e/infra cannot run offline, with a funded counterpart wallet (GHOSTLY_BREEZ_COUNTERPART; its |
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
| `mx-9d9c0dda` | extension-extension | webrtc | store-forward | mainnet | ln-mint | pgp | mesh | restored | pt | desktop | ❌ environment — Chromium did not launch within 3 min under load; the rerun failed on `gpgconf --launch gpg-agent` (the known gpg-agent flake on the Mac) |
| `mx-9da39cc9` | extension-extension | webrtc-strict | live | mainnet | ln-cln | none | none | fresh | en | phone | ✅ |
| `mx-a0dc2a7b` | web-web | webrtc | live | testnet | cashu | domain | none | restored | pt | phone | ✅ |
| `mx-a1e06ffb` | web-extension | webrtc | dht | mainnet | btc-bdk | nostr | mesh | fresh | pt | phone | ✅ |
| `mx-a5a6a591` | extension-extension | webrtc | live | testnet | ln-lnd | bitcoin | link | fresh | en | desktop | ✅ rerun — first run: LND refused from the extension (the harness trusted its self-signed certificate in pages only); passed once the extension was launched trusting it too |
| `mx-af79be02` | web-extension | webrtc | store-forward | testnet | ln-breez | none | link | fresh | pt | phone | ✅ partial — payments: needs Breez's hosted regtest, which e2e/infra cannot run offline, with a funded counterpart wallet (GHOSTLY_BREEZ_COUNTERPART; its |
| `mx-afa22259` | web-extension | webrtc | store-forward | testnet | usdt | ssh | none | restored | pt | phone | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-b0ef6dcb` | web-web | webrtc | dht | testnet | ln-lnd | oidc | none | fresh | pt | phone | ✅ |
| `mx-b6684fa6` | web-web | webrtc | live | testnet | ln-mint | bitcoin | none | fresh | pt | desktop | ✅ |
| `mx-b69daf69` | web-web | webrtc-strict | live | mainnet | ln-mint | oidc | mesh | restored | pt | phone | ✅ |
| `mx-b9a59a32` | web-extension | webrtc-strict | live | testnet | ln-breez | nostr | mesh | fresh | pt | desktop | ✅ partial — payments: needs Breez's hosted regtest, which e2e/infra cannot run offline, with a funded counterpart wallet (GHOSTLY_BREEZ_COUNTERPART; its |
| `mx-bc34cb3d` | web-web | webrtc-strict | live | mainnet | ark-arkade | bitcoin | none | restored | pt | phone | ✅ |
| `mx-be9c550d` | web-web | webrtc-strict | live | testnet | ark-arkade | domain | link | fresh | en | phone | ❌ bob's recovered coins are back: Error: bob's recovered coins are back |
| `mx-beb1331c` | web-web | webrtc | dht | mainnet | ln-lnd | domain | none | fresh | en | phone | ✅ |
| `mx-bf57a381` | extension-extension | webrtc-strict | live | mainnet | usdt | bitcoin | mesh | restored | pt | desktop | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-c20b65f4` | web-web | webrtc | dht | mainnet | ln-webln | oidc | none | restored | pt | phone | ✅ |
| `mx-c9cc118b` | web-web | webrtc | store-forward | testnet | ark-arkade | oidc | mesh | restored | pt | desktop | ❌ bob's recovered coins are back: Error: bob's recovered coins are back |
| `mx-d0daad6e` | extension-web | webrtc-strict | live | mainnet | ln-webln | ssh | link | restored | pt | desktop | ✅ |
| `mx-d182760c` | web-web | webrtc | store-forward | testnet | btc-bdk | oidc | none | restored | pt | phone | ✅ |
| `mx-d24c674a` | web-web | webrtc-strict | store-forward | mainnet | bark | domain | mesh | restored | pt | phone | ✅ rerun — first run: the hash navigation raced the reload after the restore switched profiles (harness); passed once it waits the reload out |
| `mx-d6f3c59a` | web-web | webrtc | dht | testnet | ark-arkade | none | link | restored | pt | desktop | ❌ bob's recovered coins are back: Error: bob's recovered coins are back |
| `mx-d905a954` | web-extension | webrtc | live | testnet | bark | nostr | none | restored | pt | phone | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-e22ae62d` | extension-extension | webrtc | dht | testnet | ln-breez | pgp | mesh | restored | en | desktop | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-e4f0c268` | web-extension | webrtc-strict | dht | testnet | cashu | nostr | none | restored | pt | phone | ❌ the restored profile is the one in use: Error: the restored profile is the one in use |
| `mx-e5939806` | extension-web | webrtc-strict | live | testnet | usdt | none | mesh | restored | en | desktop | ✅ |
| `mx-ece0bc5f` | web-web | webrtc | store-forward | mainnet | ln-nwc | oidc | link | restored | pt | phone | ❌ intermittent — first run: the restored web profile did not receive "welcome back" within 2 min; rerun: A's hold indicator stayed after B picked the held items up |
| `mx-fab5c587` | web-extension | webrtc | store-forward | mainnet | bark | ssh | none | fresh | en | desktop | ✅ |

Reproduce one: `npm run e2e:matrix -- --only <id>`.

<!-- matrix:end -->
