# Changelog

## Unreleased

<!-- Notes for the next release. A new entry goes in docs/changelog/unreleased/ (one file per change, see docs/changelog/unreleased/README.md), not here: tools/scripts/bump-version.mjs adds those files below at release and turns this heading into the version. Editing a line already here is fine. -->

## 1.0.0

Ghostly 1.0. One kind of chat: it finds your contact on the DHT and goes peer to peer by itself. A wallet for every rail, on Mainnet and Testnet side by side. Identities you prove to one contact at a time, groups, and a headless CLI for bots. Chats with 0.4 contacts keep working as compatibility chats.

### For users

**Chat**

- One invite: a `ghostly1…` code, a link or a QR. A chat with no direct path starts on the DHT and goes live over WebRTC, Iroh or HyperDHT by itself; if the live link drops, short texts go over the DHT. Choose a transport, or DHT only, per chat.
- Reply to a message, edit a text you sent, react with an emoji, and see when your contact is typing or recording (you can turn that off).
- Delivery marks beside the time: a clock, one tick, two ticks, or a red mark you press to send again.
- Rich text with lists, quotes, headings and links. Cards for invites, payment codes, Nostr keys and identities. Link previews made by the sender. A check before a seed or a private key goes out as text.
- Voice messages: hold to record, or lock, pause and discard. Play at 1.5× or 2×. Download, also as MP3.
- Files of any size, resumed where they stopped and checked on arrival. Videos and audio files play inside the chat. Paste a screenshot or drop files into the chat. A stuck transfer can be sent again or asked for again.
- Messages held for a contact who is away, in your own S3 bucket (experimental; both of you turn it on).
- Pin or mute a chat, a message's details, sounds by category.
- Click a contact's or a group's picture to see it large: in a chat's header, a contact's identities panel, a group's header and its members list. Escape or a click outside closes it. On a phone it fills the screen.
- Scrolled up in a chat, a new message no longer pulls you to the bottom: a ↓ pill counts the new ones and takes you there. End or Ctrl/Cmd+↓ jumps to the last message.
- A chat opens at its last message even after its pictures and videos load, and a chat you left scrolled up opens where you left it.
- On the desktop app, videos and audio files of any size play and seek from the stored file, so a large one no longer has to be downloaded to watch. Videos go full screen on every system; on Linux the app's own Full screen button fills the window.
- Forward a message to up to five chats and groups at once, from its ⋮ or after choosing several. Each copy says *Forwarded*, never who wrote it. Files go from the bytes already on this device; groups take texts only.
- A new message, an edit or a reaction in a long chat or group no longer makes Ghostly read and send the whole history again: the app hears only what changed. In a chat of 2000 messages the engine's work for a new message goes from about 110 ms to 1 ms, and for an edit or a reaction from about 250 ms to what storing that one row takes.
- A long chat opens faster on the web and on Desktop: keeping the chat in step with what the app received now costs one pass over its messages, not a search per message. A history of 2000 messages coming into a new device takes milliseconds instead of seconds.
- A long chat or group opens at once: its last messages show first, and the older ones come in above within about a second. Each message is drawn once, not again on every change, and costs less to draw.
- A long chat left open no longer makes WebKit, the engine of the Mac app and Safari, stall for a moment every half second.
- A long chat no longer slows the web app and Desktop down while it is open: keeping the chat list in step (on every update, and every 5 seconds) reads a chat again only when it changed, so a new message, an edit or a reaction in a chat of 2000 messages costs the page about 5 ms instead of 20, and an update with nothing new costs almost nothing.
- A scanned invite opens the chat by itself: the ghostly.tools page counts down 3 seconds, then continues to the web app, with Cancel and Open now. Choose the Ghostly app once and the page skips the countdown on that device.

**Calls**

- Voice and video calls in every chat while it is live, the Linux desktop app included. Share your screen from inside a call (not on Linux yet). Calls use your own TURN relay when you set one.
- Choose the microphone, camera and speaker in Settings → Audio & video, with a level meter, a camera preview and a test sound, or switch them during a call from its device menu. The choice is kept per profile. An unplugged device falls back to the default, and the call offers it back when it returns.
- The chosen speaker plays everything: calls, voice messages, videos, audio files and app sounds. On the Linux desktop app, calls use the chosen devices too.
- On the Linux desktop app, Settings → Audio & video tests the chosen microphone with a level meter and plays a test tone on the chosen speaker, as it does elsewhere.

**Groups**

