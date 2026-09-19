# Changelog

## Unreleased

- **Money pasted into a chat reads as money.** A Lightning invoice shows its amount, description and expiry, with a QR code, a copy button, a link that opens a Lightning wallet on the device, and a Pay button that quotes the fee before anything is spent. Ecash tokens show their amount, mint and memo and can be redeemed from the card; Cashu payment requests are shown too. Long invoices and tokens fit once the peer to peer connection is open.
- **A phone layout that feels like a messenger.** Below 768px the app shows one screen at a time: the chat list, then the conversation with a back arrow. Wallet, Share and Settings are screens of their own behind a bottom tab bar; emoji, GIFs and payments open as bottom sheets; calls take the whole screen. The layout follows the visible viewport, so the message input stays above the keyboard, and respects the safe areas. The web app can be installed to the home screen. Wide screens are unchanged.

## 0.2.0

Ghostly grows from an ephemeral chat into an ephemeral, identity-addressed peer-to-peer service layer: **your services exist while you are online.** The protocol stays compatible with 0.1.x: invites, records and call signaling are unchanged, everything new is additive.

### New

- **Ghostly Browser**, a Chromium extension, and **Ghostly on the web** (`docker compose up`, or app.ghostly.tools): the same client as the desktop app, from the same code. Browsers reach Pkarr through relays, which are configurable.
- **A direct WebRTC link between contacts.** It opens on its own when both are online; messages, call signaling, files, payments and services travel over it, peer to peer. Pkarr is only used to find each other.
- **Share a local web app.** Name it, give its `localhost` address, and your contacts can use it while you are online. Requests address a service id, never a URL; only loopback targets, no redirects off the target, no cookies of yours. Opening a contact's app gives it an origin and a window or tab of its own.
- **Files**, up to 100 MiB, straight to the contact, with image previews.
- **Sats.** An ecash (Cashu) wallet: receive and pay over Lightning through a mint, send and request sats in a chat, a history with the exact fee of every movement, and what each mint charges. Ecash is custodial; this is pocket money. Payment frames follow Paykit's vocabulary.
- A keyless **Retro** GIF source (GifCities) next to Giphy, and a Giphy API key setting: Giphy retired the public key earlier versions relied on.
- Motion and synthesized sound for arriving messages, payments, calls and transfers, with a Reduce motion setting.

### Changed

- The desktop app now runs the same peer as the browser clients in its WebView, with Rust for the Mainline DHT, local apps and viewer windows. The chat loop it used to run in the page lives in that peer.
- Calls ring in about a second instead of ten, and video calls connect on Chromium based engines.
- More room between messages in the chat.

### Fixed

- A hang-up could wipe the offer of the next call.
- `tauri build` refused to run because the Tauri npm packages and crate versions had drifted apart.

### Notes for this release

- Set the `VITE_GIPHY_API_KEY` repository secret for GIFs from Giphy in release builds.
- The wallet has no seed yet; "Copy backup tokens" is the only backup.
- Not verified yet: calls between the desktop app and the other clients, and the desktop app on Windows and Linux (WebKitGTK often ships without WebRTC, which the direct link needs).
