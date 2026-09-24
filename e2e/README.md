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

## No servers

Peers find each other through Pkarr relays. Here the relay is `support/relay.ts`, inside the test process: requests to the public relays are answered from memory, and the extension, whose peer runs where requests cannot be intercepted, is pointed at its local address in Settings → Network. So tests do not wait on the public relays, are never rate limited, and never see each other's packets. WebRTC connects the browsers directly on this machine. GIFCities is stubbed the same way.

Only the tests tagged `@network` go out: the wallet, against the public Cashu test mint (`testnut.cashu.space`, worthless sats whose invoices pay themselves). CI does not even do that — it runs a mint of its own and answers the public one's requests from it, the way the relay answers Pkarr's:

```bash
docker run -d --name ghostly-testmint -p 3338:3338 \
  -e CDK_MINTD_LN_BACKEND=fakewallet -e CDK_MINTD_LISTEN_HOST=0.0.0.0 -e CDK_MINTD_LISTEN_PORT=3338 \
  -e CDK_MINTD_MNEMONIC="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" \
  -e CDK_MINTD_INPUT_FEE_PPK=100 cashubtc/mintd:0.17.7
E2E_MINT_URL=http://127.0.0.1:3338 npm run test:e2e
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
| `web/external-wallet.spec.ts` | @network: a request paid with another wallet (QR, `lightning:` link, Copy, "I paid"; the payer pays from its own wallet page and both bubbles turn Paid by themselves), and a Lightning address served by `support/lnurl.ts` (a server in the test process on port 45911 handing out the test mint's invoices) paid through the Cashu source, in the wallet and from a chat card |
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

## When they run

- Before every release: the `Release` workflow runs them first, and neither the draft release nor the web image is made unless they pass. Desktop is a job of its own there, so a Rust build never holds up the browser tests.
- By hand: Actions → E2E → Run workflow, optionally with the URL of a deployed web app, or `npm run test:e2e` locally.

Not on pull requests: at about four minutes it would hold up every merge. `npm run check:desktop-bundle` is the exception — it is fast enough to run there.

## Writing one

For Desktop, use `test` and `app` from `support/desktop.ts`: `app.text(selector)` returns null until something matches, so wait with `expect.poll`. For the browser clients, use `test` and `peer` from `support/fixtures.ts` (or `extensionPeer` / `webPeer` from `support/extension.ts`), `link(a, b)` to put two people in a chat and `connect(a, b)` to wait for the peer-to-peer link. Look for text in the conversation with `chat(peer)`, since the chat list previews the last message too. Prefer what a person sees (titles, labels, text); add a `data-testid` to the app when there is nothing else to hold on to.

### Held messages on a local S3 server

`profile-backup.spec.ts` and `store-forward.spec.ts` need an S3-compatible server on `127.0.0.1` and its keys in the environment; any MinIO will do, in a container named `ghostly-saf-*` (never print the keys):

```bash
docker run -d --name ghostly-saf-minio -p 127.0.0.1:46010:9000 -e MINIO_ROOT_USER=<key> -e MINIO_ROOT_PASSWORD=<secret> quay.io/minio/minio server /data
npm run build:web && npx vite preview web --port 46020 --strictPort &
E2E_WEB_URL=http://localhost:46020 GHOSTLY_S3_ENDPOINT=http://127.0.0.1:46010 GHOSTLY_S3_KEY=<key> GHOSTLY_S3_SECRET=<secret> npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/store-forward.spec.ts
docker rm -f ghostly-saf-minio   # when done
```

Each run makes a bucket of its own. `localStorage["ghostly-test-hold-ttl"]` (milliseconds) shortens how long an item is held, so the test can watch one expire; nothing else reads it and it never lengthens the lifetime.

### Experimental Ark payments

With the disposable local Ark regtest stack already running at `127.0.0.1:43010`
(operator) and `127.0.0.1:43000/api` (Esplora):

```bash
GHOSTLY_ARK_REGTEST=1 npx playwright test e2e/web/ark-wallet.spec.ts -c e2e/playwright.config.ts --project=web
```

The faucet CLI defaults to `/tmp/ghostly-ark-regtest-20260922/regtest.mjs`;
set `GHOSTLY_ARK_REGTEST_SCRIPT` to another local checkout's script if needed.
The test does not start or stop infrastructure. It creates isolated browser
profiles, funds a disposable seed with worthless regtest credit, restores through
the actual wallet UI, and checks request/review/approval plus receipt reconciliation
after recipient unlock. SDK funding uses a native ESM child process to preserve
conditional exports; the seed is returned through its private pipe, not logged.
This does not validate mainnet, unilateral exits or native/mobile payments.

### Lightning and on-chain providers

`useFakeProviders(peer)` sets `localStorage["ghostly-test-providers"] = "1"` and reloads: the fake Lightning
and Bitcoin providers (regtest, in memory) then show up in the source pickers, in Testnet only. That is
how `wallet-sources.spec.ts` drives a source with nothing running.

A real provider (NWC, WebLN, LND, Core Lightning, Breez, BDK, Bitcoin Core…) gets a gated test of its
own, like Ark's: `GHOSTLY_<NAME>_REGTEST=1` with the node or wallet already running (a regtest stack on
ports it documents here), `test.skip` otherwise.

```bash
GHOSTLY_LND_REGTEST=1 npx playwright test e2e/web/wallet-lnd.spec.ts -c e2e/playwright.config.ts --project=web
```

The test does not start or stop infrastructure, uses worthless regtest coins only, and never prints a
secret (macaroons, runes, URIs). See `packages/browser/src/engine/paymentAdapters/PROVIDERS.md`.

### Bitcoin Core on regtest

The Bitcoin Core source (`providers/bitcoind.ts`) is Desktop only: bitcoind's RPC answers no CORS, so the
app reaches it through the `bitcoind_rpc` Tauri command (`src-tauri/src/bitcoind_rpc.rs`, which has Rust
tests for its method allowlist, URL and wallet-name checks, size limits and redirects). The Desktop e2e
harness runs on Linux only, so the engine side is covered by a gated vitest against a real node instead,
reaching it with `fetch` the way the command does. One bitcoind 31 in a container named
`ghostly-bitcoind-*`, RPC on `127.0.0.1:44301`, worthless regtest coins:

```bash
export GHOSTLY_BITCOIND_RPC_PASSWORD=$(openssl rand -hex 16)
docker run -d --name ghostly-bitcoind-regtest -p 127.0.0.1:44301:18443 bitcoin/bitcoin:31.0 \
  bitcoind -regtest -server -printtoconsole -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 \
  -rpcuser=ghostly -rpcpassword="$GHOSTLY_BITCOIND_RPC_PASSWORD"