- Private groups of up to 32 and communities of up to 256, joined by a link. Text, @mentions, replies, edits, reactions, a group picture and payments between members. No files or calls in groups yet.
- Private groups past 16 members run through hubs: the Desktop app and the command line, which stay online, pass the group's messages on, so the other members keep two connections instead of one per member. The admin can make any member a hub, or keep one from being one, in the members panel or with `ghostly group hub`.
- Reactions in large private groups reach members you have no direct connection with, signed by the member who reacted.
- The admin can rename a private group or a community, in the members panel or with `ghostly group rename`. Every member sees the new name in the chat list, the chat header and the members panel, and the group's picture stays. Members on older apps keep the name they joined with.
- Private groups show who is typing, recording a voice note or thinking: "Ana is typing…", "Ana and Bo are typing…", "3 people are typing…". It is never stored, and sending a message ends it. Communities do not show it yet.
- CLI: `group typing <group>` with `--kind`, `--status`, `--for` and `--stop`, and `group.typing.started` / `group.typing.stopped` in `listen`.
- In a private group, a message that mentions you wakes your closed web app, if you turned on "Wake me while closed": it shows "New message" and opens the group. Only a mention wakes you, never @everyone, at most once every 5 minutes, and never in a group you muted. Communities do not wake anyone yet.

**Wallets**

- Mainnet and Testnet wallets side by side, one tab per network. Real money asks before it moves; test coins only when you ask.
- Cashu, Lightning, Ark (Arkade and Bark), Spark, Fedimint, USDT and on-chain bitcoin. Several Lightning cards, each on a source you choose: the mint, NWC, LND, Core Lightning, WebLN, Breez or a Fedimint federation. Pay Lightning addresses, and pay a request from any wallet by its QR code.
- New rails are experimental and say so on their card. On-chain bitcoin on Mainnet goes through your own Bitcoin Core node on the desktop app; the BDK wallet runs on test networks only. Fedimint on Mainnet has not been tried with real funds yet.
- The web app's wallet page no longer shows the "Beta" notice. Each Cashu wallet still says to keep pocket money only.

**Identities**

- Prove a Nostr, Pubky or Bluesky account, a domain, an OpenPGP or SSH key, a Bitcoin address or a DID, once per profile. Share it with one contact at a time; their app checks it and shows its public profile.
- Every profile has a did:dht of its own.

**Everywhere**

- Local profiles on the web app, the desktop app and the extension. Backups to a file or to S3, restored as a new profile.
- Shorter settings, with details behind ⓘ.
- The profile switcher shows **New** for another unlocked profile that has a message waiting, community groups included, without switching to it. Settings → Profile → **Check other profiles** (on by default on the desktop app), with an optional notification.
- The site has Terms of Service at ghostly.tools/terms, and the Privacy Policy now covers the sites too: they set no cookies and run no analytics.
- **Wake me while closed** (web app, Settings → Notifications; on iPhone and iPad, the app added to the Home Screen): while your web app is closed, a contact's message wakes it with a notice that says only "New message", and their call shows "Incoming call" and rings once you open the app. The push is sent by the contact's own app, not by a Ghostly server, and a muted chat never wakes you.
- The web app installs as an app (Settings → Install, or Add to Home Screen on iPhone and iPad). Installed, it opens offline with your chats, takes text and files shared from other apps, opens `web+ghostly:` links, and shows unread messages on its icon.

### For developers

