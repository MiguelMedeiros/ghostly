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

Peers find each other through Pkarr relays. Here the relay is `support/relay.ts`, inside the test process: requests to the public relays are answered from memory, and the extension, whose peer runs where requests cannot be intercepted, is pointed at its local address in Settings → Network. So tests do not wait on the public relays, are never rate limited, and never see each other's packets. WebRTC connects the browsers directly on this machine. Giphy and GifCities are stubbed the same way.

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
| `web/calls.spec.ts` | video and audio calls, mute, camera, screen share, decline, the movable self view, the small call window |
| `web/mobile.spec.ts` | the phone layout: tabs, chat screen, composer |
| `web/wallet.spec.ts` | `@network`: Lightning in, ecash out, requests, history and fees, invoice and token cards — against a real mint, ours in CI |
| `extension/interop.spec.ts` | the extension and the web app: chat, file, video call |
| `extension/services.spec.ts` | a local web app shared by one extension and opened by another over WebRTC, stopped, offline, gone |
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