cd packages/browser && GHOSTLY_BITCOIND_REGTEST=1 npx vitest run test/bitcoind.regtest.test.ts --silent=false
docker rm -f ghostly-bitcoind-regtest   # when done
```

`GHOSTLY_BITCOIND_RPC_URL` and `GHOSTLY_BITCOIND_RPC_USER` override `http://127.0.0.1:44301` and `ghostly`.
Each run creates wallets of its own and mines to one of them (it never stops or unloads anything): the
shared on-chain contract suite runs against a fresh wallet, then Alice's wallet is funded by mining, pays
Bob through the `PaymentCoordinator` (review signed and locked, nothing in the mempool until approval),
is reconciled by txid until it confirms, and both balances and the history are checked; a cancelled review
unlocks its coins, a transaction the node rejects is `NothingSpentError` with its coins unlocked, a wrong
password never runs, and a regtest node is refused in the Mainnet mode. It prints the txids and balances.

### Every provider, sending and receiving

With the Ark regtest stack above and the local EVM chain (`/tmp/ghostly-usdt-local.json`) running:

```bash
GHOSTLY_ARK_REGTEST=1 GHOSTLY_USDT_LOCAL=1 NODE_OPTIONS=--experimental-eventsource npx playwright test e2e/web/wallet-providers.spec.ts -c e2e/playwright.config.ts --project=web
```

Without the variables only Cashu and Lightning run. A test mint marks its own invoices paid, so the
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
https://app.lightspark.com/regtest-faucet, no login) only when it holds fewer than 3,000 sats. The faucet
rate-limits by IP, so reuse one funded counterpart across runs: put its recovery phrase in
`GHOSTLY_BREEZ_COUNTERPART` (never commit or print it; without it a new one is made and funded each run).

