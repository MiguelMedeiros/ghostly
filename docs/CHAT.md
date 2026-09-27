# Chat

What a chat is, what its header, menus and composer hold, and how messages render. Specs: [WISP 400 Chat Messaging](wisps/400-chat.md) and the WISPs linked below. Transports: [TRANSPORTS.md](TRANSPORTS.md). DHT text: [DHT-DELIVERY.md](DHT-DELIVERY.md).

## One chat

- There is one kind of 1:1 chat and one invite ([WISP 400](wisps/400-chat.md)).
- **Layer 0, the DHT**: rendezvous, then a floor of short text and held-item pointers ([WISP 403 DHT Text](wisps/403-dht-text.md)).
- **Layer 1, a peer-to-peer stream** (WebRTC, Iroh or HyperDHT) for everything else ([WISP 401 Chat Session](wisps/401-paired-chat.md)).
- A chat upgrades to live by itself and falls back to the DHT. Each chat can be set to DHT only.
- Chats made by v0.4 apps open as a **compatibility chat** ([WISP 402](wisps/402-legacy-chat.md)), tagged "Compatibility chat · older Ghostly", with "Continue in a new chat" in the ⋮.
- **Hold messages** ([WISP 4xx Store-and-Forward](wisps/4xx-store-and-forward.md), experimental): what is sent while the contact is away waits sealed for them. One switch per chat, and both sides must allow it.

## Invites