- **WISPs** (Wire Interoperability Specification Proposals). 53 Draft contracts in [docs/wisps](docs/wisps/README.md); the site's WISPs page (ghostly.tools/wisps) and roadmap are generated from them. New since 0.4: one chat (400 to 403), the `ghostly1` invite (801), `files/3` (501), groups (900, group mesh, group community), store-and-forward (4xx), identity proofs (300 and its providers), the headless runtime (11xx).
- **Session capabilities.** `calls/1`, `services/1`, `files/3`, `typing/1`, `react/1`, `edit/1` and `wake/1`, announced after the handshake. A capability is on only while both sides list it; older apps ignore what they do not know.
- **Headless CLI.** `ghostly` ([docs/CLI.md](docs/CLI.md), `packages/cli`) runs the app's engine on Node for bots: a daemon, a socket API, JSON events and hooks. Chats, groups, files and voice notes, wallets, identity proofs, shared web apps, and voice calls with the audio on a Unix socket; a bot can say what it is doing (`typing --kind thinking --status …`). On npm as `@ghostlytools/cli`: `npm install -g @ghostlytools/cli`.
- **The Rust `ghostly-cli`** is now the compatibility client for bots on v0.4 chats, built from `cli/` (no longer a release download). New bots use `ghostly`.
- **Tests.** A feature map (`e2e/features.json`, [docs/TESTING.md](docs/TESTING.md)), Desktop e2e on Linux and macOS, and a two-peer CLI suite.
- **Agent connector (experimental).** `ghostly listen --turns` gives an AI agent one `agent.turn` event per message to answer, the contact's words kept apart as untrusted data, and `--from` and `--group` are an allowlist checked before anything wakes. An example runs Claude Code on it: `packages/cli/examples/claude-code-agent.sh`.
- **CLI.** `ghostly` reads and publishes on the Mainline DHT beside the Pkarr relays (`GHOSTLY_DHT=0` turns it off), so bots still find their contacts while the relays fail. Fedimint wallets now run on Node too.
- **The CLI's npm package is `@ghostlytools/cli`.** Starting with 1.0, each published release puts it on npm (`npm install -g @ghostlytools/cli`, the `ghostly` command), with provenance, from `.github/workflows/npm-publish.yml`. The workspace was `@ghostly/cli`: `npm run build -w @ghostlytools/cli` now.
- The end-to-end stack's Anvil keeps only recent chain states, so it no longer outgrows its memory when the stack stays up for days, and it restarts if it stops.
- **A long chat's history reads one page at a time.** The engine keeps each chat's messages in time order in storage and reads only the page asked for: `messagePage` (the newest 50, or those before a message) costs the same in a chat of 2000 messages as in one of 50. `ghostly chat history` and `ghostly group history` use it, so their first page no longer reads the whole chat (about 5 ms instead of 120 to 160 ms for 2000 messages).
- **The SDK's package is `@ghostlytools/sdk`**: an adapter registers as a plugin ([docs/SDK.md](docs/SDK.md)). It is in the same npm organization as `@ghostlytools/cli`. It is still packed from a checkout and not on npm. The workspace was `@ghostly/sdk`: `npm run build -w @ghostlytools/sdk` now, and adapters import `@ghostlytools/sdk`, `@ghostlytools/sdk/fakes`, `@ghostlytools/sdk/testing` and `@ghostlytools/sdk/core`.

### Fixed

**Everywhere**

- The account bar under the chat list shows its labels again when they fit. A long profile name no longer hides all five: it ends in "…", and its tooltip has it whole.
- A `ghostly daemon` whose terminal or SSH session closes now stops cleanly, as on Ctrl-C: contacts hear it go at once, and its socket and profile are freed.
- A second person joining a community right after another is let in within seconds again: the door reads its knock bell at its usual pace while the first person's connections are being set up.
- On the desktop app, links in messages, and every other link to a website, open in the system browser. Before, a click on one did nothing on a Mac.
- A text too long for a compatibility chat's DHT is refused with the reason, even in the first moments after the chat is added, instead of "You are offline" and a bubble that never left.
- No more message sounds with no new message. A private group wrote its "is now the admin" or "Keys rotated" line again, and played a message sound, each time a member's name reached it or its connection to a member came back. It writes each line once now.
- Only a new message at the end of a chat plays the message sound and shows a notification. Lines of a group's history (someone joined, left, renamed it), a late catch-up of older messages, and an empty text stay quiet. So do typing and a bot's status, edits, reactions and receipts, as before.
- Messages from one chat that come together play one sound, not one each.
- A contact who comes back to a chat you also share groups with is heard in seconds, not half a minute later: a chat waiting for its contact keeps its share of the relays' requests before the groups spend it all.
- A new group connection next to a community group opens in seconds on one relay: the community's background lookups wait while a connection is being set up.
- An offer or answer the relays' request limit held back is still read within seconds once it goes out, not at the next slow check 30 s later.

**Chat**

