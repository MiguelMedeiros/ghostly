# End-to-end tests

Real Chromium against the shipped build: the web app (`web/dist`, served by `vite preview`) and the extension (`extension/dist`). Two or three people per test, each in a browser profile of their own, chatting, sending files, calling and paying each other. Desktop is [its own thing](#desktop): the bundled Tauri app, driven through WebDriver.

```bash
npm run test:e2e            # everything (builds the web app and the extension first)
npm run test:e2e:offline    # everything but the tests that need the internet
npm run test:e2e:ui         # pick, watch and debug tests
npm run test:e2e:report     # the report of the last run: traces, videos, screenshots of failures
HEADED=1 npm run test:e2e -- --project=extension   # watch the extension windows
E2E_WEB_URL=https://app.ghostly.tools npx playwright test -c e2e/playwright.config.ts --project=web   # a deployed app

npm run tauri -- build --debug --no-bundle && npm run test:e2e:desktop   # the Desktop app (Linux, Windows)
```

## Everything, gated suites included

```bash
npm run e2e:full                              # up → wait → fund → vitest contracts → web + extension e2e → down
npm run e2e:full -- --keep                    # leave the environment running afterwards
npm run e2e:full -- --no-vitest -- --project=web e2e/web/wallet-lnd.spec.ts   # Playwright arguments after the second --
```

Most suites need nothing but the test process (see [No servers](#no-servers)). The ones that pay over a real
network — Ark, Bark, BDK, Bitcoin Core, Core Lightning, LND, NWC, WebLN, USDT, S3, the Cashu mint — need services,
and `e2e/infra/` is all of them in one Docker Compose project: one regtest bitcoind (with a miner wallet) and its
Esplora, arkd, captaind, two LND nodes for the LND suite, two behind the WebLN wallets, two under Alby Hubs with a
strfry relay for NWC, two Core Lightning nodes, Anvil with the test USDT contract, an S3 server (RustFS) and the Cashu test mint.
Worthless coins and throwaway keys only. Containers are `ghostly-e2e-*`, host ports `127.0.0.1:47000-47199`.

`e2e:full` starts from nothing and leaves nothing behind: it removes its own project first, brings it up, waits
until every container is healthy and every endpoint answers, funds and opens channels (each suite's `ready`, in
parallel, idempotent), writes `.env.e2e`, runs the gated provider contracts of `@ghostly/browser` (vitest), builds
the extension, runs the whole Playwright suite with every gate on, and removes the project again — on failure and
on Ctrl-C too. Safe to run twice in a row. It exits non-zero if either the contracts or the browsers failed, and
prints how long each phase took.

To work on one suite, keep the environment up and run what you want against it:

```bash
npm run e2e:infra:up        # start, wait, fund; writes .env.e2e (again: only tops up what is missing)
npm run e2e:infra:status    # containers, and whether each endpoint answers
npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-cln.spec.ts
npm run e2e:infra:reset     # a fresh chain
npm run e2e:infra:down      # remove everything, volumes and .env.e2e included
```

`e2e/playwright.config.ts` loads `.env.e2e` when it exists (a variable set in the shell wins), so with the
environment up every gated suite runs and without it they are skipped. The variables — gates, endpoints, keys —
are listed with what they mean in [`e2e/infra/env.mjs`](infra/env.mjs); specs and support scripts read every
endpoint from there, never a literal port. Their names are stable: other suites build on them.

| Port | Service | Variable |
|---|---|---|
| 47001 / 47002 | bitcoind RPC (`ghostly` / `regtest`) / Esplora (electrs) | `GHOSTLY_BITCOIND_RPC_URL` / `GHOSTLY_ESPLORA_URL` |
| 47010 (+47011 admin) | arkd | `GHOSTLY_ARK_SERVER_URL` |
| 47020 | captaind (Bark) | `GHOSTLY_BARK_SERVER_URL` |
| 47030 / 47031 | LND REST, Alice / Bob (LND suite) | `GHOSTLY_LND_ALICE_URL` / `_BOB_URL` |
| 47040 / 47041 | LND REST behind the WebLN wallets | `GHOSTLY_WEBLN_ALICE_URL` / `_BOB_URL` |
| 47050 / 47051 | Core Lightning Commando websockets | `GHOSTLY_CLN_ALICE_WS` / `_BOB_WS` |
| 47060 | strfry, the NWC relay | `GHOSTLY_NWC_RELAY_URL` |
| 47061-47064 | LND REST and Alby Hubs under NWC | `GHOSTLY_NWC_{ALICE,BOB}_{LND,HUB}_URL` |
| 47070 | Anvil (chain 31337) | `GHOSTLY_USDT_RPC_URL`, `GHOSTLY_USDT_TOKEN` |
| 47080 | S3 (RustFS; MinIO no longer publishes pullable images) | `GHOSTLY_S3_ENDPOINT`, `_KEY`, `_SECRET` |
| 47090 | Cashu test mint (`cashubtc/mintd`, fake Lightning) | `E2E_MINT_URL` |
| 47100 | the web build under test (`vite preview`) | `E2E_WEB_PORT` |
| 47110-47119 | Lightning address server, in the test process | `E2E_LNURL_PORT` |
| 47120-47199 | domain-proof DoH + well-known servers, in the test process | `E2E_DOMAIN_PORT` |

Every Bitcoin service shares the one chain, so Lightning nodes of different implementations can reach each other,
but each suite has its own pair of nodes: the LND, WebLN and NWC tests assert exact channel balances while other
files run in parallel. The Ark, Bark and USDT endpoints are also the web app's own Regtest options
(`ArkWalletPanel`, `BarkWalletPanel`, `UsdtWalletPanel`), so those ports are fixed. The OIDC issuer and the Nostr
relay of the social suite need no port: the test process answers their requests (`support/oidcIssuer.ts`,
`support/nostrRelay.ts`). Breez's regtest is hosted by Breez and Lightspark, not by `e2e/infra`, and its faucet now
asks for a reCAPTCHA: `e2e:full` runs the Breez suites only with a funded counterpart wallet in
`GHOSTLY_BREEZ_COUNTERPART` (or when the shell sets `GHOSTLY_BREEZ_TESTNET=1`), and skips them otherwise.

Nightly on `dev`, and by hand, the `E2E (full)` workflow (`.github/workflows/e2e-full.yml`) runs `npm run e2e:full`
on a GitHub runner and keeps the Playwright report. It needs no secrets. See [When they run](#when-they-run) for
how long it takes.

## No servers

Peers find each other through Pkarr relays. Here the relay is `support/relay.ts`, inside the test process: requests to the public relays are answered from memory, and the extension, whose peer runs where requests cannot be intercepted, is pointed at its local address in Settings → Network. So tests do not wait on the public relays, are never rate limited, and never see each other's packets. WebRTC connects the browsers directly on this machine. GIFCities is stubbed the same way.

Only the tests tagged `@network` go out: the wallet, against the public Cashu test mint (`testnut.cashu.space`, worthless sats whose invoices pay themselves). CI does not even do that — it runs a mint of its own and answers the public one's requests from it, the way the relay answers Pkarr's. `e2e/infra` has that mint (`ghostly-e2e-mint`, `E2E_MINT_URL=http://127.0.0.1:47090`), and the `E2E` workflow starts the same container by itself:

```bash
npm run e2e:infra:up && npm run test:e2e      # .env.e2e sets E2E_MINT_URL
```

`E2E_MINT_URL` is all it takes: the app is never told, so it goes on adding and spending `testnut.cashu.space` and the tests assert exactly what they asserted before — they just stop depending on one volunteer's server, which GitHub's runners cannot reach and which was blocking every release. Use the same mint software (`cashubtc/mintd`, which is what the public test mint runs); Nutshell refuses to quote an invoice whose mint quote was already issued, and the tests need that to work. Without `E2E_MINT_URL` the public mint answers for itself, as before.

## What runs where

| | |
|---|---|
| `web/app.spec.ts` | home, one tab per peer, create/join/name/search/delete chats, "Delete all chats" stays deleted, clear all data, tech info |
| `web/settings.spec.ts` | nickname, color theme and mode, language, switches, lock screen (password, lock now, idle timeout), relays |
| `web/chat.spec.ts` | two people: relay then peer to peer, nicknames, read ticks, long messages, offline delivery, emoji, GIFs, files (3 MiB, checksum), images |
| `web/calls.spec.ts` | video and audio calls, mute, camera, screen share, decline, the movable self view, the small call window, a call that outlives its chat, the lock over one |
| `web/mobile.spec.ts` | the phone layout: tabs, chat screen, composer |
| `web/wallet.spec.ts` | `@network`: Lightning in, ecash out, requests, history and fees, invoice and token cards — against a real mint, ours in CI |
| `web/chat-extras.spec.ts` | unread count, naming a chat, links (new tab, no opener/referrer), hostile text never becomes a link, contact pictures only on click and only https, per-message details, overlong text refused (and not kept), file size limit, Tech Info copy |
| `web/invite-link.spec.ts` | an invite link opens its chat (fresh tab or running app) and leaves no key in the address or history; broken, damaged or conflicting links say so and never crash |
| `web/network-settings.spec.ts` | TURN server saved, kept, cleared; relays sanitized; a relay list with none, or a TURN address WebRTC refuses, is refused with the reason |
| `web/call-edges.spec.ts` | hanging up while it rings, a call that rings while you are elsewhere in the app, declining, a call nobody answers (camera and microphone released) |
| `web/pairing-extras.spec.ts` | the connection popover (click, Escape, outside), the verification code on both sides, offline and Reconnect |
| `web/services-web.spec.ts` | a web page says sharing needs the extension or desktop, in the Services page and in a chat's Services… dialog |
| `web/profiles.spec.ts` · `profile-lock.spec.ts` | profiles keep chats and settings apart, switching, deleting; the lock screen (change, remove, at startup) goes with new profiles and guards deleting a locked one |
| `web/profile-backup-file.spec.ts` · `profile-backup.spec.ts` | a whole profile backed up to a file (and to S3 with `GHOSTLY_S3_*`), restored as a new profile; passphrase rules |
| `web/chat-payments.spec.ts` | each chat allows its own ways of paying, both sides' choices shown |
| `web/sdk-plugin.spec.ts` | adapters built outside the app against `@ghostly/sdk` (`examples/sdk-adapter`), compiled into this build with `GHOSTLY_PLUGINS`: the plugin's Lightning source in the picker (Testnet only), connected, an invoice seen paid; its identity proof added from a pasted signature |
| `web/store-forward.spec.ts` | held messages (WISP 4xx): with `GHOSTLY_S3_*`, text, a picture and a request held in Alice's S3 while Bob's page is closed, picked up in order when he is back, a changed object refused, an expired one dropped; a contact without the switch is unaffected (no S3 needed) |
| `web/wallet-cashu.spec.ts` · `wallets-ready.spec.ts` · `wallet-backups.spec.ts` | wallets ready with no setup, Cashu send/mint errors, the Lightning card, test sats; Ark and USDT recovery phrase and encrypted backup files (`@network`) |
| `web/wallet-providers.spec.ts` | every wallet provider sending and receiving, in the Testnet mode: Cashu (in over Lightning, Send and Request in the chat), Lightning (in through an invoice, out paying an invoice the test mint does not own, `@network`), Ark, Bark and USDT (in, Send from the wallet, Send and Request in the chat; gated, see below) |
| `web/bark-wallet.spec.ts` | Bark (Second's Ark) is not on Mainnet yet; `@network`: a Testnet wallet on Second's signet server by itself, and a chat offers Bark only when both sides allow it (Arkade stays separate) |
| `web/wallet-bdk.spec.ts` | the BDK wallet as the on-chain source: offered in Testnet only, a new wallet's 12 words shown once, a bad phrase or an unreachable Esplora refused before anything is saved, the chat's Bitcoin card; gated (see below): funded, a Send from the wallet, a Send and a Request paid in the chat on regtest |
| `web/wallet-webln.spec.ts` | the browser wallet (WebLN) as the Lightning source, with `window.webln` injected by the test: no wallet, a refused connection, invoices in and payments out (reviewed in Ghostly first), a refused wallet prompt that spends nothing, a chat request paid between two browser wallets (Lightning only, reviewed in the bubble); with `GHOSTLY_WEBLN_REGTEST=1`, the same against two real regtest LND nodes (see below) |
| `web/wallet-sources.spec.ts` | where Lightning and on-chain Bitcoin come from: the Lightning card on the Cashu mints by default, a source picked per mode (invoices through it, Mainnet keeping its own), the Bitcoin card's "no source" state and an on-chain send through a source — with the fake providers, no network |
| `web/nostr-social.spec.ts` | the Nostr social layer on a shared proof: a contact's profile (with picture), follows (with direction hints against your own list) and notes (one hidden by your mute list) load only when asked, from the relays in your profile, with source and time; a contact without the proof sees nothing and asks no relay; publication off by default, then a note, a profile update and an unfollow/follow signed by a NIP-07 signer injected in the page — against a Nostr relay inside the test process (`support/nostrRelay.ts`, the WebSocket routed by Playwright), no network |
| `web/wallet-nwc.spec.ts` | Lightning through Nostr Wallet Connect: a wallet connected by its URI receives and pays over its relay, and a bad URI or a Mainnet wallet in Testnet is refused — against a fake NWC wallet service on a relay in the test process, no network; gated (`GHOSTLY_NWC_REGTEST=1`, see below): two people on their own Alby Hub, a chat request paid over a regtest channel |
| `web/wallet-cln.spec.ts` | Core Lightning as the Lightning source (gated, `GHOSTLY_CLN_REGTEST=1`): the form with a restricted rune (never back in the page), an invoice of the node paid by the other node, an invoice of the other node paid from the card, a chat request paid from one person's node to the other's, balances on both nodes and both cards |

| `web/wallet-lnd.spec.ts` | gated (`GHOSTLY_LND_REGTEST=1`): the LND provider against two real regtest nodes, over REST from the page — the form, invoices in and out through the Lightning card, a chat request paid, both nodes' balances |
| `web/payment-extras.spec.ts` | with `E2E_MINT_URL`: memo and "test sats" in both bubbles, a refused payment is taken back, ecash nobody picks up can be taken back, invoice cards |
| `web/external-wallet.spec.ts` | @network: a request paid with another wallet (QR, `lightning:` link, Copy, "I paid"; the payer pays from its own wallet page and both bubbles turn Paid by themselves), and a Lightning address served by `support/lnurl.ts` (a server in the test process on `E2E_LNURL_PORT`, 47110 by default, handing out the test mint's invoices) paid through the Cashu source, in the wallet and from a chat card |
| `extension/wallet-bdk.spec.ts` | gated (`GHOSTLY_BDK_REGTEST=1`): the BDK wallet's WebAssembly in the extension's offscreen document, receiving and sending on regtest |
| `extension/interop.spec.ts` | the extension and the web app: chat, file, video call |
| `extension/services.spec.ts` | a local web app shared by one extension and opened by another over WebRTC, stopped, offline, gone |
| `extension/paired-services.spec.ts` · `services-extras.spec.ts` | sharing from the chat itself; the contact opens it from Services; removed, it is gone everywhere |
| `desktop/smoke.spec.ts` | the bundled Tauri app opens, and the peer behind it is the one Rust backs |

## Desktop

Desktop is not a browser, so it is not a Playwright project: `tauri-driver` launches the bundled binary and hands its WebView to the platform's WebDriver, and `support/desktop.ts` speaks that protocol over HTTP. Playwright is still the runner — it is only the driving that differs — so the test reads like the others. Nothing is added to the app to make this work: what the test drives is what people install.

```bash
cargo install tauri-driver --locked
sudo apt-get install webkit2gtk-driver xvfb      # Linux; Windows uses msedgedriver
npm run tauri -- build --debug --no-bundle       # not `cargo build`: see below
xvfb-run -a npm run test:e2e:desktop
```

| | |
|---|---|
| Linux | yes, through `WebKitWebDriver` (`webkit2gtk-driver`). This is where CI runs it. |
| Windows | should work, through `msedgedriver`; nothing runs it yet |
| macOS | **no.** WKWebView has no WebDriver, so there is nothing for `tauri-driver` to drive. |

Two things to know:

- Build with `tauri build`, not `cargo build`. A plain cargo debug build points the WebView at `devUrl`, and with no dev server running the window only says "Connection refused". `--debug --no-bundle` keeps the compile short and skips the installers; the test runs the binary from `target/`, newest of `debug` and `release`.
- The app runs under `GHOSTLY_PROFILE=e2e`, so a test never opens your own chats.

The test needs no network either. It asserts what only the Desktop wiring can produce: Settings → Network says `Mainline DHT (BEP44) — Direct UDP` (Rust reaching the DHT, where a browser would say `Pkarr relays (HTTP) → …`), and sharing a local web app is offered. If `ghostlyPlatformModules()` ever swaps `src/desktop/host.ts` for a browser stand-in, this goes red.

### On macOS

`npm run check:desktop-bundle` runs everywhere, in a second, and catches the same class of mistake from the other end: it reads what `src/desktop/` asks of Rust and fails if it is not in `dist/`, and it fails when a module is added to `PLATFORM_MODULES` without someone writing down why Desktop can live with the stand-in. It is a build assertion, not a test — but it is what stands between a Mac and a Desktop feature that silently does nothing. CI runs it on every pull request.

## The combination matrix

Each spec above tests one feature in one setup. `matrix/` tests them together: two people on a combination of
clients, transport, delivery, wallet mode, payment rail and source, identity proof, group, restored profile, language
and screen size — every pair of values at least once, and every client × transport × delivery combination.

```bash
npm run e2e:matrix                                # every scenario, with .env.e2e from npm run e2e:infra:up
npm run e2e:matrix -- --only mx-1a2b3c4d          # reproduce one by the id in the report
npm run e2e:matrix -- --combo client=web-extension,delivery=dht,locale=pt   # any combination (the rest filled in)
npm run e2e:matrix:table                          # after changing dimensions.ts or plan.ts: rewrite the table in matrix.spec.ts
npm run e2e:matrix -- --list                      # print the matrix, run nothing
npm run e2e:matrix -- --shard 1/4 --docs          # a shard; --docs writes the table into docs/TESTING.md
```

| | |
|---|---|
| `matrix/dimensions.ts` | the dimensions and their values, as data; the constraints (what cannot exist, and why); which subset is covered fully |
| `matrix/pairwise.ts` | the generator: all pairs (and the chosen n-wise subset) with the fewest scenarios, greedy and seeded, so a seed is always the same matrix and a scenario id (a hash of its combination) always the same combination |
| `matrix/plan.ts` | the steps of a scenario as data: which apply to a combination, the features of `features.json` each covers, the infrastructure each needs, which are not written yet — and so the scenario's tags |
| `matrix/blocks.ts` | how each step is acted out — pair, talk, away and back (live, DHT, store-and-forward), transport, files, identity proof, payments, group, backup and restore — each asserting what the other person sees |
| `matrix/matrix.spec.ts` | one test per scenario, from the table written into it (`npm run e2e:matrix:table`): the tags are string literals the test map reads, and `table.test.ts` (in `npm test`) fails when the table no longer matches the generator |
| `matrix/actors.ts` | one way to drive a web or extension peer in English or Portuguese, on a laptop or a phone (`either("Join chat")` matches the text in both languages) |
| `matrix/requirements.ts` | what a block needs from outside (a mint, S3, a regtest stack, `gpg`…) and how to tell it is up |
| `matrix/reporter.ts` | the matrix as a table: `test-results/matrix-summary/summary.md` and `results.json`, the job summary in CI |

A (the host) is always a laptop in English; B (who joins) carries the scenario's language, screen and restored profile,
so every scenario is also a mixed pair. A block whose infrastructure is not up is skipped with the reason and the
scenario goes on; the report lists what was skipped. In the HTML report (`playwright-report-matrix/`) every scenario
is tagged `@<dimension>:<value>` (`@clients:web-extension` for the pair): filter by one to see every scenario with it.

The matrix runs every night with the ephemeral environment (`e2e-full.yml`), not on pull requests. It serves its own
build on port 47300 (`MATRIX_WEB_PORT`), and its test domain uses 47320-47399.

## When they run

- Before every release: the `Release` workflow runs them first, and neither the draft release nor the web image is made unless they pass. Desktop is a job of its own there, so a Rust build never holds up the browser tests.
- By hand: Actions → E2E → Run workflow, optionally with the URL of a deployed web app, or `npm run test:e2e` locally.
- Everything, gated suites included: nightly on `dev` and by hand, Actions → E2E (full), which runs
  `npm run e2e:full`. On `ubuntu-24.04` it took about 42 minutes on 2026-09-24: the environment up and funded in
  53 s, the vitest contracts in 37 s, Playwright (2 workers, one retry) in 39 minutes — well inside a runner's
  six hours and the workflow's 150-minute cap. On a 14-core Mac with 7 workers, about 22–28 minutes.

Not on pull requests: at about four minutes it would hold up every merge. `npm run check:desktop-bundle` is the exception — it is fast enough to run there.

## Writing one

For Desktop, use `test` and `app` from `support/desktop.ts`: `app.text(selector)` returns null until something matches, so wait with `expect.poll`. For the browser clients, use `test` and `peer` from `support/fixtures.ts` (or `extensionPeer` / `webPeer` from `support/extension.ts`), `link(a, b)` to put two people in a chat and `connect(a, b)` to wait for the peer-to-peer link. Look for text in the conversation with `chat(peer)`, since the chat list previews the last message too. Prefer what a person sees (titles, labels, text); add a `data-testid` to the app when there is nothing else to hold on to.

Say what it covers: `{ tag: ["@feature:<id>"] }` with ids from [`features.json`](features.json), plus `"@gated"` when it needs infrastructure that is not always there. `npm run test:map` checks the tags on every pull request; see [docs/TESTING.md](../docs/TESTING.md).

## The gated suites

Each needs `e2e/infra` up (or `npm run e2e:full`); the commands below run one of them alone. The support scripts
under `support/*-regtest/` drive their part of the environment — `node e2e/support/<suite>-regtest/regtest.mjs`
with no argument lists what each can do (mine, pay, show balances) — and read credentials (macaroons, runes,
pairing URIs, notes) from the containers into memory, never printing them.

### Held messages on a local S3 server

`profile-backup.spec.ts` and `store-forward.spec.ts` need an S3-compatible server and its keys (`GHOSTLY_S3_*`):
RustFS in `e2e/infra` (MinIO no longer publishes images anyone can pull; any S3 server with open CORS does).

```bash
npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/store-forward.spec.ts
```

Each run makes a bucket of its own. `localStorage["ghostly-test-hold-ttl"]` (milliseconds) shortens how long an item is held, so the test can watch one expire; nothing else reads it and it never lengthens the lifetime.

### Ark payments

arkd on the regtest chain, set up like ArkLabsHQ/arkade-regtest's (`support/ark-regtest/regtest.mjs`: the server
wallet created, unlocked, funded, the intent fees of the earlier stack set).

```bash
npx playwright test e2e/web/ark-wallet.spec.ts -c e2e/playwright.config.ts --project=web
```

The test creates isolated browser profiles, funds a disposable seed with a note from the server
(`support/fund-ark.mjs`), restores through the actual wallet UI, and checks request/review/approval plus receipt
reconciliation after recipient unlock. SDK funding uses a native ESM child process to preserve conditional exports;
the seed is returned through its private pipe, not logged. This does not validate mainnet, unilateral exits or
native/mobile payments.

### Lightning and on-chain providers

`useFakeProviders(peer)` sets `localStorage["ghostly-test-providers"] = "1"` and reloads: the fake Lightning
and Bitcoin providers (regtest, in memory) then show up in the source pickers, in Testnet only. That is
how `wallet-sources.spec.ts` drives a source with nothing running.

A real provider (NWC, WebLN, LND, Core Lightning, Breez, BDK, Bitcoin Core…) gets a gated test of its
own: `GHOSTLY_<NAME>_REGTEST=1` with its services in `e2e/infra`, `test.skip` otherwise. A new one adds its
services to `e2e/infra/docker-compose.yml`, its variables to `e2e/infra/env.mjs` and its `ready` to
`e2e/infra/infra.mjs`. The test does not start or stop infrastructure, uses worthless regtest coins only, and never
prints a secret (macaroons, runes, URIs). See `packages/browser/src/engine/paymentAdapters/PROVIDERS.md`.

### Bitcoin Core on regtest

The Bitcoin Core source (`providers/bitcoind.ts`) is Desktop only: bitcoind's RPC answers no CORS, so the
app reaches it through the `bitcoind_rpc` Tauri command (`src-tauri/src/bitcoind_rpc.rs`, which has Rust
tests for its method allowlist, URL and wallet-name checks, size limits and redirects). The Desktop e2e
harness runs on Linux only, so the engine side is covered by a gated vitest against the environment's bitcoind
instead, reaching it with `fetch` the way the command does (`GHOSTLY_BITCOIND_RPC_URL`, `_USER`, `_PASSWORD` point
it at another node):

```bash
cd packages/browser && GHOSTLY_BITCOIND_REGTEST=1 npx vitest run test/bitcoind.regtest.test.ts --silent=false
```

Each run creates wallets of its own and mines to one of them (it never stops or unloads anything): the
shared on-chain contract suite runs against a fresh wallet, then Alice's wallet is funded by mining, pays
Bob through the `PaymentCoordinator` (review signed and locked, nothing in the mempool until approval),
is reconciled by txid until it confirms, and both balances and the history are checked; a cancelled review
unlocks its coins, a transaction the node rejects is `NothingSpentError` with its coins unlocked, a wrong
password never runs, and a regtest node is refused in the Mainnet mode. It prints the txids and balances.

### Every provider, sending and receiving

```bash
NODE_OPTIONS=--experimental-eventsource npx playwright test e2e/web/wallet-providers.spec.ts -c e2e/playwright.config.ts --project=web
```

Without the environment only Cashu and Lightning run. A test mint marks its own invoices paid, so the
Lightning send pays an invoice from `support/bolt11.ts` instead: signed by a key made for the test, it is
a payment the mint has to make, not one it already knows. On regtest an Ark batch expires within minutes,
and coins in it become recoverable: the test takes the Recover action when it shows, and allows for the
few sats that batch costs.

### Breez (Spark) on Breez's regtest

Breez's nodeless SDK is the `breez` Lightning source (Testnet only for now). Its regtest is hosted by Breez and
Lightspark: **nothing runs locally, no API key**, worthless sats. The Ghostly side makes fresh wallets each run;
the other side of every payment is a counterpart wallet the test runs from Node with the SDK's Node build
(`support/breez.ts`, wallets under the system temp folder, `ghostly-breez-e2e/`).

The counterpart is funded from Lightspark's public regtest faucet (the one behind
https://app.lightspark.com/regtest-faucet) only when it holds fewer than 3,000 sats. Since 2026-09-24 that faucet
refuses requests without a reCAPTCHA ("Missing reCAPTCHA token") and rate-limits by IP, so a test can no longer
fund a new wallet by itself: fund one counterpart by hand on that page and put its recovery phrase in
`GHOSTLY_BREEZ_COUNTERPART` (never commit or print it).

```bash
export GHOSTLY_BREEZ_COUNTERPART="<twelve words of a funded regtest wallet>"   # optional
GHOSTLY_BREEZ_TESTNET=1 npx vitest run test/breez.testnet.test.ts                # in packages/browser: the provider contract on regtest
GHOSTLY_BREEZ_TESTNET=1 npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/breez-wallet.spec.ts
npm run build:extension && GHOSTLY_BREEZ_TESTNET=1 npx playwright test -c e2e/playwright.config.ts --project=extension e2e/extension/breez.spec.ts
```

The vitest run is the shared `describeLightningProvider` contract against real regtest: an invoice of ours paid by
the counterpart, one of the counterpart's paid by us, one too big refused as nothing spent. The Playwright run
has Alice and Bob each make a Breez wallet in the app (WebAssembly in the page), Alice receive 1,000 sats from the
counterpart and pay it 200 from Send, and Bob's chat request of 150 paid by Alice's Breez wallet into Bob's; both
balances are checked. The extension test makes a wallet in the offscreen document (where the WebAssembly runs
there) and moves sats in and out. The request is paid through the bubble's "Copy invoice" and the Lightning card: the bubble's
own review pays Cashu only for now.

### BDK (on-chain Bitcoin) on regtest

The BDK wallet runs in the page (bitcoindevkit in WebAssembly) and reads the chain from the environment's Esplora
(`GHOSTLY_ESPLORA_URL`, CORS open):

```bash
GHOSTLY_BDK_REGTEST=1 npm test -w @ghostly/browser -- bdk.regtest   # the provider contract on the real chain
npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-bdk.spec.ts
npm run build:extension && npx playwright test -c e2e/playwright.config.ts --project=extension e2e/extension/wallet-bdk.spec.ts   # the engine in an offscreen document
```

Both peers make a new BDK wallet on Regtest with the local Esplora; the miner pays Alice's address; Alice sends
to Bob's address from the wallet page (signed at review, broadcast at approval, settled after a block); in the
chat Bob sends (his app asks hers for a fresh address) and then requests, which Alice pays from the bubble. A
request is marked paid only once the payee's own wallet sees the transaction confirmed on its address. The txids
and balances are printed; `regtest.mjs tx <txid>` shows bitcoind's view of one. Funded signet or Mutinynet runs
are not automated: their faucets need a login or a CAPTCHA.

### Nostr Wallet Connect on regtest

Two LND nodes with a channel between them (alice → bob, 1,000,000 sats, 400,000 pushed to bob), each behind its
own Alby Hub, which answers Nostr Wallet Connect (NIP-47) over the environment's strfry relay.

```bash
GHOSTLY_NWC_REGTEST=1 npm test -w @ghostly/browser -- nwc.regtest
npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-nwc.spec.ts
```

The vitest file runs the provider contract against alice's hub (bob's node pays and is paid over the channel),
pays through NWC and checks both nodes' channel balances, makes a real lost answer (the provider gives up after
50 ms, the hub pays anyway, `lookup_invoice` finds it paid) and a payment over the app's budget refused before
anything leaves. The Playwright test gives each person a hub of their own and has Alice pay Bob's request in the
chat; balances are checked in both apps and on both nodes. Pairing URIs come from `nwcUri()` in `regtest.mjs`,
in memory, with the relay rewritten to the host's address; the CLI never prints one (it carries a spending key).

### LND on regtest

Two LND nodes (Alice's and Bob's) with a channel from Alice to Bob that pushed half of it to Bob. Their REST APIs
allow any origin (`restcors=*`: throwaway nodes on 127.0.0.1, and every call still needs a macaroon), so the web
build can be served on any port.

```bash
npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-lnd.spec.ts
GHOSTLY_LND_REGTEST=1 npm test -w @ghostly/browser -- lndProvider     # the provider contract against Alice's node, Bob paying
GHOSTLY_LND_REGTEST=1 cargo test --manifest-path src-tauri/Cargo.toml lnd   # the desktop command, the node's certificate pinned
```

Each app is given its own node's address, a macaroon baked with `info:read invoices:read invoices:write
offchain:read offchain:write` (never the admin one: the form refuses it) and the node's `tls.cert`. LND's
certificate is self-signed, which a browser does not trust: the test's contexts are opened with
`ignoreHTTPSErrors`, standing in for a node set up with a real certificate (a reverse proxy, `letsencryptdomain`).
Desktop needs neither CORS nor a trusted certificate: Rust pins `tls.cert`, which the Rust test checks against the
same node. Credentials are read from the containers in memory (`regtest.mjs`'s `credentials()`) and never printed.

### Bark (Second's Ark) on regtest

Bark is a different Ark server from Arkade and cannot pay it, so it has its own: captaind 0.7.1 (no Lightning) on
the regtest chain and a funder wallet (the bark CLI). captaind is published for amd64 only; on Apple silicon Docker
runs it emulated (`e2e/infra/config/captaind-start.sh` waits for its Postgres instead of giving it two seconds).

```bash
NODE_OPTIONS=--experimental-eventsource npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-providers.spec.ts -g Bark
```

The test switches both peers' Bark wallet from signet to Regtest, has the funder pay Alice's Bark address, sends
coins on-chain to Bob and moves them into Ark (a board: its on-chain fee comes off), then Alice sends from the
wallet page, Bob sends in the chat (his app asks hers for an address) and pays his request; balances are checked
in both apps and the identifiers are printed. Funded signet runs are not automated: Second's faucet
(https://signet.2nd.dev) needs a GitHub login.

### Core Lightning on regtest

Two Core Lightning nodes (v26.06) with a channel from `alice` to `bob` that both sides can spend from. Each node
listens for Commando over a websocket (`bind-addr=ws:…`).

```bash
GHOSTLY_CLN_REGTEST=1 npm test -w @ghostly/browser -- coreLightning.regtest
npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-cln.spec.ts
```

The unit-level test runs the provider contract against alice with bob as the counterpart, plus a rune refused a
method, a wrong node id refused at the handshake, balances on both nodes, and an unroutable invoice refused as
`NothingSpentError`. The e2e test drives the source picker's form in the web app. Runes are made fresh by
`regtest.mjs` (restricted to the methods Ghostly calls) and handed to the test, never printed. Node's built-in
`WebSocket` sends lower-case header names, which Core Lightning's listener refuses; browsers send them as it
expects, and the Node tests use the `ws` package.

### WebLN (browser wallets) on regtest

A browser wallet cannot be installed in Playwright's Chromium, so `support/webln.ts` does what one does: it
injects `window.webln` into the page, and every call goes to a wallet in the test process. Without a variable
that wallet is an in-memory fake (`packages/browser/test/helpers/fakeWebln.ts`). With `GHOSTLY_WEBLN_REGTEST=1`
it is a real LND node of the environment (`packages/browser/test/helpers/lndWebln.ts`), one per person: "alice"
and "bob", with a 2M-sat channel between them (half on each side). The tests read each node's TLS certificate and
macaroon from its container into memory and never print them.

```bash
GHOSTLY_WEBLN_REGTEST=1 npm test -w @ghostly/browser -- weblnProvider.regtest
npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-webln.spec.ts
```

The vitest file runs the provider contract against Alice's node (Bob's pays and is paid) and a payment whose
answer is lost, found paid by looking it up. The e2e connects each person's browser wallet in the app: Alice
receives 1,000 sats from Bob's node, pays 400 from the Lightning card, and pays Bob's 250-sat request in the chat
(Cashu off, so it carries only his wallet's invoice) after reviewing it in the bubble; both nodes' channel
balances move by exactly that, both apps show them, and the balances are printed. What a real Alby adds on top —
its own prompts, its own fee budget — is not exercised here.
