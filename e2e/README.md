# End-to-end tests

Real Chromium against the shipped build: the web app (`web/dist`, served by `vite preview`) and the extension (`extension/dist`). Two or three people per test, each in a browser profile of their own, chatting, sending files, calling and paying each other.

```bash
npm run test:e2e            # everything (builds the web app and the extension first)
npm run test:e2e:offline    # everything but the tests that need the internet
npm run test:e2e:ui         # pick, watch and debug tests
npm run test:e2e:report     # the report of the last run: traces, videos, screenshots of failures
HEADED=1 npm run test:e2e -- --project=extension   # watch the extension windows
E2E_WEB_URL=https://app.ghostly.tools npx playwright test -c e2e/playwright.config.ts --project=web   # a deployed app
```

## No servers

Peers find each other through Pkarr relays. Here the relay is `support/relay.ts`, inside the test process: requests to the public relays are answered from memory, and the extension, whose peer runs where requests cannot be intercepted, is pointed at its local address in Settings → Network. So tests do not wait on the public relays, are never rate limited, and never see each other's packets. WebRTC connects the browsers directly on this machine. Giphy and GifCities are stubbed the same way.

Only the tests tagged `@network` go out: the wallet, against the public Cashu test mint (`testnut.cashu.space`, worthless sats whose invoices pay themselves).

## What runs where

| | |
|---|---|
| `web/app.spec.ts` | home, one tab per peer, create/join/name/search/delete chats, "Delete all chats" stays deleted, clear all data, tech info |
| `web/settings.spec.ts` | nickname, color theme and mode, language, switches, lock screen (password, lock now, idle timeout), relays |
| `web/chat.spec.ts` | two people: relay then peer to peer, nicknames, read ticks, long messages, offline delivery, emoji, GIFs, files (3 MiB, checksum), images |
| `web/calls.spec.ts` | video and audio calls, mute, camera, screen share, decline, the movable self view, the small call window |
| `web/mobile.spec.ts` | the phone layout: tabs, chat screen, composer |
| `web/wallet.spec.ts` | `@network`: Lightning in, ecash out, requests, history and fees, invoice and token cards |
| `extension/interop.spec.ts` | the extension and the web app: chat, file, video call |
| `extension/services.spec.ts` | a local web app shared by one extension and opened by another over WebRTC, stopped, offline, gone |

## When they run

- Before every release: the `Release` workflow runs them first, and neither the draft release nor the web image is made unless they pass.
- By hand: Actions → E2E → Run workflow, optionally with the URL of a deployed web app, or `npm run test:e2e` locally.

Not on pull requests: at about four minutes it would hold up every merge.

## Writing one

Use `test` and `peer` from `support/fixtures.ts` (or `extensionPeer` / `webPeer` from `support/extension.ts`), `link(a, b)` to put two people in a chat and `connect(a, b)` to wait for the peer-to-peer link. Look for text in the conversation with `chat(peer)`, since the chat list previews the last message too. Prefer what a person sees (titles, labels, text); add a `data-testid` to the app when there is nothing else to hold on to.