- A long chat stays on its last message while you type. Typing a message of several lines, or one from a saved draft, no longer leaves the chat a little short of the end.
- A link preview keeps the size of its picture before the picture loads, so the chat does not move when it shows.
- Scrolled up in a group, older messages that arrive late (after a reconnect) are no longer counted as new, and the ↓ pill still takes you to the first message you have not seen.
- A chat you left scrolled up opens exactly on the message you left, even when its newest bubbles are still sliding in.
- Switching chats no longer waits behind a long chat. Leaving a long chat that was still drawing its older messages took over a second on a slower computer, and now costs what leaving a short one does. Voice notes, videos and files are also no longer redrawn on every background update.
- Typing in a long chat no longer lags on the Mac app and in Safari. Each keystroke used to make the page lay the whole chat out again, so a chat of 600 messages took twice as long per key as a short one. Now a key costs the same in both.
- A new chat says "Discovery unavailable" again when the relays fail to read it. Since the community join fix, the app answered a failed read with the invite it had just published, so the chat kept waiting for the contact with no sign of the outage.
- A chat asked for again while it is still being added, such as by the automatic "joined" message, waits for it: the same chat, ready to send, never "You are offline" for that moment.
- A chat is live again within seconds after the contact's app restarts, instead of a minute or more on the DHT.
- When the relays fail and come back, chats and group connections return within seconds, without restarting the app. The desktop app asks a relay it left alone again every 15 seconds, and at once on a new network.
- Sending a message no longer flashes a scrollbar in the chat, and on the Mac app a long chat no longer jumps a little as the new message slides in.
- On the Mac app, a voice message or a small file no longer ends up "Not sent" with nothing to send again. WebKit lost a stored file's bytes when the app saved the transfer's progress over it. Now the progress is kept apart and the file is written once. A voice message that lost its bytes before this version cannot be brought back.
- A voice message recorded while replying goes as a reply, with the quote above it on both sides. So does a file, a pasted picture or a camera photo sent while replying. Of several files sent at once, the first carries the reply, and a caption after them does not quote it again.

**Groups**

- Joining a community right after someone else no longer waits up to 17 seconds: while the relays' budget was spent, the member's app read an old copy of its own entry in the community's beacon and stopped answering knocks until it wrote the entry again.
- In a large group with a Mac past its budget of connections, the members it has no connection with get its messages within about three minutes, where some took five or more.
- Names no longer flicker when a member's connection drops. A private group keeps a member's name while their connection is down, and only the member can change or remove it.
- A group you left scrolled up opens on that message again when you come to it from another group. It used to open at the bottom and forget where you were.
- On a Mac, being a hub of a community no longer uses up the connections the Desktop app can open. A Mac hub takes only as many members as its 40 connections leave beside its other groups and 1:1 chats, and says it is full past that, so new members go to another hub.
- On a Mac, large groups no longer use up the connections the Desktop app can open, which kept calls from connecting. The app's groups hold at most 40: past that it stops being a hub of a group and opens only the connections that matter most.

### Security

**Everywhere**