- One code: `ghostly1…`, bech32m, 1023 characters at most (#210, `packages/core/src/invite.ts`, [WISP 800](wisps/800-invite-join.md), [WISP 801](wisps/801-invitation-profiles.md)).
- It carries the seed, the inviter's rendezvous key, the invite secret and the inviter's participation key. The joiner pins that key: another key cannot take the chat over.
- Shared as `https://ghostly.tools/#ghostly1…` (the code stays in the fragment, so no server sees it) or as a QR (`src/components/InviteCard.tsx`).
- **Join** (`src/components/JoinDialog.tsx`): paste, scan a QR, open an image, or type. It also takes group links. Bad codes get one of four messages: typo, needs an update, not a Ghostly code, damaged.
- The ghostly.tools join page takes the code out of the address before analytics load, and offers the web app, the desktop app or a download.

## Header

Left to right (`src/pages/Chat.tsx`): avatar, name (click to rename), the contact's identity marks ([IDENTITIES.md](IDENTITIES.md)), then on the right the **connection icon**, the audio and video call buttons, and ⋮.

Under the name, the contact's key, or **typing…** with three dots while the contact writes (`src/components/TypingIndicator.tsx`); **recording audio…** while the contact records a voice note (from the moment the mic opens, held or hands-free, until it is sent or thrown away); **thinking…**, or a bot's own short status such as "Transcribing your audio…", shown as plain text. The chat list row shows the same in its preview line, in the accent. It is presence, not connection, so it never goes in the icon. Paired 1:1 chats only, over the live session (`typing/1`, [WISP 401](wisps/401-paired-chat.md#typing)): it goes with the message, a cleared composer, 5 seconds without a keystroke, or, if the stop is lost, 6 seconds after the contact's last word. Settings → Security → **Send typing indicator** (per profile, on by default) stops telling contacts; theirs still shows.

### Connection icon and panel

The icon is the header's only connection element (#264, #287, `src/components/ChatConnection.tsx`, `src/components/ConnectionIcon.tsx`).

- States: connected (the transport's own mark), on the DHT, waiting, failure, offline. A first pairing shows its progress in the icon.
- The short panel: one state line (with round trip when live), the transport choice, a Fallback switch, **Reconnect** when not live, and one closed **Details**.
- Transport choice, a radio group: Automatic, then one row per transport this app runs (WebRTC, Iroh, HyperDHT), then **DHT only**.
- Details holds the rest: path, round trip, why it is not live, relay health, key verification ("The codes match"), both keys, connection history.

### ⋮ menu (1:1)

In order, some rows only when they apply:

1. Pin chat / Unpin chat
2. Mute notifications… / Unmute notifications
3. Copy invite code (until the contact arrives)
4. Hold messages… (paired chats)
5. Continue in a new chat (compatibility chats)
6. Refresh
7. Tech Info
8. Delete chat

Connection, Payments, Services and Identities are no longer in the ⋮ (#264, #267, #268): they live in the header icon, the header marks and the composer's +.

### Mute

- From the chat list: the row's bell in the hover actions (#262), or the ⋮ on a phone.
- 15 minutes, 1 hour, 1 day, or until unmuted. Groups add "Still notify me when I'm mentioned".
- Messages still arrive, and **calls still ring**. Only the message sound, the system notification and the connected sound are silenced (`src/lib/chatMute.ts`). Local to this device.

## Composer

- **+** (`src/components/MessageInput.tsx`, `src/components/composer/ComposerMenu.tsx`), each row when it applies:
  - **Payment**: pay, request, or choose what the chat accepts ([WALLETS.md](WALLETS.md#payments-in-a-chat))
  - **Identity**: share an identity (paired 1:1 chats)
  - **Shared services** (#268): apps shared with this contact. Greyed on the web app: "Needs the Ghostly extension or desktop app".
  - **Document**, **Photos & videos**, **Camera** (when the device has one)
- **Emoji and GIFs**: one panel with two tabs. GIFs come from GifCities (Internet Archive) and are sent as a link.
- **Voice messages** (#214, #355, #363): the mic takes the Send button's place while the text is empty, as in WhatsApp (`src/components/voice/`).
  - Hold to record and release to send. Slide sideways to cancel, slide up to lock.
  - A click (or the keyboard) records hands-free at once. Locked, the mic turns into **Send**: one press sends. The row holds Discard, the timer, the live waveform and **Pause**; paused, ▶ plays back what is recorded so far and the mic reads **Resume**.
  - **Enter** sends while locked. **Esc** discards under 3 s; longer, it pauses and asks "Discard voice message?" in the bar.
  - Recorded as Opus when the browser can; a file that `<audio>` refuses plays through a WAV fallback (`packages/core/src/voice.ts`, `src/lib/voiceDecode.ts`).
  - Playing, a pill in the mic's place sets the speed: 1×, 1.5×, 2×, pitch kept, remembered on the device (#345).
- **Paste or drop** (#349): paste a picture or files into the composer, or drop files on the chat column. A sheet shows them with an optional caption, **Send** and **Cancel**; another paste adds to it. Plain text pastes as text. Not in groups, which take no files.
- **Secret guard** (#283): asks before a seed, a private key or a Cashu token goes out as text ([WALLETS.md](WALLETS.md#secret-guard)).
- **Mentions** (#279): `@` in a group picks a member. A mention is bound to the member's key. Paired chats have no mentions.
- **Edits** (#351): edit a text you sent from its ⋮ (Edit), or press ↑ in an empty composer for your last one. The composer shows what you edit (✕ or Escape leaves it as it was, and your draft comes back); Enter saves. The bubble says *edited* beside the time (until your contact's app confirms it, its hint says it was not shown yet), and the message's details list the earlier versions. An edit never rings, never counts as unread and never moves the chat; the chat list shows the new text. 1:1 chats only; texts only; at most 100 edits a message, no time limit. A contact whose app does not show edits keeps the old text, and gets the edit once it does ([WISP 400](wisps/400-chat.md#edits)).
- **Replies** (#347): answer a message from its ⋮ (Reply), the reply button beside it, or a swipe right on a touch screen. The composer shows what you answer (✕ or Escape to let go); the reply's bubble quotes it, and a tap jumps to the original. The reply names the original by the id both sides know it by, with a short line of it, so it still reads where the original is gone ([WISP 400](wisps/400-chat.md#replies)). Texts and files (a voice message included, #359) carry a reply; payments do not.
- **Reactions** (#354): one emoji per person per message, like WhatsApp. Hover a message for the React button (or its ⋮ → React; a long press on a phone) to open a quick bar of six and + for any emoji. Chips under the bubble show each emoji with its count and who chose it; a click on yours takes it back, on another adds the same. A reaction never counts as unread or plays the message sound; the chat list says the latest. It travels live once both apps say `react/1`, and on DHT envelopes meanwhile; groups carry it too ([WISP 400](wisps/400-chat.md#reactions)).

## A message's ⋮

In order, each row when it applies (`src/components/MessageBubble.tsx`):

1. **Reply** (#347)
2. **React** (#354)
3. **Send again**, for a message that was not sent (#360)
4. **Download**, for a voice message, a picture or a file, once its bytes are on this device (#346). Desktop opens the save dialog; web and extension download it.
5. **Download as MP3**, for a voice message: converted on this device, mono at 64 kbit/s (#365)
6. **Details** (#240)
7. **Cancel sending** for a message still waiting, else **Delete** (from this device only)

## Delivery marks

One mark beside the time, as in WhatsApp (#360, `src/components/chat/DeliveryStatus.tsx`): 🕓 sending or waiting for the contact, ✓ sent, ✓✓ delivered, a red ! not sent. Hover, focus or tap the mark for one line on what happens next; the engine's reason is in ⋮ → Details. The red mark is a button that sends again. A voice message or file that did not go, or stopped moving, shows a round ↻ in place of play or its icon. Group messages keep the tick from receipts.

## How messages render

The text is sent as typed. Everything below happens on display, and nothing is rendered as HTML ([src/lib/parse/README.md](../src/lib/parse/README.md)).

| Feature | What | PR |
|---|---|---|
| Rich text | `*bold*`, `_italic_`, `~~strike~~`, `` `code` ``, `\|\|spoiler\|\|`, fenced code blocks (highlighted on first use), JSON pretty-printed, long keys folded, times with a zone in local time | #282 |
| Lists, quotes, headings, links | `- ` / `1. ` lists (the author's numbers, one nested level), `> ` quotes, `# ` headings, `[text](https://…)` links that show the address when the text names another host | #370 |
| Entity cards | `ghostly1` invites, group links, Nostr (npub, nprofile, note, nevent), Pubky and DID identities; checksum-valid only, 3 per message | #281 |
| Money | invoices, offers, addresses, tokens: see [WALLETS.md](WALLETS.md#money-in-messages) | #284 |
| Link previews | made by the **sender** and sent with the message (`pv`, a small JPEG); the receiver never contacts the site. Desktop fetches public addresses only; web and extension only where CORS allows. Setting: "Link previews". | #280 |
| Location cards | `geo:` URIs and Google, Apple or OpenStreetMap links with coordinates. The map loads only on "Show map". | #280 |
| Mentions | a chip with the member's current name (groups) | #279 |
| Identity shares | a small ID card in the timeline, local only ([IDENTITIES.md](IDENTITIES.md#sharing-in-a-chat)) | #308 |
| Reaction chips | one per emoji under the bubble, with its count; mine marked; the names on hover or a long press | #354 |
| Reply quotes | the original's author and a line of it above the text; checked against this chat, else marked (not found here, deleted, not available) | #347 |

**Bounds** (#301): JSON at most 4 KiB and 32 levels, URIs past 4 KiB stay text, a peer's timestamp is clamped to now + 5 min, every bubble has its own error boundary (`MessageBoundary`), atoms sit in `<bdi>`, and non-ASCII links show as punycode.

## Message details

Double click, or the message's ⋮ → **Details** (#240, `src/components/MessageDetailsPanel.tsx`). On a phone, a long press opens the reaction bar with Details under it (#354). Sections cover identity, path, timing, wire, crypto and delivery, plus file, voice, payment, DHT, group or call when they apply. "Copy all as JSON". Keys are never shown.

## Files

`files/3` ([WISP 501 Chat Files](wisps/501-paired-files.md), #228, #233, `packages/core/src/chatFiles.ts`):

- Any size. Offered first, then sent in 16 KiB chunks with 1 MiB in flight, resumed from the last confirmed byte, checked against the sender's SHA-256.
- Taken without asking up to 25 MiB per file and 500 MiB per contact; past that, the receiver is asked. Offers expire after 7 days.
- Bytes stream to storage, never whole in memory: OPFS on web and extension, files on Desktop, IndexedDB as fallback.
- A transfer that has not moved for 60 s offers **Send again** (sender) or **Ask again** (receiver); both go on from what the receiver already holds. A receiver with no data for 30 s asks again by itself (#348, #352).
- A file can answer a message, with the same quote a text shows (#359).
- Older contacts: files/2, up to 100 MiB ([WISP 500](wisps/500-files.md)).

## Calls and shared services

- Audio and video calls from the header (`calls/1`, [WISP 600](wisps/600-media.md), [WISP 601](wisps/601-webrtc-media.md), #207). An audio call can turn its camera on.
- **Share screen** is a button inside the call (#253), where the screen can be captured.
- **Shared services** (`services/1`, [WISP 700](wisps/700-local-services.md), [WISP 701](wisps/701-http-services.md)): local web apps shared with one contact over the chat. Chosen from + → Shared services; the contact's apps show in a strip under the header.

## Sounds

- Settings → Notifications: the **Sounds** switch, then one switch per cue category, each with ▶ to hear it (#252, #310, `src/lib/cues.ts`):

| Category | Cues | Default |
|---|---|---|
| Payments | sent, requested, failed, test coins | on |
| Identities | added, shared with you, verified | on |
| Connection | invite used, transport change, back online | on |
| Chat | mentions, spoilers, downloads, deletions | on |
| Interface | cards, new wallets, new groups | off |

- A chat's cues are silent while that chat is muted (a mention it lets through still plays). Nothing new plays while the app is in the background.

## Groups

| | Private (`group-mesh/1`) | Community (`group-community/1`) |
|---|---|---|
| Members | up to 8 | up to 256 |
| Shape | every member linked to every other | online members elected as hubs relay |
| Admin | one, signs every change | one; keeps remove, role, rotate and link. Any member can let people in |
| Link | `group1/…`, works while the admin's app is open | `group2/…`, works while the admin is away |
| Spec | [WISP 9xx Group Mesh](wisps/9xx-group-mesh.md) | [WISP 9xx Group Community](wisps/9xx-group-community.md) |

- New group offers Community (default) or Private (`src/components/NewGroupDialog.tsx`). Negotiation: [WISP 900](wisps/900-group-sessions.md).
- The group link can be replaced or turned off by the admin. Leaving deletes the group and its history from the device; an admin hands the role on first.
- Group ⋮: Members…, Mute, Rotate keys (admin), Leave group, Delete from this device.
- In a community, the admin's changes are final: a member's longer branch cannot undo them (#300).
