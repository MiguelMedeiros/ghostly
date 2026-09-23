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
| `web/wallet-cashu.spec.ts` · `wallets-ready.spec.ts` · `wallet-backups.spec.ts` | wallets ready with no setup, Cashu send/mint errors, the Lightning card, test sats; Ark and USDT recovery phrase and encrypted backup files (`@network`) |
| `web/wallet-providers.spec.ts` | every wallet provider sending and receiving, in the Testnet mode: Cashu (in over Lightning, Send and Request in the chat), Lightning (in through an invoice, out paying an invoice the test mint does not own, `@network`), Ark and USDT (in, Send from the wallet, Send and Request in the chat; gated, see below) |
| `web/payment-extras.spec.ts` | with `E2E_MINT_URL`: memo and "test sats" in both bubbles, a refused payment is taken back, ecash nobody picks up can be taken back, invoice cards |
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

### Every provider, sending and receiving

With the Ark regtest stack above and the local EVM chain (`/tmp/ghostly-usdt-local.json`) running:

```bash
GHOSTLY_ARK_REGTEST=1 GHOSTLY_USDT_LOCAL=1 NODE_OPTIONS=--experimental-eventsource npx playwright test e2e/web/wallet-providers.spec.ts -c e2e/playwright.config.ts --project=web
```

Without the two variables only Cashu and Lightning run. A test mint marks its own invoices paid, so the
Lightning send pays an invoice from `support/bolt11.ts` instead: signed by a key made for the test, it is
a payment the mint has to make, not one it already knows. On regtest an Ark batch expires within minutes,
and coins in it become recoverable: the test takes the Recover action when it shows, and allows for the
few sats that batch costs.