- The Claude Code agent example (`packages/cli/examples/claude-code-agent.sh`) answers each turn with no tools, no MCP servers and none of your Claude Code settings, so a contact's message can shape an answer but cannot get the agent to read a file or run a command. It keeps its conversations in `~/.local/state/ghostly-agent`, outside `~/.ghostly`, one per chat and one per member in a group, and it now also runs on macOS's own bash.
- The agents guide, the agent skill and the prompt on /developers/agents spell out the safe setup: allowlist only the owner, never a group or a community for an agent that has tools, and answer turns with a model call that has no tools.
- CLI: a contact's app opened with `service open` has a host name of its own (`http://<random>.localhost:<port>/`), so its cookies and storage are apart from every other app on this machine. The `url` it prints is a link for your browser: only a browser that followed it is served. Safari on macOS may not reach `*.localhost` names by itself; use Chrome or Edge, or add the name to `/etc/hosts`.
- CLI: an opened service whose answer is cut short (too large, or the contact dropped it) ends that response; it no longer stops the daemon. A daemon now logs an error nobody caught and keeps serving.
- CLI: the daemon makes the profile folder owner-only again before its socket is made in it.
- CLI: `listen` passes an event whose hook, output or cursor step fails, and goes on with the next.
- Received files never get a Windows device name (`CON`, `NUL`, `COM1.txt`...): such a name gets a `_` in front.
- CLI: a `chat.created` event no longer carries the new chat's invite code, so a hook or bridge on `ghostly listen` never sees it (`invite create` and `chat show` still give it to you).
- CLI: a contact's app opened with `service open` gets only the cookies it set itself; cookies other apps on this machine keep for 127.0.0.1 or localhost stay here.
- The command line never takes a name a contact gave itself for someone else: a contact key finds only that contact's chat, a chat's own label wins over a contact's name, and `listen --from <key>` keeps the key. This holds for `listen`, `call auto`, `pay` and every command that names a chat.
- When a profile's path is too long for its daemon socket, the socket goes in a folder of the user's alone, and commands connect only to a socket of the user's.
- Hooks run without the backup passphrase in their environment, `settings` hides the wake-up push subscription, and an opened shared app answers only at 127.0.0.1 or localhost.
- On the command line, `wallet redeem` reads the Cashu token from stdin when none is given, and `wallet create --stdin` takes secret fields and the API key as `name=value` lines, so they never show in `ps` to other users of the machine or in the shell's history. A token or API key still given as an argument works, with a warning.
- On Linux, Desktop keeps the files of chats in folders only you can open, and its log readable by you alone, even where other users of the computer can enter home folders.
- A file you save from a chat in Ghostly Desktop is marked as downloaded from the internet, on macOS and on Windows, so the system checks it (Gatekeeper, SmartScreen) before it opens or runs.
- A window showing a contact's shared app stays on that app: it cannot go to another website or to Ghostly's own pages.
- After you say "Don't allow" to sharing a local app three times, Desktop asks no more until it restarts.
- Link previews refuse a few more address ranges that lead into local networks (6to4, Teredo and site-local IPv6), and requests to the local apps you share never go through a proxy.
- On Linux, Desktop's local server for playing videos and voice notes serves at most 32 connections at once, so connections other programs leave open cannot pile up without end.
- Desktop opens a provider's sign-in page in the browser exactly as it checked it, without spaces or hidden characters the address may have carried.
- The browser extension uses Chrome's debugger only on the tabs it opens for a contact's app, and only for the few commands those tabs need. Anything else is refused.
- A contact's shared app, opened in the extension or on Desktop, can only send real response headers: one whose value holds a line break, or whose name is not a header name, is dropped, and each cookie stays on the app's own address.
- The extension's background peer answers only the extension's own pages, like its service worker already did.
- Web app: the "Share to…" picker says the share came from another app or website, never picks a chat for you, and a share larger than 64 MiB is dropped before it is read.
- Web app: a contact whose app sends too many wake-ups cannot fill your screen. Each shows at most one "Incoming call" every 30 seconds and one "New message" every 5 minutes, whatever its app does.
- ghostly.tools and app.ghostly.tools tell browsers to use HTTPS only (Strict-Transport-Security), from the next deploy.
- Desktop: a link that a contact's shared app opens in a new tab now opens in your browser, as links in chats do. The app's own window still never leaves the app.
- Ghostly Desktop reaches only the local apps you share. When you share one, the app asks in a system dialog that names the address (like `localhost:3000`), and it reaches no other port on your computer. An app you shared before this version asks once, the first time a contact opens it.
- On Desktop, a paste brings only the files the clipboard lists as files: text that names files is text.
- A discovery record dated far in the future no longer hides the records published after it: one dated now or before wins over it when read.
- The reference push relay refuses a request that names a header twice in two spellings, so the signature it checks is the only one the push service gets.
- The reference push relay counts an IPv6 client by its /64, and a full table of counts forgets the client seen longest ago instead of turning every newcomer away. Behind proxies it listens on 127.0.0.1 by default, so only the proxy can set the client's address.
- The reference push relay closes a client that takes more than 15 seconds to send its request, and weighs a request in bytes, so a large one is refused before it is read.
- **The Rust `ghostly-cli` binaries are no longer release downloads.** It takes a seed and a key on the command line, where other programs on the machine can read them. The CLI to use is `ghostly` (`packages/cli`). Bots still on the Rust client build it from `cli/` in the repository.
- A deleted or muted contact can no longer wake your closed web app: the app replaces its push subscription, and your other contacts get the new one.

**Chat**

- A contact can no longer edit a message into a "👋 … joined" line, which the chat shows as its own and takes the
  contact's name from. Such an edit is ignored, and this app does not send one.
- A message made of a long run of web addresses no longer slows the chat down while the app looks for invite and group links in it.
- A file taken without asking that is offered again after it ended counts against the contact's limit again: past 500 MiB it waits for you, as a new one does.
- A file offered under the id of a message the contact already sent is refused, and an edit that arrives while the chat is not live is never blank.
- A file that arrives at the same moment as another file or message now gets a message of its own, instead of leaving its bytes stored with nothing in the chat to show or delete them. A file sent again after its transfer failed lands in the message it had.
- A pinned message can no longer be locked in place. A pin whose number is far ahead of the clock is refused, one
  kept before this version is replaced by the next pin or unpin, and in a private group a pin goes away when the
  member who made it is removed.
