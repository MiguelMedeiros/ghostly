# Changelog

## Unreleased

### Added

- **Calls.** A voice call can turn into a video call, and share a screen, without calling again. The camera and screen buttons are there during any call now: press one and the other side sees it, with nothing to accept and no second ring. Stopping a screen share goes back to what you had before it, your camera or just your voice. Every call carries an empty video section for this, so a peer on an older version still rings, still talks and still sees your picture when you turn it on — it just cannot turn its own on until it updates.
- **Updates.** Every client now says when a new version is out, and puts it in place where it can. The desktop app downloads it, checks our signature and restarts into it; on the web it is a reload; the extension points you at the download until it is in a store. Nothing happens by itself — updating ends your calls, so it waits for you. The check can be turned off in **Settings → Updates**.

### Fixed

- **Calls** ended the moment you left the chat: opening Settings, the wallet or another chat hung up on whoever you were talking to. A call now comes along in its small window wherever you go, and takes you back to its chat when you shrink it back. Locking Ghostly no longer shows the call over the lock screen either — the call keeps going, out of sight, until you unlock.
- **CLI:** `ghostly-cli --version` reported `0.1.0` whatever version you had installed. It now says which version it actually is.

## 0.3.4

A security release for Ghostly Desktop. Update it. Nothing changes on the wire, and older clients keep working.

### Security

- **Desktop:** a web app a contact shares could put itself on another contact's app's address, and from there read and change what that app had stored on your machine. A window now only ever shows the app it was opened for.

## 0.3.3

Small security fixes from the scheduled review. Nothing changes on the wire, and older clients keep working.

### Security

- **Clear all data** and deleting a single chat left one bookkeeping key per chat behind, carrying the id of a conversation that existed. Both now take it with them, and keys left by older versions are cleared as well.
- **Names a contact chooses** — its nickname and the names of the apps it shares — are now shown as what they are. Invisible and direction-changing characters are removed, as they already were from file names, so a contact cannot make the name it is known by read as someone else's, and a nickname has a length again.

### Fixed

- **Linux:** the AppImage opens on Wayland desktops with a newer Mesa (openSUSE Leap 16, Fedora), where the window used to stay blank.

## 0.3.2

A security release: everything a contact can send you is now held to what the protocol allows. Update every client. Nothing changes on the wire, and older clients keep working.

### Security

- **Desktop:** a web app a contact shares could call Ghostly's own commands from its window, including requests to any service on your machine. Those windows now reach no command at all.
- **Ghostly Browser:** a contact's web app could reach other contacts' apps as you and plant cookies in them. Each contact's apps now live on a site of their own, and a tab only ever talks to the app it was opened for. Shared apps now open on `https://<app>.<contact>.invalid`, so apps you had open start with fresh storage.
- **Payments:** a request was marked paid by any ecash that referenced it, whatever the amount, and a contact's test sats added the test mint to your wallet. A request is now paid only in full, from a mint it named, and only you add mints.
- **Wallet:** a Lightning payment still pending at the mint, an invoice paid after it expired, or a crash while ecash was on its way could lose sats. Payments in flight are now written down first and settled with the mint afterwards, and you can no longer pay the same request twice.
- **Chats:** the address of an open chat carried its private keys, so they ended up in your browser history. Chats are now addressed by an id, and invite links are cleared from the address bar as soon as they are read.
- **Lock screen:** reloading the app skipped it. Ghostly now starts locked, keeps the app out of reach while locked, slows down repeated wrong passwords, and stores the password with a much stronger hash. It still does not encrypt what is stored on the device, and now says so.
- **Calls:** call signaling from a contact is checked field by field before it is used, and old signals no longer ring.
- **Files:** a contact could replace a file you had sent, fill your disk, or send a file whose name hides its real extension. Received files are stored apart from sent ones, each contact gets 500 MiB, names lose invisible and direction characters, and files that are not pictures are stored as plain downloads.
- **Shared apps:** redirects never leave the app you share, headers that let a caller pretend to be a proxy are dropped, encoded slashes cannot escape the app's path, and a contact can no longer get around the limit on parallel requests.
- **Clear all data** removes chats, files and settings but keeps your wallet: ecash is money, and nothing else holds a copy of it.
- The website runs on Next.js 16.3.3 and Node 22; the web app on nginx 1.30, without advertising its version.

### Added

- [SECURITY.md](SECURITY.md): how to report a vulnerability (ghostly-sec@miguelmedeiros.com.br), and [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md), what was found, fixed and proven.
- Dependencies are checked against known advisories on every change and every day, and security fixes can ship as patch releases on their own.

## 0.3.1

Two fixes. Nothing changes on the wire.

### Fixed

- The GitHub link in Settings → About went to a repository that does not exist. It now opens github.com/MiguelMedeiros/ghostly.
- In the web app and the extension, chats removed with **Delete all chats** came back a few seconds later as empty "Anonymous" chats, and the same button also reset your settings. Deleting chats now deletes only the chats, and they stay deleted; **Clear all data** no longer brings them back either.

## 0.3.0

Ghostly on your phone, and calls that do more. Nothing changes on the wire: 0.3.0 talks to 0.2.x and 0.1.x exactly as before.

### New

- **A phone layout that feels like a messenger.** Below 768px the app shows one screen at a time: the chat list, then the conversation with a back arrow. Wallet, Share and Settings are screens of their own behind a bottom tab bar; emoji, GIFs and payments open as bottom sheets; calls take the whole screen. The layout follows the visible viewport, so the message input stays above the keyboard, and respects the safe areas. The web app can be installed to the home screen. Wide screens are unchanged.
- **Screen sharing.** In a video call, swap your camera for your screen and back; or start a call straight from "Share your screen" in the chat header. The screen rides on the video stream the call already has, so there is no new signaling and older clients receive it as ordinary video. A shared screen is shown whole instead of cropped. Needs a browser that can capture the screen, so not on phones.
- **A call you can put aside.** The call screen shrinks into a floating window that can be dragged anywhere and resized from its corner, so you can keep chatting, send files or sats while you talk. It remembers how you left it.
- **Your own picture in a call moves and resizes.** Drag it anywhere, pull any corner to resize it. It keeps the shape of what it shows, camera or screen, never leaves the window, and a double click puts it back. The small call window resizes the same way.
- **Money pasted into a chat reads as money.** A Lightning invoice shows its amount, description and expiry, with a QR code, a copy button, a link that opens a Lightning wallet on the device, and a Pay button that quotes the fee before anything is spent. Ecash tokens show their amount, mint and memo and can be redeemed from the card; Cashu payment requests are shown too. Long invoices and tokens fit once the peer to peer connection is open.
- **A simpler wallet.** A bigger balance with two plain actions, Receive and Pay. Pay reads a pasted Lightning invoice on the spot (amount, description, expired or not) before anything is asked of the mint. The mints list is one line per mint, with limits, the message of the day and the remove and make-primary actions a click away, and one sentence of context instead of a paragraph.

### Fixed

- In a call, your own picture stayed black after turning the camera off and on again.
- The history said "1 movements".

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