```bash
export GHOSTLY_BREEZ_COUNTERPART="<twelve words of a funded regtest wallet>"   # optional
GHOSTLY_BREEZ_TESTNET=1 npx vitest run test/breez.testnet.test.ts                # in packages/browser: the provider contract on regtest
npm run build:web && npx vite preview web --port 44401 --strictPort &
E2E_WEB_URL=http://localhost:44401 GHOSTLY_BREEZ_TESTNET=1 npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/breez-wallet.spec.ts
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

The BDK wallet runs in the page (bitcoindevkit in WebAssembly) and reads the chain from an Esplora server, so its
stack is bitcoind 31 with a miner wallet and an electrs answering browsers (CORS), worthless regtest coins, in
containers named `ghostly-bdk-*` on `127.0.0.1:44201` (bitcoind RPC) and `127.0.0.1:44202` (Esplora):

```bash
docker compose -p ghostly-bdk -f e2e/support/bdk-regtest/docker-compose.yml up -d
node e2e/support/bdk-regtest/regtest.mjs ready     # a miner wallet with coins, Esplora caught up
GHOSTLY_BDK_REGTEST=1 npm test -w @ghostly/browser -- bdk.regtest   # the provider contract on the real chain
npm run build:web && npx vite preview web --port 44210 --strictPort &
E2E_WEB_URL=http://localhost:44210 GHOSTLY_BDK_REGTEST=1 npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-bdk.spec.ts
npm run build:extension && GHOSTLY_BDK_REGTEST=1 npx playwright test -c e2e/playwright.config.ts --project=extension e2e/extension/wallet-bdk.spec.ts   # the engine in an offscreen document
docker compose -p ghostly-bdk -f e2e/support/bdk-regtest/docker-compose.yml down -v   # when done
```

Both peers make a new BDK wallet on Regtest with the local Esplora; the miner pays Alice's address; Alice sends
to Bob's address from the wallet page (signed at review, broadcast at approval, settled after a block); in the
chat Bob sends (his app asks hers for a fresh address) and then requests, which Alice pays from the bubble. A
request is marked paid only once the payee's own wallet sees the transaction confirmed on its address. The txids
and balances are printed; `regtest.mjs tx <txid>` shows bitcoind's view of one. Funded signet or Mutinynet runs
are not automated: their faucets need a login or a CAPTCHA.

### Nostr Wallet Connect on regtest

Two regtest LND nodes with a channel between them (alice → bob, 1,000,000 sats, 400,000 pushed to bob), each
behind its own Alby Hub, which answers Nostr Wallet Connect (NIP-47) over a local strfry relay. Worthless coins,
containers named `ghostly-nwc-*`, everything on `127.0.0.1`:

| Port | |
|---|---|
| 44501 | bitcoind RPC (regtest) |
| 44502 | the Nostr relay, `ws://127.0.0.1:44502` |
| 44511 / 44512 | LND REST, alice / bob |
| 44521 / 44522 | Alby Hub, alice / bob |

```bash
docker compose -p ghostly-nwc -f e2e/support/nwc-regtest/docker-compose.yml up -d
node e2e/support/nwc-regtest/regtest.mjs ready      # funds both nodes, opens the channel, starts both hubs (idempotent)
GHOSTLY_NWC_REGTEST=1 npm test -w @ghostly/browser -- nwc.regtest
npm run build:web && npx vite preview web --port 44581 --strictPort &
E2E_WEB_URL=http://localhost:44581 GHOSTLY_NWC_REGTEST=1 npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-nwc.spec.ts
docker compose -p ghostly-nwc -f e2e/support/nwc-regtest/docker-compose.yml down -v   # when done
```

The vitest file runs the provider contract against alice's hub (bob's node pays and is paid over the channel),
pays through NWC and checks both nodes' channel balances, makes a real lost answer (the provider gives up after
50 ms, the hub pays anyway, `lookup_invoice` finds it paid) and a payment over the app's budget refused before
anything leaves. The Playwright test gives each person a hub of their own and has Alice pay Bob's request in the
chat; balances are checked in both apps and on both nodes. Pairing URIs come from `nwcUri()` in `regtest.mjs`,
in memory, with the relay rewritten to the host's address; the CLI never prints one (it carries a spending key).

### LND on regtest

Two LND nodes (Alice's and Bob's) on one bitcoind, with a channel from Alice to Bob that pushed half of it to
Bob, all worthless regtest coins, in containers named `ghostly-lnd-*`. Only the REST APIs are published, on
`127.0.0.1:44710` (Alice) and `127.0.0.1:44720` (Bob); they allow the origin `http://localhost:44780`
(`restcors`), so the web build must be served there:

```bash
docker compose -p ghostly-lnd -f e2e/support/lnd-regtest/docker-compose.yml up -d
node e2e/support/lnd-regtest/regtest.mjs ready      # mines, funds Alice, opens the channel, bakes the scoped macaroons (once)
npm run build:web && npx vite preview web --port 44780 --strictPort &
E2E_WEB_URL=http://localhost:44780 GHOSTLY_LND_REGTEST=1 npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-lnd.spec.ts
GHOSTLY_LND_REGTEST=1 npm test -w @ghostly/browser -- lndProvider     # the provider contract against Alice's node, Bob paying
GHOSTLY_LND_REGTEST=1 cargo test --manifest-path src-tauri/Cargo.toml lnd   # the desktop command, the node's certificate pinned
docker compose -p ghostly-lnd -f e2e/support/lnd-regtest/docker-compose.yml down -v   # when done
```