- A wake-up push goes only to the browsers' push services (Google, Apple, Mozilla, Microsoft), from every app, and the command line reaches them on public addresses only. The reference push relay forwards only signed Web Push requests, and counts each client apart behind a proxy.
- Styles in a message nest at most 8 deep, and a link's text that hides a soft hyphen or a look-alike dot shows the link's address instead.
- A connection that reaches your app on a direct transport and does not prove it is your contact within 15 seconds is closed, and can no longer keep your contact out when their app restarts.
- A contact's link to web.archive.org shows by itself only when it is a GIF from the archive, as the Retro GIF picker
  sends them. Any other link there waits for "Show picture", as links elsewhere do.

**Groups**

- A group's name in an invitation shows cleaned, as a renamed group's does: line breaks become spaces, and invisible
  or direction-changing characters are dropped.
- An admin who hands the group over can no longer leave the next admin unable to rename it or change its picture.
- In a private group, a copy of a message handed on without its author's full signature still waits for the author's own copy after the app restarts, so the message's mentions and reply still arrive.
- In a private group, a copy of a message another member hands on without its author's full signature no longer takes the message's place: its text shows, and the author's own copy still brings its mentions and reply.
- A member answers another member's catch-up requests a few times a minute at most, in private groups and communities.
- In a large private group, a member you shared your wake-up address with before the group moved to hubs can no longer reach it once removed: removing them, leaving the group or muting it now gives your app a new address.
- A member of a group can no longer hide another member's payment request by sending one of their own under the same id: both are kept, each paid and answered on its own, and a request's line in the group shows only under its own member's bubble.
- Someone removed from a community is heard no more: their messages are dropped even when another member hands them on, and catch-up no longer passes their old ones along.
- In every group, a message its author did not sign never waits in the place of one they did, and one member's reactions are taken at most 30 in 10 seconds, as in a paired chat.

**Wallets**

- A Testnet wallet pays a Bitcoin (`lnbc`) Lightning invoice only through the public test mint. A mint on this machine may have real sats behind it, so it no longer pays one as test money, and no other Testnet Lightning source does. Test-chain invoices (`lntb`, `lnbcrt`) are paid as before. The CLI declares a local test mint with a fake Lightning backend with `GHOSTLY_TEST_MINTS`.
- Creating Fedimint notes from a Mainnet federation now asks "Send real money" first, as every other spend does; the engine refuses it without that confirmation (the CLI's `--confirm-real`).

**Privacy**

- app.ghostly.tools no longer logs who visits: its server records only the time, the file and the response, with no IP
  address, browser, referrer or query string, and error lines that would name a visitor are left out. Container logs
  of the web app and the site are capped at 30 MB instead of growing forever.

### Added

**Chat**

- Search inside a chat or a group: ⋮ then Search, or Ctrl/Cmd+F. It looks through the messages and file names kept on
  this device, whatever the case and accents, shows "3 of 12" with the newest match first, and ↑ ↓ (Enter, Shift+Enter)
  go to each match.
- Pin a message in a chat or a group from its ⋮: a bar at the top shows it to everyone in the chat, and a click goes
  to it. One pinned message per chat; a new pin replaces it. In a private group any member pins, in a community only
  the admin. The CLI has `ghostly pin <chat|group> <message> [--remove]` and `chat.pinned` / `group.pinned` events.

## 0.4.0

From here on Ghostly tells you when there is a new version, and installs it where it can — so this is the last one you have to go and fetch yourself. Calls gained video and screen sharing without calling again, and any single message can now be deleted from this device. Nothing changes on the wire: older clients keep working, they just cannot turn their camera on mid-call until they update.

### Added

- **Updates.** Every client now says when a new version is out, and puts it in place where it can. The desktop app downloads it, checks our signature and restarts into it; on the web it is a reload; the extension points you at the download until it is in a store. Nothing happens by itself — updating ends your calls, so it waits for you. The check can be turned off in **Settings → Updates**.
- **Calls.** A voice call can turn into a video call, and share a screen, without calling again. The camera and screen buttons are there during any call now: press one and the other side sees it, with nothing to accept and no second ring. Stopping a screen share goes back to what you had before it, your camera or just your voice. Every call carries an empty video section for this, so a peer on an older version still rings, still talks and still sees your picture when you turn it on — it just cannot turn its own on until it updates.
- **Deleting a message.** Any message in a chat — a picture, a file, a text, a call or a payment — can now be deleted on its own, from the bin next to it. It is gone from this device: the message, and the bytes of whatever file it carried. Nothing is asked of your contact, who keeps their copy, and a message deleted here does not come back when they republish it.

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