Each app is given its own node's address, a macaroon baked with `info:read invoices:read invoices:write
offchain:read offchain:write` (never the admin one: the form refuses it) and the node's `tls.cert`. LND's
certificate is self-signed, which a browser does not trust: the test's contexts are opened with
`ignoreHTTPSErrors`, standing in for a node set up with a real certificate (a reverse proxy, `letsencryptdomain`).
Desktop needs neither CORS nor a trusted certificate: Rust pins `tls.cert`, which the Rust test checks against the
same node. Credentials are read from the containers in memory (`regtest.mjs`'s `credentials()`) and never printed.

### Bark (Second's Ark) on regtest

Bark is a different Ark server from Arkade and cannot pay it, so it has its own stack: bitcoind 31, captaind 0.7.1
(no Lightning), an Esplora (electrs, for the browser's on-chain wallet) and a funder wallet (the bark CLI), all
worthless regtest coins, in containers named `ghostly-bark-*` on `127.0.0.1:44101-44135`:

```bash
docker compose -p ghostly-bark -f e2e/support/bark-regtest/docker-compose.yml up -d
node e2e/support/bark-regtest/regtest.mjs ready     # mines, funds the server, boards the funder (once)
npm run build:web && npx vite preview web --port 44181 --strictPort &
E2E_WEB_URL=http://localhost:44181 GHOSTLY_BARK_REGTEST=1 npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-providers.spec.ts -g Bark
docker compose -p ghostly-bark -f e2e/support/bark-regtest/docker-compose.yml down -v   # when done
```

The test switches both peers' Bark wallet from signet to Regtest, has the funder pay Alice's Bark address, sends
coins on-chain to Bob and moves them into Ark (a board: its on-chain fee comes off), then Alice sends from the
wallet page, Bob sends in the chat (his app asks hers for an address) and pays his request; balances are checked
in both apps and the identifiers are printed. captaind is published for amd64 only; on Apple silicon Docker runs
it emulated. Funded signet runs are not automated: Second's faucet (https://signet.2nd.dev) needs a GitHub login.

### Core Lightning on regtest

Two Core Lightning nodes (v26.06) on a regtest bitcoind 31, with a channel from `alice` to `bob` that both sides
can spend from, in containers named `ghostly-cln-*`. Each node listens for Commando over a websocket
(`bind-addr=ws:…`), published on `127.0.0.1:44810` (alice) and `127.0.0.1:44811` (bob); bitcoind's RPC on `44801`:

```bash
docker compose -p ghostly-cln -f e2e/support/cln-regtest/docker-compose.yml up -d
node e2e/support/cln-regtest/regtest.mjs ready     # mines, funds both nodes, opens the channel (once)
GHOSTLY_CLN_REGTEST=1 npm test -w @ghostly/browser -- coreLightning.regtest
npm run build:web && npx vite preview web --port 44820 --strictPort &
E2E_WEB_URL=http://localhost:44820 GHOSTLY_CLN_REGTEST=1 npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-cln.spec.ts
docker compose -p ghostly-cln -f e2e/support/cln-regtest/docker-compose.yml down -v   # when done
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
it is a real LND node of a disposable regtest stack (`packages/browser/test/helpers/lndWebln.ts`), one per
person: bitcoind 31 and two LND 0.19 nodes, "alice" and "bob", with a 2M-sat channel between them (half on each
side), in containers named `ghostly-webln-*`. Only the two REST APIs are published, on `127.0.0.1:44610` and
`:44611`; the tests read each node's TLS certificate and macaroon from its container into memory and never
print them.

```bash
docker compose -p ghostly-webln -f e2e/support/webln-regtest/docker-compose.yml up -d
node e2e/support/webln-regtest/regtest.mjs ready     # mines, funds both nodes, opens the channel (once)
GHOSTLY_WEBLN_REGTEST=1 npm test -w @ghostly/browser -- weblnProvider.regtest
npm run build:web && npx vite preview web --port 44680 --strictPort &
E2E_WEB_URL=http://localhost:44680 GHOSTLY_WEBLN_REGTEST=1 npx playwright test -c e2e/playwright.config.ts --project=web e2e/web/wallet-webln.spec.ts
docker compose -p ghostly-webln -f e2e/support/webln-regtest/docker-compose.yml down -v   # when done
```

The vitest file runs the provider contract against Alice's node (Bob's pays and is paid) and a payment whose
answer is lost, found paid by looking it up. The e2e connects each person's browser wallet in the app: Alice
receives 1,000 sats from Bob's node, pays 400 from the Lightning card, and pays Bob's 250-sat request in the chat
(Cashu off, so it carries only his wallet's invoice) after reviewing it in the bubble; both nodes' channel
balances move by exactly that, both apps show them, and the balances are printed. What a real Alby adds on top —
its own prompts, its own fee budget — is not exercised here.
