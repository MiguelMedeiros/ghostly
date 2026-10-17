# Changelog

## Unreleased

<!-- Notes for the next release. A new entry goes in docs/changelog/unreleased/ (one file per change, see docs/changelog/unreleased/README.md), not here: tools/scripts/bump-version.mjs adds those files below at release and turns this heading into the version. Editing a line already here is fine. -->

## 1.3.7

### Security

- Chats: a voice message or an audio file playing shows on the lock screen and in the system's media controls as "Voice message" or "Audio" from Ghostly, like every notice, no longer with the contact's name or the file's name. Locking the app pauses what plays, and the system's controls let go of it.
- Groups: a member that says it holds a group file it does not hold can no longer keep another member's download from finishing.
- Groups: a member can no longer make a payment request or payment appear in another member's name.
- Shared web apps: a contact can no longer reach paths outside the shared one on servers that ignore `;` parameters or decode twice.
- Desktop: a contact can no longer stop HyperDHT in every chat at once with one message made of control characters.
- Desktop: a video or audio file played before a reload or a profile switch is no longer served under the link the page before got: a new page starts with none, and a file plays again only by a link that page asks for.
- Desktop on Windows: a contact's app can no longer open browser tabs to your computer or local network, and opens at most 20 links per window.
- CLI: a Cashu request can no longer be paid twice by `chat pay-request` and then approving a review made before it.
- Wallet: test sats received as Fedimint notes are no longer reported as a Mainnet payment by `ghostly payment list` and the `payment.created` and `payment.updated` events.
- Merge train: only the train's own comment that starts with its position mark counts as a pull request's position comment, and file names in its drop comment are escaped, so a workflow file's name can no longer make the train take a later, unreviewed head.

## 1.3.6

### Security

- Chats: a file larger than 25 MiB from a contact is always asked about before it is stored, whatever the contact's app. A modified app that left out the newer file transfer could have files up to 100 MiB stored without the question.

### Fixed

**Apps**

- An app card from a contact with no name says "Contact · 1kwb54 opened it here", and its install screen "Sent by Contact · 1kwb54", as the chat calls them, instead of "Anonymous".
- Apps → Add: a link corrected while Check runs no longer gets the old link's answer. Before, the old link's store showed under the new link and Add store added the old store (or the old link's install screen opened).

**Everywhere**

- A private group member whose network lets no direct connection through (a VPN, a firewall that drops UDP) reaches the other members over Iroh's relay a few seconds after a connection to them fails, as its 1:1 chats do. Before, each connection to a member waited for WebRTC to give up first, 15 seconds to a minute and a half, so a member who turned a VPN on had its group messages held all that while.

**Chat**

- Joining with an invite someone else used first, the pairing says "Ask your contact for a new one" once, not a second time on the line under it.
- A press on a bot's buttons with no `once` button among them no longer reads the chat's whole history: it costs what a plain reply does, however long the chat (a full read is about 100 ms at 10,000 messages on the CLI daemon). Pressing a contact's buttons already worked this way.

### For developers

- The website's Docker image builds again from a clean cache. Its lockfile kept a package (`@napi-rs/wasm-runtime` 1.2.0) whose peers nothing in it met, so `npm ci` on Node 26 asked the registry to settle them and stopped on "Missing: @emnapi/core@ from lock file" when that answer did not come. A test now runs the site's `npm ci` offline, which passes only when the lockfile settles everything by itself.

## 1.3.5

### Fixed

**Devices**

- Add a device: once a refused password is typed again, or the next step comes, the card that said why goes too. It no longer says "Use 8 characters or more." over the code's "Waiting for your other device" on a phone.

**Apps**

- Opening an app's install screen again while it is still downloading waits for that download instead of starting a second one on the same connection, and a store whose signature file cannot be read stops downloading its list at once.
- Opening the Apps page no longer downloads every store's whole list of apps, and each app's revocation list, again when they have not changed: the browser asks the host whether they changed and gets an empty answer when they have not. A changed list still arrives at once.
- Adding a store from Apps → Add no longer downloads and checks its whole list of apps a second time when you press Add store: it takes the list the preview just read, so on a slow connection you wait for it only once.

**CLI**

- A message whose first word is a dash and one character, such as `send bob -1` or `send bob -5 degrees`, is still refused but now says to put `--` before text that starts with a dash, as longer words like `-ph` already did.

**Everywhere**

- A profile on several devices no longer reads a device that is away (a phone closed for the day) every 4 seconds for the first ten minutes after each start. That took half of a relay's minute per away device while your chats were reconnecting. Its link is now read every 30 seconds from the start, the same as after those ten minutes: 150 reads in that window went down to 20. A device that comes back is still connected within a minute.
- On a phone on its side or in a short window, a menu with no room above or below its button stays on the screen and scrolls: a chat's ⋮ menu ran off the bottom edge, Delete chat half cut.

**Groups**

- In a group, members who have been away for a while are no longer looked for every 4 seconds for the first ten minutes after each start, as if they had just been invited. With 16 members of a 32-member group away, that asked the relays for about 240 requests a minute while your chats were reconnecting. They are now read at the group's slower pace from the start, the same as after those ten minutes: about 18 a minute. A member who was just added is still looked for quickly.
- A group's file you fetch from a member with a slow upload (a phone on mobile data) now moves to the author or another member as soon as one says it is free, going on from what already came. It used to stay with the slow member for the whole file: up to a minute or two for a file the rest of the group had in seconds.
- A private group past 16 members no longer says each member is a direct link from your app: its connection details say your app links to the admin and the group's hubs, which pass messages on and see who talks when, not what is said. New group says members connect directly only up to 16, and the joined line no longer says messages go directly.

**Chat**

- A long chat whose recent messages carry link previews or many edits (a news bot's, an agent's progress messages) no longer slows down every message that arrives. The copy of a chat the page keeps for its first moment now stays as small as any chat's; the previews and edits still come back from the chat's full history.

**Wallets**

- An ecash token card whose token was already spent reads Redeemed when you tap Redeem, instead of showing the mint's "already spent" error. After the update to 1.3.3, tokens you had redeemed on 1.3.2 offered Redeem again, and Redeem then failed with that error.

**Website**

- The apps pages no longer download each app's icon at the size its publisher made it (up to 1024 px and 256 KB) to draw it at 56 px. The site now serves it at the size the page draws it for your screen, about 1 or 2 KB per app, and the cards on the apps list load their icons only as they come near the screen.
- On a tablet in landscape, a reader who scrolls past a chapter's last step before the home page has finished loading keeps that step on screen, its title where it was, instead of landing on its picture with the title gone.

## 1.3.4

### Security

- Chats: in a chat where both apps send files the newer way, a file sent the old way is refused, so a contact can no longer skip the question asked above 25 MiB or the check for free space.
- Desktop: a contact's web app window closes when the Ghostly page starts again (a profile switch or a reload) and when the profile locks, and the page no longer answers it.
- Desktop: the updater is built without the archive extractor it never needed (updates are installers, AppImages and macOS archives), which removes the `zip` crate and its known flaws (RUSTSEC-2026-0367, RUSTSEC-2026-0368, RUSTSEC-2026-0369).
- CLI: `ghostly engine sendMessage`, `sendGroupMessage`, `editMessage` and `forwardMessages` refuse a text that looks like a recovery phrase, a private key or a Cashu token, as `send` does, unless given `--force`.
- Releases: the merge train holds a run when another pull request from the same branch has more events, or the branch more pull requests, than it reads.

### Fixed

**Identities**

- A click on Load profile, Load follows or Load notes on a contact's Nostr card no longer does nothing when it lands while the card is still turning over: the buttons wait for the turn to end, as Check again does.
- Loading a Nostr profile, follow list or notes checks each event's signature once, not once for every relay that sends it: with eight relays, Load notes did eight times the work.

### For developers

- CLI: `engine.call` refuses (`confirm`) `sendMessage`, `sendGroupMessage`, `editMessage` and `forwardMessages` with secret-looking text unless the request says `"force": true` (`ghostly engine … --force`).
- Desktop updates: `latest.json` points only at what the updater installs as it is (the macOS `.app.tar.gz`, the AppImage, the Windows `-setup.exe` or `.msi`), never at a zipped archive.

## 1.3.3

### Security

- Chats: a contact's name and picture changes, its message-edit switch, its held-messages notices and its identity proofs are all paced, and identity proofs kept per chat are bounded, so a contact can no longer make your app write, re-read the chat or query the relays without end. An identity request for a kind the app does not verify is answered without writing to the chat or playing a sound. A web address with a user name before its host now shows the host it really opens.
- Chats and payments: a token or invoice card says Redeemed or Paid only for that whole token or invoice. Fedimint notes are recognised by their content whatever their spelling, and Cashu ecash sent again under another payment while its first redeem waited on the mint settles only the payment it was written down with.
- Private groups and group files: a holder's serving place is kept only while the file moves, a member that serves a file far too slowly or answers "busy" no longer keeps it from coming from another member, and Resume asks another holder first. A group request paid over Lightning no longer names a member who paid nothing as its payer. A picture in a chat or group is drawn only when its own bytes give a size the app can draw, so a tiny file can no longer take gigabytes of memory.
- Mini-apps: an app window closes when the Ghostly page loads again and when the profile locks, a contact's web app keeps a separate storage per profile that Clear all data and deleting the profile remove, and on Desktop an app window gets its answers and events as JSON text.
- CLI: deleting a message, a chat or a group also takes its texts out of the event journal, and join links and invites can be given on stdin, with a warning when a secret wallet field is given on the command line.
- HyperDHT relay: a client behind a proxy is counted by the address the proxy saw, and a slot a client holds without using it is freed.
- Releases: the merge train reads a pull request's base changes, other pull requests from its branch, its head push time and long comment lists more strictly, and the security autorelease gate refuses lock entries outside a package's exact registry address and changes to binary files.

### Fixed

**Apps**

- On an iPhone, Apps → Add stands on the keyboard: its link field and Check were under it.
- On a slow connection an app, a store or a revocation list that is still downloading now finishes instead of being dropped after 30 seconds. A read that stalls says it took too long on this connection, not that the host could not be reached.

**CLI**

- `ghostly app verify` and `ghostly app serve` refuse a version its publisher revoked in the `ghostly-revoke.json` beside the bundle (beside the file, or beside the URL as a client reads it), with the reason `revoked` and the publisher's words. Before, they took it as valid, though a client stops it.
- `ghostly app publish --out ""`, `app revoke --bundle ""` and `store sign --out ""` (an unset variable in a script) are a usage error, "A path given as \"\" names no file", instead of naming the current folder.
- The README that `ghostly app init` writes installs `@ghostlytools/sdk` in the folder above the app's (`npm install --save-dev --prefix ..`), so its next step, `ghostly app publish .`, no longer meets `node_modules` (refused as too many files) or bundles `package.json` and `package-lock.json`.
- A CLI call always ends when it is hung up, even when its audio codec fails as it closes: the contact is told, the program reads the end of its audio, `call.ended` goes out and the connection closes. Before, such a failure stopped the end halfway and the call stayed open on both sides.
- A CLI daemon in three or more calls at once keeps every call's audio intact. Before, as calls ended and others started, one call's audio could be written over another's codec: that call turned to noise, answers and hang-ups failed with "memory access out of bounds", and after a few rounds no call worked until the daemon restarted.
- `--json <file>` of `ghostly task send`, `routine send` and `usage send` (and their updates) with a file that is not there now answers `not_found` (exit 3, "No such file or folder: <path>"), with a folder `bad_request` ("<path> is a folder: name a file"), and `--json ""` is refused as naming no file. Before, a usage error with Node's own text (a folder's named no path), and `""` read the current folder.
- `chat accept <chat> <method> --networks ""` (or `","`) is now refused like an unknown network, and says to use `--off` to stop taking the method. It exited 0 and left the method on no network while `methods` still said it was on.
- A chat's name given to `ghostly chat rename`, `invite create --label` or `invite join --label` is refused with the rule (`bad_request`, "A chat's name is up to 48 characters on one line"), before any invite is made, instead of being cut at 48 without a word. A cut through an emoji left half of it in the name, and a newline or a tab was kept.
- `""` given where a chat or a group is named (an unset variable in a script) names nothing: `forward … --to ""` and `call auto on --from ""` are a usage error before the profile opens (`--to "" names no chat or group`, exit 2), and so is `--to "group:"`. `""` was a prefix of every id: with one chat it forwarded to that chat or put it on auto-answer, and `--to "group:"` forwarded a chat's message into the only group. A daemon's API callers get `bad_request` for the same.
- An empty choice, such as an unset variable in a script, is now refused, naming the choices: `wallet remove ""`, `wallet create ""`, `chat accept <chat> "" --off`, `--wait ""`, `--kind ""` and the rest. It was read as the default and acted on: `wallet remove ""` aimed at the Cashu wallet, and `chat accept <chat> "" --off` turned Cashu off for the chat.
- A number option given as `""`, such as an unset variable in a script, is now refused as `--left abc` is: `--left takes a number, not ""`. It was read as 0 and acted on: `usage send --all --left ""` posted "0% left" to every chat, `task send --progress ""` a card at 0%, `listen --since "" --exec` ran the hook over every event the journal holds, and `chat disconnect --hold ""` ended the hold.
- A required argument given as `""` (an unset variable in a script) is the same usage error as one left out (`Missing <chat>: ghostly chat show <chat>`, exit 2), before the profile opens. In 63 commands it opened the profile, then answered `bad_request` with the engine's parameter name (`chat is required`, exit 1). A path given as `""` names no file: `profile picture ""` read the current folder. `chat rename <chat> ""` still gives the chat back the contact's name.
- A group command that names the profile itself (its own key or a prefix of it) in `group remove`, `group admin`, `group hub` or `--mention` now says `"<key>" is you: name another member of <group>` (bad_request). It answered not_found "No member <key> in <group>", as if the profile were not in the group.
- `ghostly identity add domain` without a subject now says "Domain takes a subject, its domain (example.com): ghostly identity add domain <subject>", in each provider's own words. It answered "subject is required", the API's parameter name.
- `ghostly listen` now refuses an empty `--webhook`, `--exec`, `--cursor`, `--from` or `--group`, such as a unit file's `--webhook "$URL"` with the variable unset, before the profile opens. An empty `--webhook`, `--exec` or `--cursor` ran a plain listen without a word: no hook, no POST, no cursor kept. An empty `--from` or `--group` failed later as "chat is required".
- A missing argument's usage error names it as the usage line next to it shows it: `ghostly chat pay bob` says `Missing <sats>`, not `Missing <amount>`, and `ghostly service add web` says `Missing <http://127.0.0.1:port>`, not `Missing <target>`. Commands that take a chat or a group say `Missing <chat|group>`.
- `profile backup`, `profile restore`, `profile picture`, `group picture` and `identity complete` now name the files they read as every other command does. A `--passphrase-file` or `--evidence-file` that is a folder says "<path> is a folder: name a file" (it said "the path"), `--passphrase-file ""` and `backup --out ""` (an unset variable) are refused as naming no file (they said "No such file or folder: " and "<current folder> exists"), an empty passphrase file says it is empty instead of asking for the --passphrase-file that was given, and a picture that is a folder or not readable is named as such, not "No file".
- `ghostly profile` and `ghostly settings`, alone or with a word they do not take, and `ghostly daemon frob`, now answer as every other group: "ghostly profile takes a command: create, list, ... (ghostly help profile)" and "Unknown command: settings frob: ghostly settings takes get or set (ghostly help settings)". `ghostly help chat histroy` (a word the group does not take) is now the same usage error as `ghostly chat histroy`, where it printed the chat group's list with exit 0.
- `store sign` with a `--key` file that is not there no longer makes a new store key over a folder that holds an index signed by another key: it answers `not_found` naming that key, and a key that is there but is not that one is `refused` (`store-key`), as `app publish` does. Another store is another `--out`.
- `usage send --all` checks `--wait` and `--timeout` once, before any chat, and refuses a wrong one with `bad_request` (exit 1) as `usage send <chat>` does. When no chat takes the card, the command now fails (exit 1) instead of exiting 0, and each chat's refusal carries its `code` and `message` like every other error. Before, a wrong `--wait` or `--timeout` came back once per chat as plain text, and the run still exited 0.
- `ghostly send`, `edit`, `group send` and `group edit` with an empty text argument (`send bob ""`) answer "No text" when stdin is a pipe or a file. Before, they read stdin as the text, so in `while read line; do ghostly send bob "$line"; done < file` an empty line sent the rest of the file as one message and ended the loop. Stdin is read only when no text is given at all, or with `--stdin`.

**Everywhere**

- Each message that arrives no longer rewrites a 29 KB list in the browser's storage. The app claimed every sound and notification by writing back the last 256 message ids each time: a busy group of 10,000 messages wrote about 290 million characters, and each write also reached every other open page. A claim is now a few dozen characters, kept for 10 seconds.
- With the app open in several tabs or windows, the chat list no longer redraws whenever another one saves something it does not show (such as when a group was last read); only a change to folders, mutes or how a contact is shown redraws it.
- As the app starts, the chat list no longer jumps down a second later when the groups and the Tasks entry come in: it is drawn once, with them, so a click aimed at a chat opens that chat.
- CLI: `ghostly app revoke --up-to N` with N past the bundle's own sequence (a typo, 30 for 3) is now a usage error naming the newest version, unless `--force`. `ghostly app publish` refuses a sequence that the folder's `ghostly-revoke.json` already revokes (`details.reason` `revoked`) and names the `--sequence` that clears it. Before, both went through without a word, and clients that read the revocation stopped the new version for good.
- CLI: a second `events.subscribe` on a daemon socket connection that is subscribed already is refused (`bad_request`). Before, every later event came once per subscribe, and each replay got past the connection's 8 MiB bound for unread data.
- CLI: a `ghostly listen` paused with Ctrl+Z, or any client of the daemon's socket that stops reading, no longer makes the daemon keep every later event in memory until it reads again. Past 8 MiB unread the daemon ends that connection, and `listen` picks up again after the last event it took.
- Closing the Ghostly window on Linux or Windows makes it disappear at once again. It no longer stayed on screen, still usable, for about half a second while the app said goodbye to your contacts.
- On an iPhone or iPad on its side, a dialog stands above the keyboard while it is up: New group's Create, Forward's Send and Join were under it.
- Private groups past 16 members (on hubs): a member's name now travels with its messages, so once it writes, members it holds no edge with show its name instead of "Member" and its key (in messages, the @ list, reactions and the members list). A member that has written nothing since, or whose app is from before, still shows as "Member" to them.
- On the Linux Desktop, opening Ghostly again right after closing its window opens it. For about 0.4 s after the close, while Ghostly said goodbye to your contacts, a new launch handed over to the app that was leaving and no window was left. That launch now starts once the old app has gone.
- A link to the app with a stray `%` in its address (`#/chat/%`, `#/join/%E0`) no longer shows the "Something went wrong" screen: it is read as a link the app cannot use, and the app goes on.
- The Copy button behind a notice's ⓘ is now 24 px tall, easy to tap on a phone.
- On an iPhone or iPad on its side, Apps → Add, Add identity, New wallet, Delete profile and Publish on Nostr stand above the keyboard while you type: their field and buttons were under it.
- The web and Desktop app start faster with many chats: while each chat makes its first read, the chat list and the sync find its chat by its key instead of reading every stored chat once per chat.
- Opening the app with many chats does less work while the page is still settling. Each chat's keys are worked out once per run instead of up to four times, which halves that part of the start: about 130 ms instead of 260 ms for 50 chats on a slow machine.
- Opening the app with many chats no longer freezes the page for up to most of a second right as the chat list appears. Chats now connect a few at a time, most recently used first, and the page keeps answering clicks in between.

**Calls**

- Calling back a contact whose call was just kept as missed (it came right after one that barely rang) while that call still rings on their side now rings it here, so you can answer it. Before, your call crossed theirs, each side ignored the other's, and both ended with "No answer".
- A call from a headless bot no longer ends when the bot's call library refuses the app's answer twice in a row: the app starts over on each new offer, as many times as the bot offers again.
- In Arabic (or any right-to-left language), the call screens show a contact's name in its own direction: a chat named "Ana!" rang as "!Ana" on the incoming-call card, the call window and the locked screen's ringing card. An Arabic name in the English app is fixed the same way.
- A call placed from the web app or the CLI rings about a quarter of a second sooner, and an answer from them connects as much sooner. Each waited 400 ms after finding its public address for nothing the call uses.
- A CLI call with a TURN server in its profile carries the relay's address in its offer and answer when that server is far away. The CLI waited for its public address only, so a TURN server 100 ms or more away gave its relay too late, and on networks where only the relay connects the call failed.
- A call in a current chat no longer reads the contact's record on a relay as it starts or rings, on each side. Its signals go only over the chat's live connection, so the read found nothing. Ending such a call also no longer cuts short the chat's own quick look for the contact.
- A call placed again within 2 seconds of one that rang for a while now rings. That covers a call that was cancelled (switching from voice to video, or a hang-up by mistake) and one that rang out. Before, the contact never saw it, and the caller heard "Calling…" for a minute. Only a call that barely rang still holds the next one back, so a contact calling and hanging up over and over still rings once.

**Chat**

- A chat's name longer than 48 characters is cut between whole characters, never through an emoji, and new lines or tabs in it become spaces, as in a group's name.
- When a forward reaches some chats and another refuses it, the chats that got it leave the selection and the dialog says so. Pressing Send again sent the messages a second time to the chats that already had them.
- A removed chat no longer leaves its message queue and file transfers in memory: a CLI bot that pairs with new contacts and removes their chats kept them for every chat it ever removed.
- On a phone, the voice recorder's hint ("Too short. Hold to record, release to send") wraps instead of running off the screen's edge in Spanish, French, Italian and Portuguese.
- A voice message or audio file started from the keyboard keeps the focus on its play button, so Space again pauses it instead of scrolling the chat.
- A screen reader hears "Recording" and the position in a voice message or audio file ("0:05 of 0:30") in the app's language, not in English.
- On a Linux Desktop or a CLI bot with more than eight live chats, a chat that hands its connection to another one no longer has the contact's app look it up as if it had quit. The contact read it every second or two for two minutes: about 90 lookups after each handover on the Desktop, now about 6, the pace of a chat in the background. Both apps need this version; an older contact still looks it up as before.

**Wallets**

- When a new Cashu wallet's mint does not answer, the app now says only that it could not reach it. Before, it also said "Check the address: it should be a Cashu mint", though the app had chosen that mint and there was no address to check. A mint you add by its address still gets that advice.
- In Arabic, a wallet's balance no longer reads "100,000sats": the unit sits on the number's left with a gap, and a Testnet unit's words stay together ("sats تجريبية") instead of one of them going beside the source's name. In the Cashu, Lightning, Spark, Fedimint, Ark, Bark and on-chain wallets.
- A contact's payment memo that reads like one of the wallet's own notes ("Test coins from the test mint") is shown as written in the Cashu history, and its ecash plays the coin sound: it no longer passes for Get test coins.
- In Arabic, a pasted invoice's memo in a wallet's Send, and a Lightning address's description, read in their own order: "1 cup coffee" no longer shows its "1" before the separator. The chat's invoice card already did this.

**Files**

- A large file whose copy into the app failed (the device ran out of room, or the file changed) has the red "Not sent" mark again, instead of a tick that said "Sent" though nothing left the device. The mark does not offer to send it again: pick the file again instead.
- A large file's progress is kept as it was at a cut: the newest progress is written once its 2 s are up, and at once when the chat's connection goes. Before, only the first progress of each 2 s was written, so an app restarted soon after a cut showed the file where it stood before (a whole resumed stretch on a fast link).
- A large file that could not be sent because this device had no room for its copy keeps its red "Not sent" mark and its "Not enough space on this device" line after you reload the app. Before, the reload showed it as sent and "No longer available", though it never left the device.

**Groups**

- A long group catching up stutters less: who wrote each message is worked out about seven times faster, and only again when the messages, the names or the pictures change.
- Joining a private group by its link no longer stalls at "Let in: getting the group's keys" when the joiner or the admin is on a network that lets no direct connection through (a VPN, a firewall): the join goes on over Iroh's relay. A group's connections now recover on such a network too: when a VPN comes on with the group open, they go on over Iroh's relay as 1:1 chats do, and stay there instead of going back to direct connections that fail again. A CLI daemon's log now says each step of a join through a link (knock seen, entry session opening, welcome sent).
- The name field of New group and Rename takes a name as long as a group may have, counted in characters: a name made of emoji no longer stopped at half the length (a family emoji counted as 11), and a name too long is cut between whole emoji, never through one.
- An open group no longer writes when it was last read for every change in the group (a member coming online, a reach update), only when something new came or the page shows again, so the app's other open tabs and windows stop redrawing their chat list several times a second.
- In a private group of more than 16 members, a member removed while briefly offline now learns of it within seconds of coming back, instead of about 3 minutes later, during which its messages looked sent and reached nobody.
- Two members of a group or community who go by the same name, both picked from the @ list, are each mentioned where you picked them: the second one no longer went to the first, so they get the @, the sound and the notification. The same goes for picking the other one while editing a message.

**Website**

- On a phone, the website home no longer moves the wallet or identity panel you are reading when the page finishes loading: the room kept for each card deck is as tall as the deck a phone gets, and the page keeps its place once the decks have their size.
- The first screen of the developer page no longer keeps a phone busy while you read it. The protocol explainer's ghosts floated and blinked, and its connecting line marched, for as long as they were on screen, and the page redrew itself about 60 times a second: almost a tenth of a second of work every second on a phone, over a quarter of one on a slow phone. The ghosts now float and blink a few times and rest, and the line marches only while a step plays.
- The protocol explainer at the top of the website's Developers page plays each step smoothly on slower computers and phones. Each frame now redraws only the shapes the step moves, not the whole explainer, so a step that ran at about 20 frames a second on a slower processor runs at 60.
- The end of every page of the site no longer keeps a phone busy while you read the footer. The sleeping ghost's three z's rose and faded forever, and the page worked out its styles about 15 times a second for it: a fiftieth of a second of work every second on a phone, a tenth of one on a slow phone. The z's now rise a few times when the footer shows and then rest.
- The end of the home page (the download panel and the footer) no longer keeps the page busy with animations nobody can see: the gradient words of the title a screen above, the drifting network of the first act and the little pointer ghost left behind when you scroll now rest until they are back on screen. The page did about a tenth of a second of work every second there, a fifth on a slow phone.
- A page you only read (privacy, terms, a WISP) no longer downloads the scripts of the home, the developer pages, the WISP catalogue and the CLI guide (about 110 KB) as its menu and footer come into view: each page loads when you point at, focus or touch its link.
- On a computer, the little ghost that follows the pointer no longer keeps the page busy once it falls asleep: it floats and breathes its z's a few times, then rests, as the footer's ghost does. Before, it kept going for as long as the page stayed open, at the top of every page too.
- On a phone or a tablet, a reader who starts scrolling the home page before it has finished loading no longer sees the story jump when the chapters take their phone or card shape: what was in the middle of the screen stays there, and the step being read keeps its title where it was.
- A link to a section of the website (ghostly.tools/#download from a README or a chat, a heading of a WISP, a roadmap entry) opens the page at that section again. The page scrolled smoothly through everything above it first, up to 70,000 pixels in under two seconds. Clicks inside the page still scroll smoothly.
- On a slow connection the site's pages no longer show a simpler layout first and rearrange themselves a second or two later, moving the text out from under you if you had started scrolling: they open in their final layout.
- The website's story scenes and the top of the home and roadmap pages settle while you read. The ghosts bob, blink and talk a few times and the network's dots twinkle a few times, then they rest, instead of keeping the page busy for as long as a scene is on screen.

### For developers

- A release build can no longer be put into test mode. The test identity providers and the regtest fake wallets answered to a `ghostly-test-identities` or `ghostly-test-providers` key in the browser's storage in every build. They now answer only in a development build and in the e2e suite's build (made with VITE_APPS_TEST, the same build flag as the mini-app test switch); a released build ignores the key, and so does a plain `npm run build:web`. `testProvidersEnabled` and `testIdentitiesEnabled`, still exported by `@ghostlytools/sdk/fakes`, are folded to false when the SDK is built: a plugin that wants the fakes in the app registers them itself, as before.

**Everywhere**

- A contact's or member's key is read only in its one canonical z-base-32 spelling. A 52-character key whose last character is changed to one of the others that decode to the same 32 bytes is now refused at the invite, pair offer, capability record, identity proof, roster commit, group frame, CLI contact reference, extension viewer address or Pubky homeserver record that carries it, instead of being kept and then failing later as a contact-key mismatch, or, for an unpinned first contact, being stored under that odd spelling. A group frame or commit under such a key is dropped like any other malformed one, and no longer ends the session it came over. No key the app writes is affected, so nothing changes for existing chats. Only a contact's odd client could have presented a respelled key to an earlier build, and what that build stored under it now fails in its one place with an invalid-key error: that chat's DHT delivery and its apps. A member added under one gets no group secret; in a mesh group the other members refuse the changes made over a roster that spells it so, and that group has to be made again.

### Thanks

- Thanks to @vforvilela (#2978, #2979) for the reports and fixes in this release.

## 1.3.2

### Security

- Chats: a received voice message is decoded for playback or MP3 only as long as its description says, and a video's preview picture only as large as a sender draws it, so a crafted message can no longer make the app run out of memory.
- Chats: a payment link for another Ethereum token is no longer shown as a USDT card, and a USDT card's QR never hands out another token's transfer.
- Desktop (Linux): right-clicking a playing video in a chat no longer opens the engine's own menu, which could copy the video's private stream address.
- Payments: a request is always shown as the network of the address it carries, and one whose stated network does not match its address (Ark and Bark too) is refused, so "Pay with another wallet" never offers real money under a "Test money" label. That code and link carry a Lightning invoice only when it asks the amount the request shows.
- Payments: ecash a contact sends that the app cannot read as a token is refused before it is redeemed, so a chat's per-network Cashu setting always applies. An LNURL pay request's callback on another host follows the same rule as a redirect (HTTPS, public address). Fedimint notes already received are not taken again under another payment id.
- Private groups: a member answers an invitation to a group it is already in only over the chat its admin let it in on, and an invitation back into a group you were removed from can be replaced only by that group's admin. The chain pieces an invitee keeps before its welcome are only that group's commits, so an invitation can no longer make the app hold a lot of memory.
- Group files: a file is forwarded only once it checked out against its author's digest; a member whose copy arrived damaged is not asked for it again; one member holds at most one of a device's serving places; a voice message comes by itself only within the automatic limits; and leaving a group while one of its files is arriving leaves none of it on the device.
- Mini-apps: an app's `storage.keys()` calls no longer delay the profile's other writes, a write still queued when an app is uninstalled is refused, and the web broker refuses a request value that is not plain JSON before counting it.
- CLI: a chat's label and a group's name are read before an id prefix, so a contact can no longer take a name you address someone else by; the event journal behind `listen --since` keeps at most 16 MiB and is read from its end; and a daemon that takes calls prepares at most one answer ahead per chat, and a few in all.
- Releases: the npm publish workflow publishes only from `main` or a release tag, and builds the CLI's tarball in a job with no publish token. The merge train counts only a pull request's own CI run, takes a head as reviewed only from `queue`, and a push to `dev` counts as tested only by a green run of its own tree.

### Fixed

**Apps**

- After Allow and open on an app that comes with Ghostly, the keyboard focus is in the question of which chat to open it in. Before, it went to the app's row behind that question, so Tab walked the page behind it and a screen reader did not read the question.

## 1.3.1

### Fixed

**Android**

- Message notifications left from before the Android app was closed (swiped from Recents, ended by Android in the background, or updated) work as before it closed: tapping one opens its chat, the chat's next message replaces it, and reading the chat takes it away. Before, a chat could then show two notifications, reading it left the old one behind, and tapping the old one opened no chat.

**Chat**

- A message arriving in a long open chat no longer makes the screen reader announcement go over the chat's whole history: it reads only the new messages.
- A Lightning offer (BOLT 12) whose currency code is empty or cannot be read no longer shows its amount as sats: an offer for 1,000,000 units of a currency read "1,000 sats". It is not shown as an offer at all, as BOLT 12 asks for one with a currency that is not a three-letter code.
- A message or a call arriving in the web app, the extension or the desktop app no longer reads every chat's stored messages again to find which chat it belongs to (for the mute and the locked-app ring): with a long chat, each arrival did that on top of showing the message.
- In the web app, the extension and the desktop app, a message arriving in a long chat has the chat list and the app icon's badge read that chat once between them, not once each.
- `ghostly message retry` of a message that was already delivered, or of the contact's own message, is refused and says why (exit 1), instead of answering done and sending nothing.
- A chat you joined whose inviter never comes back (they deleted the chat, their app is gone, or the code was dead) no longer reads the relays at the background pace for as long as the app runs. Ten minutes after the join, it is looked at less often the older it gets, at most every three minutes, the same as an invite nobody used: 15 such chats went from 60 reads a minute to about 10. If the inviter comes back, the chat still connects within three minutes.
- A DID, a Pubky key or a chat invite shown as a card in a chat no longer reads every chat's stored messages again each time something changes in the app. With a few cards on screen and many chats, each change used to cost several milliseconds more, up to 20 times a second during a call or a file transfer.
- On the Desktop, choosing HyperDHT or Automatic in a chat while the app was dialling that chat again on its own no longer fails at once with "A native connection attempt is already running". The choice now waits for that dial and goes live with it, or shows why it failed.
- On a slow connection over HyperDHT (Desktop and the CLI), a message sent while a file was going waited behind the whole file: the app never saw how much the connection still held, so it handed over the file as fast as it could read it. It now waits for the connection as it does on the others, and a message goes through in a fraction of a second (7.3 s before, in a test with a contact that reads at about 4 MB/s).
- A message arriving in a long chat open in the web app, the extension or the desktop app is added to the chat without reading the whole chat a second time.
- A message arriving in a long chat open in the web app, the extension or the desktop app is now copied into the chat once instead of twice, and a change with nothing to copy writes nothing: each arrival in a 5,000-message chat took 2 to 3 times the work of a short chat's.
- In the web app, the extension and the desktop app, a message arriving in a long open chat has that chat read once for the whole page (the chat, the chat list, the badge and what keeps the chat in step with the engine), not once by each of them.
- In the web app, the extension and the desktop app, a chat you just made and have open now looks for its contact over the DHT every 10 seconds, as an open chat does. It looked only every 30 seconds, as for a chat in the background, so when the contact chose DHT only right after the chat went live, your side could keep saying "On DHT · retrying live" for a minute before it said "DHT only · chosen by your contact".
- On the side whose contact's app connects to it, a chat that is not live no longer promises "Trying again at" a time after its own attempt failed, and no retry time that has passed is shown.
- In the web app and the extension, a message arriving in another chat no longer draws the open chat again and goes over its whole history: a long open chat stays quiet while other chats are busy.
- A Lightning invoice in a chat now says whether it is test or real money in the chat list and to a screen reader ("⚡ Lightning invoice · Test money · 250,000 test sats"), as a Bitcoin address or a Lightning offer already did. Before, a test invoice read only "250,000 sats".
- A text within 16 KiB that takes more room once encoded than the contact's app accepts (control characters count six each) is refused when you send it, with "Message too long" and the next step, in the app and in `chat send` (code `refused`). Before, it was taken, never arrived, ended the live connection on every try until it failed after 8, and held the chat's other texts back meanwhile.
- Joining from macOS or Windows an invite made on the Linux Desktop app goes live sooner. Your app now connects to the Linux one itself as soon as it sees that app has no WebRTC. Before, it waited for the Linux app to connect, which took up to 4.6 seconds.

**Apps**

- An app that sent as fast as apps may in a chat (a drawing board, a game that syncs its state) could stop a file you were sending there: the file stayed at the same percent while the app sent. Now the app and the file each get about half of the connection, and a Chess move still goes at once beside a file.
- A shared service whose answer was larger than about 100 KB (a page, an image, a download) failed with "The local service dropped the response." when the chat was connected through Iroh or HyperDHT (the Desktop app, or the web app on Iroh). The answer now arrives whole at the connection's pace, as it already did over WebRTC.

**Everywhere**

- The app starts with about 90 KiB less JavaScript to load and parse: the Bitcoin Core wallet source and its transaction code are loaded when such a wallet first connects, not at every start.
- Closing the Ghostly window on Linux or Windows now says goodbye to your contacts before the app quits. A call in progress now ends at once for the contact, instead of going on for about 16 seconds and ending as failed.
- The app starts with about 400 KiB less JavaScript to load and build: the emoji list is loaded the first time an emoji panel opens (the composer's, or a reaction's +), not at every start. If it cannot be loaded, the panel says so with Try again.
- When a contact's app is asleep or frozen, a failed HyperDHT connection says so in your language, with what to do (turn Fallback on, or try again once it's back), instead of a bare "Couldn't connect". The Desktop's own HyperDHT messages (an attempt already running, HyperDHT stopped) are said in your language too.
- The app's first load has about 78 KiB less JavaScript: the identity proof providers (Nostr, Pubky, a domain, OpenPGP, Bitcoin, SSH, OpenID Connect, DID, AT Protocol) load on their own once the app has started, when the profile's proofs load or something about identities is first shown.
- Opening the Linux Desktop app a second time on the same profile brings the running window forward and closes cleanly. The second launch could crash instead, leaving a crash report behind.
- The app starts with about 42 KiB less JavaScript to load and parse: the Nostr bunker (NIP-46) signer is loaded when a proof or a post is first signed with a bunker, not at every start.
- The app starts with about 28 KiB less JavaScript to load and parse: the Nostr Wallet Connect client is loaded when an NWC wallet first connects, not at every start.
- The app starts with about 124 KiB less JavaScript to load and parse: the QR code reader is loaded when Join first scans a QR or reads a picture of one, not at every start.
- A Pkarr relay that fails for a moment while the app starts is left alone for a minute, then asked again, instead of five minutes: the requests already sent to it when it failed no longer count as new failures.

**Website**

- The site's pages no longer download the brand page's data (219 KB) as soon as the footer comes into view: it loads when you point at, focus or touch its link, as the roadmap and the WISPs do.
- The brand page no longer keeps a phone busy while you look at its ghost moods or its social post example. Each ghost there moved its hem, blinked and talked, and the page redrew itself about 120 times a second for as long as they were on screen: a fifth of a second of work every second on a phone, almost half of one on a slow phone. These ghosts are examples, so they now hold still.
- The home page rests once nothing on screen moves. The ghosts drawn in the story's pictures kept moving their hems while out of view, and the page laid itself out 60 times a second at every scroll position: about an eighth of a second of work every second on a phone, almost half of one on a slow phone. They now rest with their picture and move again as it comes back into view.
- The "page not found" page no longer keeps a phone busy while it is open. Its searching ghost, the beam, the blink, the ring around the 0 and the ghosts floating by were moved by script or redrawn the whole page about 60 times a second: up to half a second of work every second on a slow phone. They now play as smooth graphics animations that leave the page alone, and the floating ghosts drift by twice and then rest.
- The first screen of the home page, the roadmap and the agents guide no longer keeps a phone busy while you read it. The ghosts there moved their hem for as long as they were on screen, and the page redrew itself about 60 times a second: a tenth of a second of work every second on a phone, over a third of one on a slow phone. Their hem now stirs a few times when they appear and then rests; they still blink and float.

**Calls**

- A contact who calls again within 2 seconds of a call you missed no longer rings: no card, ring or notification. The call is still kept as a missed call, and a call placed after a short pause rings as before. A contact calling and hanging up over and over rang for every call.
- When a chat cannot start a call, its greyed call buttons can still be reached with the keyboard and a screen reader reads why calls are off; before, the reason was only a hover text, which a phone never shows. On a phone, the Video call row of the ⋮ menu shows the reason under its name.
- A chat keeps its last 200 call lines ("Missed audio call", "Audio call ended"); older ones leave this device as a deleted message does. A contact who rang and hung up over and over left two lines a call that never left, so every later call and message in that chat took longer to save, and after a few thousand calls the app could no longer save the chat at all.
- The command-line app waits 2 seconds before placing a new call in a chat where its last call went unanswered, and says how long is left. A program that called and hung up in a loop sent more than a thousand calls a minute, and each one left a missed call in the contact's chat.
- While a call rings in, the ringing card no longer keeps the whole window redrawing: its picture pulses a few times, then rests, and the screen behind it is dimmed without a blur. In Chromium this took a full core of the graphics process for the whole ring.
- On a phone, the small window of a voice call keeps its parts apart: the contact's avatar and its speaking ring no longer cover the line with the call's time, and the names no longer run into the buttons. In a window that low each side is a row, avatar and name, and your own name is read out to a screen reader instead of shown.

**CLI**

- `profile backup --out` naming a file that exists answers `refused` (exit 1), not `confirm` (exit 5), which says to pass a flag such as `--force` that backup does not take.
- A call placed in the same millisecond as the hang-up before it now rings at the contact, and a hang-up sent in its offer's millisecond ends the contact's ring: each call signal the CLI sends in a chat is dated at least 1 ms after the one before it, so the contact no longer drops it as not newer. A bot that redialed at once lost about 1 call in 20 (it rang 60 s, ended unanswered and was busy for that minute).
- `chat connect` and `chat pay` on a chat whose invite someone else used first now refuse at once with the sentence `send` gives ("Someone else joined with this invite first. Ask your contact for a new one.", code `refused`, exit 1). Before, `chat connect` dialed for 120 s and answered `timeout`, a code a bot retries.
- The CLI answers the engine's known errors with the code a bot can act on: a mint, a Lightning address or the network that does not answer is `unavailable`, one too slow `timeout`, a wrong mint URL or maximum fee `bad_request`, not enough sats or spent ecash `refused`, instead of `engine` for all of them. A relay address `settings set` cannot take is `bad_request` naming its key, and a Lightning address it cannot reach no longer mentions a browser's CORS.
- `ghostly file cancel|decline|pause|resume|accept` on a chat's file that is already all here is refused (exit 1) with "Nothing to stop: the file is all here" or "Nothing to ask for: the file is all here", as for a group's file, instead of answering exit 0 with the action as if it had done something.
- `ghostly file save` with both `--dir` and `--path`, or with `--timeout` but no `--wait`, and `ghostly identity complete` with both `--evidence-file` and `--stdin`, are usage errors (exit 2) naming the options, instead of one option winning without a word or `--timeout` being ignored.
- `ghostly file save --path <a folder>` says "<folder> is a folder: name a file, or use dir (--dir <folder>)" (`bad_request`), with or without `--force`, instead of asking for a `--force` that then failed. An empty `--path` or `--dir` is a usage error instead of the current folder.
- A daemon holds less memory for the files it has sent and received. Each file's transfer state now lives in `rows.db` with the messages, instead of in memory for good: with 10,000 files the store held about 24 MB of heap and now holds about 13 MB. A profile moves the states there at its first start after the update. The file records themselves stay in memory, since a small file can be kept whole in its record.
- An admin's `ghostly group leave` names the member who became the admin (`admin: {key, name}` in its answer), as the app's Leave dialog does: it handed the role on without saying to whom.
- `ghostly group leave` asks for `--yes` (`confirm`, exit 5, without it), as `group forget` does: leaving deletes the group's history and files on this device, which its help now says, and it did so without a word.
- `ghostly invite join` with your own invite says "This is your own invite. Share it with a contact; they join with it." with the chat that owns it as `details.chat`, instead of starting with the engine's internal "own-invite <chat id>:" tag.
- `settings set irohRelays` or `hyperdhtRelay` with an address of the wrong kind (`ftp://`, or `http://` and `ws://` away from this machine) answers `bad_request` naming its key, "use an https:// relay address", instead of `engine`.
- `ghostly file save` of a file you sent writes it, even before the contact has taken it or after a profile restore, instead of saying "The file is not all here yet (0 of N bytes)" though every byte is on this device.
- On the command line, `wallet create` refuses a source or a field you left out, or one the wallet does not take, as `bad_request` naming the flag (`lightning needs --provider: one of …`, `nwc needs --value uri=<…>`, `fedimint needs --invite <fed11…>`), instead of the app's words as an engine failure. A `--provider` or `--value` given to a wallet without sources is refused instead of dropped, and `wallet list` no longer offers the browser wallet (WebLN), which only works in a browser.
- A file sent to a CLI profile while it was away (held storage) is kept as a file in the profile's folder, like every other file, not in its store: 24 held pictures of 4 MiB made the store 100 MB, held in the daemon's memory and read back at every start and command. Files that already arrived this way stay where they are.
- `ghostly listen --type chat` (or `message`, `daemon`, any family name) now lets that family's events through, as its help said. Before, a family only matched written with its dot (`chat.`), and `--type chat` stayed silent for good. A dotted type such as `group.message` is still that type alone.
- `ghostly listen --type bogus` (a word that is no event family) now stops at once with a usage error naming the families, and a type no event has, such as the typo `message.recieved`, is said on stderr. Before, either was taken without a word and the listener stayed silent for good.
- `ghostly typing <chat> --for N` (and `group typing --for N`) without a daemon no longer holds the terminal and the profile for N seconds when the chat is not live: it waits up to 15 seconds for the chat to come up, then stops and answers `live: false`. Once the chat is live it stays the whole time, as before.

**Groups**

- A chat command given a group's name (`send`, `edit`, `typing`, `chat history`, `chat show`, `chat rename`, `chat remove`) says it is a group and names the group command to use, as `react` already did, instead of only `No chat "team"`.
- `ghostly group history` gives a group's own lines ("Group created…", "You joined…", "You renamed the group to …") `"from":"system"`, not `"peer"`, so a bot that reads others' words by `from` no longer takes them for a member's message.
- A community member opening the app again after being away gets what it missed once. Its first sync to the hub was not counted as a question, so it asked a second time and the hub started its answer over: a member back after 256 messages was sent 288, about 12% more of the group's history on every return.
- With a group open, the app no longer reads every chat's stored messages again each time something changes (a member comes or goes, someone types): with 150 chats that was 5 MB read and about 14 ms of work each time. A member's nickname is read from that contact's chat only, and only when it changed.

**Files**

- A large file (over 16 MiB) that could not be copied into the app before sending now says why in your language ("The file cannot be read", "Not enough space on this device") with what to do next behind the ⓘ, instead of an English line from the engine.
- A large file (over 16 MiB) that could not be copied into the app before sending, because it changed on disk or the device ran out of room, no longer offers a Retry button that can only answer "This file cannot be retried". Nothing of it was kept to send again, so pick the file again instead.

**Wallets**

- In Arabic, a Lightning invoice's memo in a chat reads in its own order ("1 cup coffee", not "cup coffee 1"), and the amount keeps its space before "sats". The same goes for Lightning offers and ecash cards.
- With a long history of reviewed payments, the check that runs every minute for reviews no Approve can send any more no longer reads every payment ever reviewed: it reads the ones still waiting for an Approve, usually none.
- In Arabic, a wallet's history writes each movement's sign before its number ("−1,000", "+250") in the Cashu, Spark, Fedimint and on-chain Bitcoin histories. Before, the sign came after the number ("1,000−").
- An open Ark, Bark, Spark or USDT wallet no longer makes the whole wallet view again every 8 to 10 seconds when its balance has not moved. Each time it read every payment ever reviewed. Payments still on their way in are checked as often as before.

### For developers

- A batch of several pull requests no longer pays a full CI run on dev for its first pushes: each push but the last holds the tree of one of the batch's own commits, and now counts as tested by the batch's green run, as the last push already did.

## 1.3.0

### For users

**Android**

- The native Android app (in progress, not released): links, sign-in pages and payment links open in the phone's own apps, and when the phone has no app for one, or a share, paste, save or sign-in does not go through, the app says so in your language with what to do next; paste reads the phone's clipboard; Share opens Android's share sheet, and other apps can share text and files to Ghostly; notifications ask for permission when you turn them on, and a tap opens the chat; received files save through Android's file picker; signing in to prove an identity comes back to the app; the status and navigation bars follow Light and Dark; opening a chat no longer brings up the keyboard; and a phone whose Android System WebView is too old is told to update it instead of showing a blank page.
- Apps are not available in the Android app yet.
- The Android app keeps its files out of Android's own backup and phone-to-phone transfer, so a new phone set up from an old one does not start with the same Ghostly profile: move a profile with Ghostly's encrypted backup or by adding the new phone as a device.
- A file shared to the Android app whose name is over 255 bytes (86 Chinese characters are enough) arrives under a shortened name that keeps its extension, as `ghostly file save --dir` saves it; before, it was left out of the share without a word.
- The Android app no longer gets stuck checking a server's certificate on a phone where a system certificate authority has been switched off in Android's settings.

**Apps**

- Chess comes with Ghostly: it is under Installed on the Apps page and in a chat's + > Apps, with no trip to the store. The first time you open it, Ghostly shows what it asks and you allow it; nothing is downloaded. Remove it and it stays removed.

**Calls**

- On Linux, the Desktop app shows who is speaking in a call too.
- The ring that shows who is speaking in a call no longer keeps the call window busy: a voice call costs about as little battery as before the ring came.
- In a call, a ring around your contact's avatar shows when they are speaking and moves with their voice, in the full window and the small one. With reduced motion it is a steady ring. The level is measured on your device; nothing about it is sent.
- A voice call shows your own side beside your contact, with a ring that moves with your microphone, so you can see that you are heard. It stays quiet while you are muted.

**Chat**

- Put a chat or a group in a folder by dragging it onto the folder, and take it out by dragging it onto Other chats (hold it first on a phone). Other chats now folds like a folder.
- A folder keeps the order you drag its chats into, pinned or not, and so does Other chats. Until you drag, the latest message is first; the folder's ⋮ → Order by latest message goes back to that.
- Pinned chats are put in order by dragging inside a folder too, not only from the chat's ⋮.
- Folders in the chat list: put chats and groups in your own sections, such as "Agents" and "Personal", from a chat's ⋮ → Move to folder…, or make one from New ▾ → Folder. Each folder's header shows how much is unread in its chats, added up, and folds the folder to that one line. Rename, reorder and delete folders from their ⋮; deleting a folder deletes no chat. Folders are kept on this device.
- Files take a quarter less of the network: between two apps that have this release, a file's bytes travel as they are instead of as text, so a 200 MB video sends about 200 MB, not 268 MB. This works on direct (WebRTC) connections, on HyperDHT (the Desktop, the CLI and a browser), and for files in groups. Older apps and Iroh keep the old way.

**Everywhere**

- The text that opens behind an ⓘ is shorter on every screen, 25 words at most in English, in all 8 languages: devices, wallets, apps, payments, the Tasks board and the screen shown when a profile's data cannot be opened.

**Settings**

- Settings: the text that opens behind an ⓘ is shorter, 25 words at most in English, in all 8 languages. It keeps who sees what (your IP address, a relay, a push service) and no longer repeats the line above it.

**Website**

- ghostly.tools/brand is Ghostly's brand manual: the logo and its rules, the colours with their contrast, the fonts, the voice, the ghosts, and how others may use the name. Its press kit, one zip of the logos (SVG and PNG), the colours (.ase, .json, .css), screenshots and the descriptions to quote, is made from the same source each time the site is built. The footer links it as Brand.

### Fixed

**Everywhere**

- In "Add this device to my profile", when the camera is refused or missing the scanner now says "Camera unavailable. Paste the code from your other device, or open an image." Before, it asked for an invite, which a person adding a device does not have. A code that fails with no reason given says "Something went wrong. Nothing was added." in place of "Invalid invite", and a screen reader names the close button "Close" in place of "Close join".
- In Add a device, Try again after a code that ended now says "Getting ready" while the new code is made, and when the new code cannot be made (no connection, for example) the reason comes with Try again under it. Before, the dialog was left with one red line and nothing to press, and getting another try meant closing it and typing the lock password again.
- A Testnet Ark wallet can move to another test network (Mutinynet, Signet, Regtest) when the server of the one it is on has stopped answering: the app waits 10 seconds for that server to say the wallet is empty, then goes by the last balance it read. Before, the switch waited on that server for as long as it stayed quiet. A Mainnet wallet still waits for its server's own word.
- In Arabic, the Back arrow of a chat, a group, a page and an app opened in a chat now points to the right, the side it goes back to. It still pointed left.
- A Testnet Bark wallet can move to another test network (Signet, Regtest) or be restored over when the server of the one it is on has stopped answering: the app waits 10 seconds for that server to say the wallet is empty, then goes by the last balance it read, pending and exiting coins included. Before, the switch waited on that server for as long as it stayed quiet. A Mainnet wallet still waits for its server's own word.
- A chat whose Iroh listener could not start (its relay out of reach, or no network when the app started) starts it again by itself, and at once when the network is back. It stayed without Iroh until you opened the chat, and a CLI daemon's chats never got it back: a contact with no WebRTC could not reach them over Iroh until the daemon restarted. Groups already did this.
- An app with many chats, back after a restart while its contacts are online, now brings every chat back within minutes. Before, its messages to the relays used up their limit, and the few looks left went to the chats already reconnecting. Some contacts were then looked for once in 10 minutes and their chats stayed down, and those contacts showed offline after 6 minutes. Now a look the limit has held back for a minute goes before the app's next messages, the oldest first. A daemon with 30 chats and 5 groups had 21 of its 30 chats back 10 minutes after a restart, and now has all 30 back in about 5 minutes.
- An app with many chats, back after a restart while its groups reconnect, no longer leaves some chats unread for many minutes. Its chats that are not connected yet now look for their contacts in turn, and a look the relays' limit held back goes again as soon as the limit allows. Before, the same chats took every look the limit allowed. A daemon with 30 chats and 5 groups looked for some contacts once in 10 minutes, and 5 of its 30 chats stayed down although both sides were online. Now it looks for every contact again within minutes, and 28 of the 30 chats come back.
- The admin of a community whose members are all offline, on Leave or "Delete from this device", is now told what works with nobody connected: "Wait for a member to be online, or remove the members first, or make one of them admin." (on Leave: "Wait for a member to be online, or remove the members first."). Before, it said "Try again in a moment.", which never came true for members who do not open the app again.
- A contact whose app crashes and comes back a few seconds after your app reconnected to it is live again in about 2 seconds over Iroh or HyperDHT, not 17 to 19. Your app took the contact's new connection for one crossing its own, turned it away, and waited for the old, dead session to end.
- In dark themes, the red words on a light red button (Delete chat, Leave group, Remove member, Delete folder, Turn off the link, a missed call's line, and the like) were under the 4.5:1 contrast minimum. They now use the brighter red for words, at 4.5:1 or more in every theme.
- On the Desktop app, deleting a chat, a profile or all data no longer freezes the window while its stored files are deleted. With thousands of received files that took a noticeable moment; the window now stays responsive.
- Desktop: the app no longer asks itself every 5 seconds whether each chat's HyperDHT listener is still there. The answer could only ever be "yes, the same" or "gone", and "gone" is now said the moment it happens. With eight chats live over HyperDHT that was 96 questions a minute while nothing happened, for as long as the app ran.
- Desktop and Android: the app no longer asks itself every 5 seconds for the address of each chat's Iroh listener. It is told when the address changes (the listener reached its relay, the network changed), about a second after it does instead of up to five. With eight chats live over Iroh that was 96 questions a minute while nothing happened, for as long as the app ran.
- Desktop: a profile that is on this computer only no longer checks every 5 seconds whether to keep the computer awake. With no second device the answer was always "no", and each check read the profile's device state from the database and from a file on disk: 12 times a minute for as long as the app ran. It now asks once, and starts checking again when a device is added.
- Desktop on Linux and Windows: on a Dvorak, Colemak or French (AZERTY) keyboard, only Ctrl+N starts a chat and only Ctrl+, opens Settings. Ctrl+B and Ctrl+K no longer start a chat, and Ctrl+W and Ctrl+; no longer open Settings.
- Desktop: when the app's window loaded its page again without the old page stopping its Iroh and HyperDHT listeners (another profile opened, Clear all data, the window's own process restarted), those listeners kept running until the app was quit. Eight of each is the limit, so after a few such loads no chat could go live over Iroh or HyperDHT any more ("Native endpoint limit reached"). The app now stops them the moment the window's page starts again, and each contact hears the close at once.
- An idle chat no longer writes to the disk every time it keeps its DHT mailbox alive. Before, each keep-alive (every four minutes per chat) and each one the relays' limit held back (every 30 seconds on an app at its limit, as a daemon with 30 chats often is) rewrote the chat's saved state with a disk sync. That was 16 writes an hour per idle chat, and 242 at the limit, for nothing sent. Now it is 1 and 2.
- The screen shown when the app fails ("Something went wrong", "Start again") is in your language. It was English in all eight.
- A file that did not arrive or was never delivered now says why in your language (damaged, offer expired, no room on this device, not delivered in time), with the next step behind ⓘ. A file sent with + that could not be read no longer calls it a paste.
- Opening a group's link for a group you were invited to, were removed from, or that is one of your private groups now says so in your language, with what to do next.
- A group's link in a chat no longer says "You are in this group." when you were removed from it. The card now says why you are out. For a community group it offers "Join again"; for a private group whose messages are still on the device it says to delete the group from the device first, since its link is refused until then. A group you left offers "Join group" again.
- In a private group, a member whose app closed while another member's app was connecting to it is reached directly again once it comes back online. Before, the other app kept that member on a slower relayed connection until it restarted, and past four such members the rest stayed unreachable.
- Declining a group invitation from its own page now goes back to the chat list. Before, the page was left saying only "This group is gone from this device.", with no header, back button or tabs, so on an installed iPhone web app there was no way out. That page, reached any other way (a group deleted on another device, say), now keeps a header with a back button.
- Move to and Use here no longer say the other device refused when this device stopped the move itself: they say what is true here ("This device is not the active one any more", "That offer ended. Ask again from your phone.", "Another move is in progress"), in your language. Adding a device after its digits ended now says so in your language too.
- With contacts online, the app now settles down when nothing changes: reading a contact that is as it was, or a connection check that finds about the same delay, no longer redraws the chat list. Before, every such check (more than one a second with a few chats) re-read every saved chat, keeping the app busy for nothing.
- A language whose file does not load is said, and asked for again. Each language but English is fetched when you choose it; when that failed (the network dropped, or the app was updated meanwhile), the Language menu in Settings showed the new language while every screen stayed in the old one, and choosing it again did nothing. The Language row now says the language could not be loaded, with Try again, and the app asks for it again by itself when the network is back or the window is shown again.
- A profile with two devices opened with "Start anyway": what it cannot do yet (send or download a file, create or join a group, remove or move a device) says why in your language, and to check your connection. It was one English sentence in all eight.
- On Linux, a file dragged from a file manager onto the Ghostly window no longer opens in place of the app. The window used to show the picture, the text or the folder's listing instead of your chats. A link dragged onto the app, from a browser for example, is left out the same way on every platform; dropped into a text field it is still its text.
- On Desktop, the system dialog that asks before a local app is shared ("Share localhost:3400?", with Allow and Don't allow) is in your language. It was in English in all eight.
- In the web app, Settings, Wallet, Profile, Services, Identities, Apps or Tasks that could not be loaded (the connection dropped as you opened it, or a new version had just gone out) says "This page did not load" in its own place, in your language, with "Try again", and "Reload" if that fails too. It used to replace the whole app with "Something went wrong", and the only way back was a reload at once, which also ended a call in progress. The chat list and a call now stay as they are, and Reload only reloads when the app can be reached.
- With no network, the app no longer redraws the chat list every second or two for chats that never synced. Each failed look for such a chat made the page read every stored chat again: about 540 reads a second with 50 chats. Now a chat shows its first sync under way during its first look only, and a failed look changes nothing on screen.
- Closing a group member's Remove or Hand over admin question, or a contact's identities opened from a chat's ⋮ menu on a phone, puts the keyboard focus back on the button that opened it, not at the top of the page.
- A discovery packet that every relay's request budget holds back is no longer signed first: the app (and a CLI daemon on a private network's relays) says the wait before it signs, so a busy profile at its budget no longer spends CPU on packets that never go out. A CLI daemon with the Mainline DHT still signs them, as the DHT takes them anyway.
- Going Back to Ghostly after its window or tab showed another page starts the app again. The page that came back used to be the one that had left: it had said goodbye to your contacts, so no chat went live again and messages stopped arriving until the app was closed and opened.
- On a computer, a link to a chapter of the ghostly.tools home page (the menu's "How it works", a WISP's "In the app" link, `ghostly.tools/#invite`, `#dht`, `#agree`, `#alive`) shows the chapter's title and first step. It used to land on a screen with no words.
- On ghostly.tools/developers, a screen reader counts the numbered steps and says which one it is on. They were a list with no items in it.
- The download panel of ghostly.tools no longer marks the macOS installer as yours on an iPad. A tablet gets no marked installer, like a phone.
- On ghostly.tools, "Download the app" (the menu, the footer and the first screen's button) lands on the installers. It used to stop at the top of the last section, with the first download link more than a screen below.
- On ghostly.tools, the "Last updated" line of the privacy policy and of the terms is light enough to read. It was below the contrast the accessibility guidelines ask for.
- On ghostly.tools, the Privacy and Terms pages have the "Skip to content" link as their first Tab stop, like every other page. A keyboard or screen reader user used to go through the whole menu before reaching the text.
- On ghostly.tools, the download panel no longer marks the amd64 AppImage as your installer on a Linux ARM machine, where it does not run.
- On ghostly.tools, the map of the roadmap and of the developers page shows the pieces that are not lit with a name and a stage light enough to read. They were faded as a whole, text included; now only their border and fill are quiet.
- On ghostly.tools on a phone, the list of layers under "Open" on the home page keeps every name readable while its layer has not arrived yet. A waiting name was almost invisible; now it is a quiet grey and its colour mark is the part that fades in.
- On ghostly.tools, the phone menu closes after a tap on any of its entries. A tap on the page already open, or on "How it works" on the home page, used to leave it open over the whole screen.
- On ghostly.tools, the phone menu marks the page that is open, in the same cyan as the nav on a wide screen, and says so to a screen reader.
- On ghostly.tools, the phone menu closes when Tab moves past its last entry. The focus used to go on to the page behind the open menu, where nobody could see it.
- On ghostly.tools, the phone menu scrolls when the screen is shorter than it is, as on a phone turned on its side. Its last entries used to sit below the screen's edge, out of reach.
- A link to a section of the ghostly.tools home, such as ghostly.tools/#download, opened on a phone lands on that section. It used to stop up to two screens above it.
- On ghostly.tools, the caption under each app screenshot names the release the page offers ("Ghostly 1.2"). It said "Ghostly 1.0.1" under screens that show what came later, like a photo sent to a group.
- On ghostly.tools, a link to another WISP in a WISP's revision log opens that WISP's page. On seven pages such links used to open a GitHub page that does not exist.
- A link to the WISPs page on ghostly.tools whose `#anchor` has a stray `%` (such as `/wisps#100%`) opens the page. It used to show "This page couldn't load".
- With a screen reader, the screen of a device on standby ("Active on <device>") is no longer read again from the top, buttons and device list included, each time a device's connection changes, a connection check answers or a move goes one step further: only its title and its hint are read when the state changes. While files are copied in a move, "Copying files" is read once, where it was read again at each change of the amount ("12 MB of 300 MB", twice a second); the amount stays on screen and on the progress bar.
- The app opened while your contacts are online brings those chats back within seconds. As it started, its chats with contacts away for long, its groups and its chats that had just come back spent the relays' limit for the minute. The chats whose contacts were online and waiting could not finish connecting until the limit freed, minutes later. Now the chats that are connecting go first. With 30 of 50 chats' contacts online and 20 groups, all 30 chats are live 9 to 11 seconds after the web app opens. Before, 10 to 14 were live after 3 minutes.
- In a chat's connection panel, an Iroh or HyperDHT option this app could not start now says why in a few words of the app's language, as the line below the choices does ("All native connections in use", "HyperDHT relay unreachable"): its tooltip, its screen-reader description and the second line under it on a phone. Before, they read the engine's whole English sentence in every language.
- The web app no longer rewrites its list of wake-ups in the browser's database each time anything changes on screen (typing, a file's progress, a contact coming online: up to 20 times a second). The list is written when a chat's wake-up or mute changes. A mute that ends by itself now lets the contact wake that chat again at once, instead of at the next change.
- Light theme: the warning lines outside the notices read at 4.5:1 or more instead of pale yellow at about 2:1. A public DID's "Public to everyone, forever", the wallets' test-coin, unconfirmed and fee lines, a full group's link note, the message size counter and an identity about to expire.
- The web app no longer downloads its own files twice. The first time it opens, the files the page has just loaded are kept for offline use from the browser's copy (56 files, about 1.3 MB over the network, were fetched a second time). After an update, only the files that changed are downloaded: an update that changed one file took 155 requests and about 4.5 MB before, and takes 9 requests and about 0.7 MB now.
- The "page not found" page of ghostly.tools is a still when your system asks for reduced motion, as the other pages are. Its ghost kept drifting, its flashlight kept dimming and 25 small ghosts kept floating by.

**Identities**

- Add a device: a double click on They match (or They match, then They don't match) is one answer. It no longer leaves a red error line next to "added", and the new device is sent its place in the profile once.
- The Android app no longer offers a Bluesky identity, whose sign-in always failed with "Invalid sign-in state" before any browser opened. It comes back once Bluesky can sign in on the phone.
- Dates on ID cards ("Chatting since", "Valid until"), when an identity was checked, a post's full date, when your DID was published, a time written in a message, and when updates were last checked now follow the app's language, not the browser's.
- Desktop: the browser page a sign-in comes back to ("Returning to Ghostly…", "Done. You can close this tab and return to Ghostly.") is in your language. It was English in all eight.

**Apps**

- An app opened on its own (from the Apps page) on a phone keeps its bar and its Close below the status bar. In the web app installed on an iPhone they sat under the clock, and Close could not be pressed.
- An app that sent as fast as apps may in a chat, over a slower connection, made your own messages wait 10 to 30 seconds behind its data. An app's data now keeps to a quarter of what the connection may queue; past that `chat.send` answers `too-fast`, so messages still go at once. While a file goes in the chat, that quarter comes on top of what the file holds, so a Chess move still goes at once beside it.
- Saving an app's data before removing it no longer holds the page for a quarter of a second with ten chats of data: each chat is read in turn, and the data is written as it is kept instead of being read back and written again.
- Export, offered before an app is uninstalled, wrote the app's data as indented JSON all at once: data kept in two or more chats could fail to export at all, and ten chats froze the page for seconds. The file now holds the same data written compactly, one entry a line, one chat at a time.
- An app that read a large file of its own bundle many times a second (16 MiB, 50 times a second) made Ghostly copy hundreds of megabytes a second, so the page stalled for most of a second and grew by about a gigabyte. File reads now go one at a time and add up to at most 16 MiB a second per app; past that `ghostly.file` answers `too-fast` until the second has gone.
- A file an app reads from its own bundle (`ghostly.file`) was copied twice on the web page's thread before the app got it. It is now copied once, which halves what each read of a large file costs.
- On a phone, an app's row in Apps now shows "Comes with Ghostly" or "Unknown publisher" before the app's tagline, so the part that matters is not cut off.
- Apps, Add: a link written with `http://` to GitHub or jsDelivr (`http://github.com/owner/repo`) is read as its `https://` link. Before, it was refused as "not an app, paste the repository's link", though it was the repository's link. Nothing is asked over `http://`.
- Apps, Add: a link written without `https://` (`github.com/owner/repo`) is read as the repository it names. Before, the browser stopped it with its own "Please enter a URL" bubble, or Check did nothing. Text that is no link now gets the dialog's own message, in the app's language.
- Chess, which comes with Ghostly, no longer carries the warning for an app by a stranger. On a new profile its first open said "Unknown publisher" and "Not in any of your stores" in amber, right above "Comes with Ghostly", and once installed its row ended in "Unknown publisher". The version that comes with Ghostly now shows its publisher's key with no warning, and its screen says "Comes with Ghostly". A later version is checked against your stores as any app is.
- An app that talks a lot with the contact's app (a game sending many frames a second) costs the chat less: each frame it sent made Ghostly derive the chat's own key from its seed again, only to name the app to the contact, about 0.6 ms a frame and 30 ms of every second at the 48 frames a second an app may send. The key the chat already keeps is used, and a frame now takes about 0.02 ms to name.
- On the web and on Desktop, installing, updating or first opening a large app no longer freezes the page while its files are checked. A 16 MiB app was checked in three runs of about 150 ms each between the tap on its listing and the app on screen, during which nothing was drawn and no input was taken, and an update taken by the background check did the same in the middle of typing or a call. The files are now checked off the page's thread, or a small piece at a time where the browser cannot do that. The same goes for a large store index and a publisher's revocation list, which were read in one run at every update check.
- On the web, a full-screen app whose Open was pressed twice before it showed (a double click or double tap) started twice, one layer over the other: Close took the top one away and the same app was still there under it. It starts once now, and opens again after Close as before.
- Adding a store with many revoked apps no longer waits a third longer than its checks take: each short pause the page takes while it checks them cost at least 4 ms, about 2 seconds of 6 on a Linux computer for a store with 4096 revocations.
- Checking an app made of many small files no longer holds the page for up to 50 ms at once: the check now lets the page draw between files, as it already did inside large ones.
- An app's newer version that a store of yours removed, or that its publisher revoked, is no longer downloaded again each time the Apps page opens. Ghostly reads its first 64 KiB to see which version it is and stops there.
- An app that needs its files again (a profile restored from a backup) no longer downloads a whole newer version from each of its addresses just to set it aside. When its maker has released since, Ghostly now reads the first bytes of each address, sees it is another version and stops there. Before, every Open and every visit to the Apps page downloaded and checked the full file from each address (up to 16 MiB each, 9 addresses), for as long as an update that asks for a new permission was waiting.
- On the Apps page, Show more under a store's listings moves the keyboard focus to the first listing it added. After the last ones the button goes away, and the focus went with it to the top of the page, so the next Tab started far from the listings just shown.
- An app's first save after Ghostly starts no longer reads everything the app keeps in that chat just to count it: the count is kept beside the app's data, so a chat full of small values no longer takes over half a second on that first save.
- An app can no longer keep far more on the device than the 5 MiB per chat it is allowed. Only the bytes of its keys and values were counted, not the roughly 140 bytes each key costs to keep, so an app that stored very many tiny values could take over 100 MiB in one chat before it was told its storage was full. Each key now counts 128 bytes more, which keeps what an app takes close to its 5 MiB. An app's data already on the device is kept as it is.
- An app that keeps long keys can no longer take 5 to 10 times its 5 MiB per chat on the device. The device keeps each key several times over, so a key's bytes now count eight times toward the 5 MiB, and a chat full of 256-byte keys takes about 7 to 9 MB where it took 40 to 55 MB. An app's data already on the device is kept as it is.
- On the Apps page, a store shows its apps right away when it is your only store or lists a few (the Ghostly Store and Chess, on a new profile). They were behind the store's name, which opened them when pressed and looked like a label, so the page read "1 app" and showed none. A store with a longer list beside others still opens from its name, which now has an arrow.
- In a chat, + then Apps no longer shows an app as "Stopped", with Open off, when its files are just not on this device (a profile restored from a backup brings the list of apps, not their files). It says "Needs its files", and Open fetches them and opens the app. A version its maker revoked or a store removed still reads "Stopped".
- On Desktop, an app reading its own large files no longer slows the Ghostly window: the files go straight to the app's window instead of through the one you chat in.
- Desktop: the window of an app a contact shares says in your language that the service is not reachable, or that a request failed. Both were in English in every language, and the second showed the engine's own error text.

**Android**

- A photo taken with the composer's Camera stays inside the app's private storage and is deleted at the next start, and a cancelled photo leaves nothing. Before, every photo, sent, removed or cancelled, stayed in the phone's shared app folder (Android/data) for good.
- A chat's new messages now share one notification, which pops up only for the first of them and goes away once you read the chat in the app. Before, every message stayed in the notification shade until swiped, and once Android's limit of 50 was reached, new messages showed no notification at all.
- Tapping Paste after copying a big text file, or a link to one that loads slowly, in another app no longer freezes Ghostly: at most 64 KiB is read, in the background, and a longer file is left for the keyboard's paste.
- Changing the phone's font size, display size or bold text while Ghostly is open no longer leaves the app on a blank page that says "Ghostly is already running with this profile" until a force stop. The same goes for a change to a right-to-left language or to the wallpaper's colours.
- Files shared to Ghostly from another app no longer stay in the app's storage after you send or cancel the share: their copies go once the app has read them, and any an earlier run left are removed when the app starts.
- Sharing to Ghostly twice in a row keeps the newer share: a big video still being copied when you share a photo or a text no longer replaces it when its copy ends, and the Share to… picker no longer turns into "Nothing was shared" because of it.
- A share to Ghostly that brings nothing the app can take (its one video over 256 MiB, or a file that cannot be read) no longer stops the share still being copied before it: that one still reaches the Share to… picker.
- A release built while the repository has no Android upload key no longer attaches a debug APK: it goes out without an APK and its notes say so. A debug build takes test launch options and can be inspected over USB, so it stays the CI run's artifact, to try the app only.

**Chat**

- Android: sharing many photos or videos to Ghostly from another app no longer reads every file into the app before the Share to… picker opens. The picker opens as soon as the names and sizes are known, the files are read only once you pick a chat, and a share brings in at most 256 MiB in all, as a paste does, so a large share no longer runs the app out of memory and vanishes.
- On a network that drops STUN (common at offices, schools and hotels), a chat connects directly about 4 seconds sooner. The side that answers no longer waits 5 seconds for a public address that never comes: like the side that offers, it goes after 2 seconds with what it has. The same goes for every reconnection, and a call can be placed sooner too.
- Closing the attachment sheet after sharing files into Ghostly puts the keyboard focus back in the message field, where the shared text is, instead of on the page.
- Task cards: on a light theme, a blocked task's "Blocked" is written in a darker amber that can be read (4.5:1 or more, it was about 2:1), on its card in the chat, in the Tasks panel and on the Tasks board. The mark of a pull request whose checks are pending gets the same ink.
- Pressing a button on a message reads that message alone; the chat's or group's history is read only for a question that one answer closes.
- The app, and the CLI's daemon, no longer do more work for every file a chat ever sent or received. Each update of the app's state carried a finished entry for every one of them, again after every start: at 10,000 files 1 MB an update, and most of a daemon's busy time while it only texted. A file that finished before the app started now shows no transfer and reads as done from what the device keeps of it, as a group's file does; the CLI's `file list` reads it the same way.
- The chat list writes each row's date with one formatter per language instead of a new one per row on every render, which took 7.5% of the page's work while a large profile started.
- Pictures in a chat, and the posters of videos made on this device, start loading a little before they scroll into view, as intended, instead of only once they are already on screen, so they no longer show as a grey box for a moment while you scroll.
- In Safari and the macOS and Linux apps, a chat kept open in the background (on a call, or with an app running in it) is where you left it when you come back to it, at its last message or on the message you were reading, instead of far up its history.
- Opening a chat with many pictures read every picture of its last hundred messages whole, all at once, and again each time the chat was opened: on Desktop and Android that was 400 MB through the app for a hundred 4 MB photos. A picture is now read only once it comes near the screen, three at a time, and the last ones read are kept until the app closes, so a chat opened again reads none of them.
- Search in a chat or a group keeps every letter typed right after it opens. Before, the letters typed before the screen's next frame were selected and the next key replaced them, so on a busy phone "line" could read "ne" or "e".
- In Arabic on Linux, the message field no longer shows scrollbars across it after the window is made narrow with a chat open. They stayed until you typed.
- A chat's connection choices are one Tab stop now, the choice that is checked, and the arrow keys move between the choices that can be made (Home and End go to the first and last, and Left and Right follow the page's direction in Arabic). Space or Enter makes the choice. Before, each choice was its own Tab stop and the arrow keys did nothing.
- In a chat's connection panel, the transport choice that has the keyboard focus carries the accent ring, as the Details link next to it does. Its only mark was a background a shade off the panel's, so moving between choices with the arrows showed almost nothing.
- When both sides of a chat dial each other at once (two Desktops or CLIs with no WebRTC pairing for the first time, or both apps back after a restart) and one side's dial stalls, the connection that already worked carries the chat after half a second. Before, it waited up to 2 s more for the stalled dial to be made again (3 s at most).
- Editing a message no longer gets slower as a chat grows: an edit and its confirmation read the edited message, not the chat's whole history. A bot that updates a card in place read the history three times for every update, and once more 20 seconds later. On the CLI, ten edits in a chat of 5,000 messages took 3.7 s and now take 1.9 s.
- Chat invite, group link, identity and Nostr cards in a chat: the small label above the title and the "You sent"/"From …" line under it read at 4.5:1 or more on both bubbles of every colour theme, dark and light (on your own card in classic dark they were 3.5:1).
- On Desktop and Android, opening a chat no longer reads every file in it that is not a picture (up to 64 MB each) into memory. Such a file shows its Save button from whether it is on the device, and none of its bytes are read until it is saved.
- Several files sent to a contact at once arrive three at a time again, as they should. Each file was counted against that limit only once the place to write it was open, so the files offered meanwhile all started together (up to a hundred at once). The contact's side then took in more than it could handle, ended the chat's connection and dialled again, sometimes several times in a row: no call could be placed meanwhile, the burst took much longer, and some files never arrived.
- A file whose bytes had all arrived when the connection dropped now finishes as soon as the chat is back. Before, the sender could show it as sending for good, though the contact already had the whole file.
- A chat with many files and voice messages no longer slows the app down when it connects: each file that had already finished read the chat's whole history again on the chat's first connection after every start, and its details then said it was completed at that moment. On the CLI, a chat of 5,000 messages and 300 files took 41 s of reading there and now takes 0.2 s. A file's details keep the time it really finished.
- Sending or receiving a file or a voice message no longer gets slower as a chat grows: it reads the message that carries the file, not the chat's whole history (twice for each file sent, once for each received).
- Several files sent to a contact at once no longer end the chat's connection on a contact whose app is older (1.2.3 and before took every file at once), nor where files go as text: what all the files sent and the contact has not confirmed yet now stays within 2 MiB together, not 1 MiB for each file.
- A file a contact sends the earlier way (files/2) no longer loads every file record of the chat before it starts: the chat already knows which files it holds.
- A chat first stored by a release before 1.0 no longer shows "Dropped and came back N times" in English in its connection history, whatever the app's language: that drop now reads like any other.
- A receipt on the DHT for a file that waits for the live link, or for an edit sent there, no longer reads the chat's whole history each time: the files said there are read once, then kept as they are said.
- Forwarding messages no longer reads the whole history of the chat or group they come from: only the messages forwarded are read.
- With many chats, the page's storage could fill up and a chat's new messages were no longer kept there across a reload. When a chat's copy does not fit, the other chats' copies (least recently active first) now keep only their last messages, which the app also keeps in its database, to make room.
- When the page's storage is full and a chat's copy cannot be kept there, a notice above the chat list now says "Storage full" and what to do: new messages still show, and deleting chats or profiles you no longer need keeps them after a reload. Before, nothing said so.
- Once the page's storage was full (many chats, or another profile on the same browser), a contact's new messages were marked delivered on their side but never shown here, not in the chat list, not in the chat, not after a reload, and your own sends stayed on the clock. They now show and count as unread, and your sends turn delivered, however full the storage is.
- A chat whose contact restarts soon after a restart before is live again on the fast look, not 8 s later: in the first seconds after the contact went away, a few reads of it may go past the relays' request budget, which the earlier restarts had spent.
- On a phone, a bot's usage meter in the chat's header is the small meter and the percent ("96%"), without the reset time (a tap still says it): the bot's status beside it ("Reading…") has the room, and a long one ends in an ellipsis instead of being cut.
- Opening a message's details, retrying a message, and storing a text for a contact who is away read that one message instead of the chat's whole history (a held text read it up to three times).
- The timeline's ↓ button (scroll to bottom, new messages) pressed from the keyboard or with a screen reader leaves the focus on the messages, so the next Tab reaches the message field. It used to drop the focus to the page, and Tab started again from the top.
- On Linux, a message in a chat open in a Ghostly window that is on screen but not focused (on a second monitor, behind another app, on another workspace) shows its notification again. Before, the app took the notification back about 55 ms after showing it, so nobody saw it. It now stays until the window gets the focus with that chat or group open.
- On Linux, a received video or audio file that the disk has no room to play now offers Download instead of failing partway through. The Linux app's media player copies the whole file to /var/tmp each time it plays, even when paused, so playing a file needs its size plus 500 MB free there. The copy goes away when the player closes.
- On Linux, the right-click menu of a playing video no longer offers Download Video, which saved a copy into Downloads under a made-up name, with no dialog and no sign in the app. The menu's other Download items (link, image, audio) are gone too. A received file is saved through the app's own Save, which asks where and keeps the file's name.
- Scrolling up a long chat on a slower phone or computer still stuttered each time older messages came in. The messages off screen are now skipped when the chat is drawn, so the time the page spends frozen while you scroll is down by about a third. This applies to the web app (except in Safari), Android, and the Windows app.
- A jump to a message a screen or two away (a search's older or newer match, a quote, the pinned message) still glides all the way there, where it went the last part of the way in one leap with the messages off screen skipped.
- Scrolling through a long chat on a slower phone or computer froze the page for a moment every hundred messages or so, as each older page came in. Pages are now a quarter the size and the page holds half as many messages at once, so the longest freeze is about a third of what it was.
- Taking back your reaction from its chip under a message, or pressing the red "not sent" mark to send again, keeps the keyboard focus on that message. The chip or the mark goes away once pressed, and the focus went with it to the top of the page, so the next Tab started far from the message. In chats and groups.
- A chosen Iroh or HyperDHT connection that fails is now told in the app's language, with what to do next, on the lines about why a chat is not live and on a failed switch's line and its Why row: the contact's app may be closed, it has no free native connection, or it is not reachable on HyperDHT. They showed the transport's own English ("Iroh connection timed out", "connection reset by peer") in every language. That English stays behind the ⓘ.
- With the app's storage full, joining by a good invite or starting a new chat says there is no room for a new chat and how to free some, instead of "This is not a Ghostly invite." and a chat that never opens.
- A chat with no WebRTC that gave its direct connection up to another chat in use no longer looks for its contact every 20 seconds for as long as both apps run, and its contact no longer looks fast for a call that cannot come. Both now read at the background pace, which leaves more of the relays' request budget for the other chats, and the chat connects again as soon as one side can dial.
- A message sent right after the app opens shows at once as sending, instead of seconds later once the app has read every chat's history.
- On a phone, a chat's header shows the contact's name with the room it needs. It had nine marks and buttons beside and under the name, in three styles, and cut the name to eight letters ("Cérebro (…"). Now it is the name, the connection, a voice call and ⋮, with one quiet line under the name: a bot's usage meter and what it is working on, or a person's key. The video call, a bot's Tasks and the contact's identities are the first rows of ⋮, each in words, and ⋮ counts the running tasks. The connection keeps its place in the row, so a chat that is connecting, offline or failing shows it without opening anything. A phone on its side and wider screens keep every button in the header.
- "Show picture" on a contact's picture link shows the picture. The web app, the extension and the desktop app let the page load pictures only from the GIF picker's sources, so a picture from any other site never appeared: the button turned into a plain link, and a picture link of your own showed as a link too. The app now reads the picture itself once you ask (your own at once), without cookies or a referrer, and shows what came. In a browser, a site that lets no other page read its pictures still shows as a link.
- Reacting to a message, or taking a reaction back, no longer reads the whole history of a long chat or group each time: only the message is read.
- Taking back the reaction the chat list shows no longer reads the whole history of a long chat or group to find the one shown before it.
- Reconnect (and `ghostly chat connect`) dials at once when WebRTC can carry the chat, and Iroh and HyperDHT join as they come up. Before, it waited for every native listener first: 10 s or more a reconnect when Iroh's relay was out of reach. A chat that only goes live over Iroh or HyperDHT still waits for them.
- Sending a reply reads only the message it answers, not the chat's whole history: about 50 ms less per reply in a group or chat of 10,000 messages. A chat's file or payment is still looked for in the whole chat, as before.
- A live chat no longer writes its connection history to disk every time its round trip moves by 10 ms. The round trip still shows at once; on disk it is kept at most every 5 minutes, with no disk sync of its own, so an idle chat on an internet connection makes about 11 writes an hour where it made about 95 to 150. A power cut loses at most the last 5 minutes of round-trip changes, never a line of the history.
- In Arabic, a chat's Fallback switch keeps its knob inside its track when it is on. The knob moved right, as in left-to-right languages, and ended 16 px past the track, so the switch looked like it had no knob.
- With many saved chats, opening the app no longer spends its relay requests looking every few seconds for contacts who have been away for a long time. A message sent right after opening, and the app's own records, now go out in the first seconds instead of a minute later.
- The ↓ new messages button now goes down to a bot's routine cards folded into one row, in place of jumping up and losing its count, and a chat scrolled up stays on what it shows when such a row is below.
- Ending a choice of messages to forward (Cancel, Escape, or the forward itself) from the keyboard or with a screen reader leaves the focus on the message field that comes back, or on the messages on a touch screen. It used to drop the focus to the page, and Tab started again from the top.
- A chat that goes live no longer reads its whole history to find the files and payment requests that waited for it: they are known from the start of the app, then kept as they are written, and read one by one.
- Share to…: a long file name with no spaces wraps inside its card, so its end and extension stay on a phone screen instead of running off its edge.
- An app left open for a while makes its next invite on keys already known to the network again, so it pairs as fast as one made just after start. Before, the ready invite aged out after 15 minutes but was still refreshed every 4, on keys no invite would use.
- The "Storage full" notice goes once room is made: deleting a chat or a profile, or room freed in another tab, stores what the page held and takes the notice away. It used to stay until a reload or the held chat's next message, and that chat's new messages were not kept even though there was room.
- Tasks board: a task a bot sent to several chats (its own chat and a group, say) is one card and counts once, in its column, in the header and above the chat list. Before, it was there once per chat, so the counts were two or three times the tasks. The card shows the newest state, names the chats it lives in, and opens where it changed last.
- At start the Tasks board reads its card index once, not once for each batch of chats and groups the app loads (three reads at once with a large profile, two of them thrown away). A chat or group that comes later still reads it again, once however many come while that read is on its way.
- The notices that stay at the top until closed ("No room for a new chat", a group link that could not be used) also close with Escape or a tap on their words, as the app's other top notices do, so they no longer keep New, Join and the home link covered on a phone. Closing one puts the keyboard focus back where it was instead of on the page.
- A transport change that did not connect is now told in the app's language: the chat's line, its Why row, the connection history, the lines on why a chat is not live and the header's notice. Each says why in a few words ("Iroh did not connect in time", "Your transport choices don't match") and, where there is one, what to do next. The engine's own English stays behind the ⓘ.
- A screen reader says what a contact is doing ("typing…", a bot's status) and nothing more: it used to read out the contact's key each time they stopped typing, and in a group the member count each time someone stopped.
- Unpinning a message with the keyboard, from the ✕ on the pinned message's bar, leaves the focus on the chat's options button instead of dropping it to the page, in a chat and in a group.
- Invites nobody used no longer take the relays' whole request budget for as long as the app runs. Ten minutes after it was made, an unused invite is looked at less often the older it gets, at most every three minutes: 15 of them went from 60 reads a minute to about 10, which leaves room for chats and groups, and a join on one is still noticed within three minutes.
- A bot's usage card, in its details: a window whose reset has passed says how long ago it reset ("reset 1 d ago"), muted. It said "resets 10:50 AM" of a time that was yesterday, and the card's own Resets row said "03:50 PM · now".
- On the desktop app, Save on a voice message that can't play on this computer did nothing: no file, no word. It now opens the system's save dialog, like Download in the message's menu, and says why when the file could not be saved.
- A chat back from the background while the contact is trying to reach it is live again in about a second, not at the contact's next look (up to 8 s): the app back also reaches the contact on its other transport while it answers.
- Desktop for Windows: texts sent from the app now reach the contact in every chat. The Windows app sent them the old way, which a current chat does not read, so the contact (often the web app) never got them, calls stayed greyed out, and the app could show "You joined the chat" in a chat it made. Texts it sent before this release went nowhere: send them again.

**Groups**

- A group member's connection whose answers WebRTC refused several times in a row (a race in the WebRTC library on a busy machine) is tried again after a few seconds, then over Iroh or HyperDHT, instead of waiting three minutes. Before, a member let in to a group could wait from 30 s to several minutes before it reached another member. Seen between headless Ghostly on CI.
- Being in several communities with the same people costs the relays less. A device that is the door of several communities now checks them for newcomers about as often as it would check one, and a member connected in several reads their hub lists less often. In 4 communities shared by 3 people, the member's idle relay requests drop from 24 to 8 a minute, and each hub's from 76-100 to 66. Someone who opens a community's link is still let in within seconds.
- "Delete from this device" on a community you are in now asks the group's own question: it says that deleting also leaves the group, that the group's link brings you back, and who becomes the admin if you are the admin. While nobody is connected to take the leave, the button waits and says why. Before, it asked "Delete chat?" and spoke of "your contact's copy", as for a chat with one person, and a refusal showed only after the dialog had closed.
- A community whose other members never open the app again can be deleted from the device: with nobody connected to take the leave, Delete from this device goes ahead for a member and says the others will still list them. Leave, and an admin's delete, still wait for someone to be online.
- A large group with a link no longer gets stuck when its member history fills up: it stops taking new members, new links and new keys while there is still room for everyone in it to leave, be removed or hand over the admin role. Before, a full history kept a member who left in everyone's list for good and the admin could not remove anyone or leave.
- In a group with a link, when one of the apps that connect the members leaves shortly after someone joined, the members it connected are taken by another one sooner. Before, that app could still be waiting for the newcomer, whom the other had already let in, and looked for the members asking it only every half minute.
- People who share several communities no longer see some of them stay unconnected for minutes. A device that was a hub of several communities spent the relays' allowance on idle checks of each community's door, lobby and hub list, and the connections its members needed in the other communities got what was left: with 4 communities on one relay, or 8 on two, some stayed down for 10 minutes and more, and messages sent there reached nobody. A hub's idle checks now wait while connections are being set up. They keep their pace while someone is coming in.
- Knocking to get back into a community you were removed from never said the link may have been replaced: after two minutes it now says so, as a first join does. Cancel joining there also hands the keyboard focus to the group's menu instead of dropping it.
- In a community, what a member wrote just before leaving now reaches the members who were away when they open the app again. Before, they came back to "… is no longer a member" without that member's last messages, while those who were online had read them. A removed member's messages still do not reach them, and nothing a member sends after it left is shown.
- Someone removed from a community who opens its link to get back in is still listed with the group as they kept it (who was in it, its status) while they wait to be let in, and `ghostly group decline` then stops asking and keeps the group and its history. Before, the group was listed as a bare invitation while waiting, and the only ways to stop were to leave or delete it, which removed the history.
- Removed from a community and waiting to be let in again through its link, you still read the history you kept: the wait is a line above it ("Waiting to be let in"), and Cancel joining there only stops asking. Before, a join card covered the history for as long as nobody answered, and Cancel joining deleted the group and its history from the device without asking.
- Back in a private group, a member's missed messages are put in the order they were written once all of them have come, not again with every page of older ones: catching up 200 messages from one member rewrote each of them up to 84 times, and the newest jumped down the chat page after page.
- Back in a private group, putting a member's missed messages in the order they were written saves them to the device in one write each time, not one write per message: catching up 200 messages from one member held the CLI for seconds of disk syncs.
- Back in a private group, each member's messages you missed read in the order that member wrote them, and the chat ends on their newest. When many came from one member, their newest showed first or among the older ones, and the last line was an older message.
- Back in a private group twice within a minute (a phone that slept, woke and slept again), you read what one of the members wrote meanwhile in its place among the others' messages. Their messages could come in on their own, out of turn.
- Back in a private group, the messages you missed from one member come in about a minute every time: when your app happened to ask that member first, it waited a whole extra minute before asking anyone else for the older ones, so 256 missed messages took over two minutes in about half the returns.
- Back in a private group, you read what you missed in the order it was written even when the first member your app reaches had been away as well. Each member's messages then came in on their own, one member's after another's.
- Back in a private group after a while, you read what the others wrote meanwhile in the order they wrote it, the newest message last. With several members writing, each member's messages came in on their own and out of turn, and the newest ones sat above older ones, out of sight on a phone until you scrolled up.
- Back in a busy private group after a long while, on a phone, you read the hundreds of messages you missed in the order they were written. Past ten seconds of catching up, the members' newest messages came in above older ones still on their way.
- Declining a group invitation while the person who invited you has Ghostly closed now reaches them when they are back. Before, the answer was lost: in their Members list you stayed "Invited…" for good, they could not invite you again, and you held one of the group's 32 places.
- Someone whose welcome to a private group was lost on the way, and who then tapped Decline, stayed in the admin's member list for good, offline, and could not be invited again. The admin's app now takes them out when their decline comes.
- Deleting a group you are no longer in (removed, knocking to get back in) or an invitation asked "Delete chat?" and spoke of your contact's copy. It now says "Delete <group>?", that the group and its history go from this device, and, for an invitation, that its sender is told you declined (and, for an invitation back into a group whose history is kept on the device, that this history goes too).
- Leaving or deleting a group, or calling off a join, now also removes what you had typed in it and not sent, so it does not come back in the field after joining the same community again.
- An app in private groups no longer checks the signature of each group packet it has just signed on its way to the relays, as 1:1 chats already did not: about 200 ms of CPU a minute for a member in 5 groups of 7 under traffic.
- Editing a message in a group no longer gets slower as the group grows: an edit reads the edited message, not the group's whole history. A bot that updates a card in place in a group read the history once for every update.
- A member of a private group who was away while someone edited many messages (a bot closing dozens of task cards) now gets every one of those edits when it is back, not only that member's latest sixteen: cards that were closed no longer stay as running on its Tasks board.
- A member of a community who was away while someone edited more than thirty messages (a bot closing dozens of task cards) now gets every one of those edits when it is back: the ones past thirty in ten seconds wait a moment instead of being dropped, so closed cards no longer stay as running on its Tasks board.
- A file or voice message in a group now comes from any connected member that has it, however old it is. Before, in a group with more than 32 files, an older one could wait as "Nobody you are connected to has this file yet" until the person who sent it was back online, even though someone connected had it. This showed after an app had started again (an update, a reboot), for a member back from away and for a Download of an older file alike.
- A group file you paused still reads paused after the app starts again, with how much of it came and Resume. Before, it read "asking, 0 B" with Download, though what came was still on the device.
- In a busy private group, every member the sender's app turned away as busy asked each of the other members for a new file they could not hold yet: one file to 16 members cost about 170 useless requests, and six photos sent together about 1,600. A member turned away, or with a file still waiting its turn on the sender's connection, now waits for the sender's (or a new holder's) word that a place is free, and asks the other members only when no known holder is in reach.
- A member back from away in a busy group no longer spends tens of seconds of the app's time asking for the files it missed. Each file that ended asked every file still waiting again, and reported every unchanged row to the app: 450 small files from 15 members cost 1.1 million asks. Now a file that ends asks only the files it frees a member for, and a row is reported when it changes.
- A member back from away in a group of 10 or more members no longer spends seconds to tens of seconds of the app's time asking for the files it missed. A member that holds none of the files (automatic downloads off) or serves none, or a holder every waiting file had already asked, still sent every waiting file back to asking at each file that ended. Now a waiting file is asked again only when a member it can still ask is free.
- A running app no longer keeps a finished entry for every group file it fetched or sent since it started (38 entries after 38 files), each carried by every update it made until it was started again. A group file that arrives all here, or that this device sends, now says it is done once, then reads as done from what the device keeps of it.
- While a file moves, the app no longer does more work for every group file the device already has. Each update it made of a transfer's progress (about 24 a second) carried a finished entry for every group file kept on the device: 0.4 ms and 36 KB an update with one file, 3 ms and 2.4 MB with 20,000. A group file that is all here now shows no transfer, and reads as done from what the device keeps of it, as before; the CLI's `file list` and `file accept` read it the same way.
- A member back from away gets every file a member sent to the group meanwhile. Past the first 30 from one member, the files showed as a line of text asking to update Ghostly, with no file and no Download. Now each one is a file with a Download.
- Several files sent together to a private group reach every member as fast as the connections carry them. Before, only the first went at once: for each of the others, the members who were not served first waited up to 10 seconds to hear who had it, so six photos took about 20 seconds to reach a group of 16 that gets one in a second.
- Texting in a group no longer costs more with every file the group has had that this device did not download. Each update the app made carried a waiting entry for every such file (with automatic downloads off, every file of every group; with them on, every file over 8 MiB and every one past the group's 256 MiB): with 5,000 of them a CLI daemon used 30% more CPU for the same texts, with 20,000 over twice as much. A group file waiting for its Download now shows no transfer once the app has heard of it, and its bubble reads it from what the device keeps of it, with its Download as before; the CLI's `file list` reads it the same way, and `file.offered` still comes when the file is announced.
- In a group, messages of a member that never arrived and that nobody holds any more are asked of each connected member once, as meant: they were asked for again every time their author wrote something new, a minute apart, for as long as the group was busy.
- A group that goes from the list without Leave or Delete (an invitation declined from the chat list, one taken back, a join that ended) no longer leaves its unsent text, read mark, mute or folder behind. Joining a community again no longer shows an old draft.
- Accepting a group invitation from its own page with the keyboard moves the focus to the group's ⋮ while it joins, and to the message field once it is in (with a mouse or trackpad). Accept went away with the answer and took the focus to the top of the page, so the next Tab started again at the back button.
- Decline on a group invitation, or Delete on one its sender took back, from its row in the chat list or from its own page, moves the keyboard focus to the next row of the list, or to New after the last. The focus was left on the page itself, so the next Tab started again from the top.
- "Delete from this device" on a group invitation now tells the person who invited you that you are not joining, as Decline does. Before, they were told nothing: you stayed "Invited…" in their Members list for good and held one of the group's 32 places.
- An invitation to a private group accepted after the group was deleted, or after whoever sent it stopped being its admin, no longer says "Joining…" for good: the inviter's app answers that it cannot let you in, and the invitation goes from your list.
- An invitation to a group, opened from its row (on a phone the only way in), now shows who invited you and to what, with Accept and Decline, in place of an empty chat with a message field that took nothing. Search and Move to folder are gone from its menu until you join.
- An invitation to a private group that its sender took back (the group deleted, or the admin role handed on) went from the list without a word, even right after you tapped Accept, and an open invitation turned into "This group is gone from this device." It now stays a while as "Invitation taken back", says who took it back and to ask them for a new invitation or the group's link, and can be deleted.
- An invitation to a private group you accepted, whose inviter's app never answers, offers Accept and Decline again after a few minutes and says the app did not answer, instead of "Joining…" with nothing to tap.
- An invitation to a private group goes from the invited person's list when whoever sent it deletes or leaves the group, or makes someone else its admin, instead of staying there with Accept and Decline that lead nowhere.
- A contact you invited to a private group who has not answered in a week no longer stays "Invited…": the Invite button comes back, and the invitation stops holding one of the group's 32 places. Before, an invitation whose answer never reached you stayed pending for good.
- A member who leaves a group on their own is now announced as "Bob left", not "Bob is no longer a member", the words of a removal by the admin.
- Leaving or deleting a group with a long history no longer takes longer and longer: its messages go from the device in one step, not one at a time. On the CLI a group of 2,000 messages took over a minute to leave.
- In a private group, what a member wrote just before leaving now reaches the members who were away when they open the app again. Before, they came back to "… is no longer a member" without that member's last messages, while those who were online had read them. It needs the admin's app to be on this version. A removed member's messages still do not reach them.
- A member back from away reads "… joined", "… is no longer a member", "… is now the admin" and "Keys rotated" among the messages of their moment, as the members who were there read them: a member's goodbye shows above "… is no longer a member", and "… joined" below what was said before they came, in private groups and communities. Before, each such line went above everything the catch-up brought.
- A group's link: "New link" and "Turn off" ask first, saying that the link shared so far stops working for good. One tap, next to Share and Show QR, used to end it with no way back.
- Cancel or Escape on a group link's "Make a new link?" or "Turn the link off?" question puts the keyboard focus back on the button that asked (New link, Turn off). It fell to the page, so the next Tab started from the top.
- In Arabic, a group's link field shows the start of the link (https:// and the site), as it does in other languages, not its last characters.
- A group's link, with the keyboard: after "Turn off" the focus is on "Turn on the link", and after turning it on, on Share. It used to be lost, so the next Tab started from the top of the dialog.
- A group member's connection that was dropped the moment it was answered, or whose offer the other app had already given up, is no longer taken for a network that blocks direct connections. Before, the link left WebRTC until the app restarted, and a member on an older version, which has WebRTC alone, was never reached again. Seen between two headless Ghostly on one busy machine.
- The admin of a private group with a link spent a key derivation for each such group every time the app's state was built (up to 20 times a second): about an eighth of a busy CLI daemon's time. The link's key is now derived once, when the link is made or replaced.
- On a phone the Members dialog's Share, Copy and Show QR for the group's link are a thumb's height (44 px), as New link and Turn off beside them already were. They were 24 to 28 px tall.
- A group's link on a phone: "New link" and "Turn off" are a full thumb's height and sit on a row of their own, under Share, Copy and Show QR. They used to be small text buttons one mis-tap from Show QR.
- Someone who joins a private group with its link and whose welcome was lost on the way (their phone locked as the admin's app let them in) now gets in when their app knocks again, instead of waiting on "You are in in a moment" for good.
- The open Members list of a large group or community no longer draws every member's row again each time anything changes in the app. A row is drawn again only when its own member changed (their name, their connection, their role). Before, with 256 members the whole list was drawn again on every change, up to 20 times a second.
- A message received in a private group now writes about its own size to the device. The group's record no longer holds the last 256 messages kept for members who were away (60 to 260 KiB, written again for every message, most of what a busy CLI daemon wrote to disk): each is kept with its own message. A group from before keeps handing on what its record held, which leaves it as newer messages come.
- A private group no longer writes its whole record to the device for every message received. Messages that arrive together (someone back in a busy group taking 250 of them, a lively conversation) are now one write a second at most: the record holds the last 256 messages kept for members who were away, 100 to 260 KiB each time, so a catch-up wrote tens of megabytes and held the CLI for seconds.
- A group's member list no longer keeps "N missing" beside a member for messages nobody holds any more (a member keeps its own last 32 and the group's last 256): once every connected member was asked for them and none had them, they stop being counted. The count stayed until the group's members changed, as if those messages were still on their way.
- A group name with nothing visible in it (a zero-width space, a direction mark) could be typed into New group and Rename, and was then refused in English in every language, saying "1 to 64 characters" to someone who had typed one. Create and Save now stay off for such a name, and a name, picture or hub setting the group refuses is said in the app's language.
- Web app, extension and CLI: a group member reached over Iroh no longer waits for "a free connection on this device" once four others are. These apps now hold up to twelve Iroh connections for group members (four before, a limit that belongs to the Desktop app only), so in a group with five or more members that connect this way, every one is connected and none gets its messages late through the others.
- Opening the app after some time away from a community no longer loses reactions. When one member had reacted more than 30 times meanwhile, only the first 30 were shown and the rest never appeared on that device, so people saw different reactions on the same messages. The rest now show a few seconds later.
- Back in a private group, a message you write while the older ones are still coming (a reply to the newest line) stays below the lines that were above it when you wrote it: once the older ones came, it ended above the whole conversation it answered. A line of yours moved down with them still shows the time you wrote it.
- An open group or community with many members and a long history no longer works its whole history over each time anything changes in the app (a message in another chat, a connection coming up). Before, every such change named every member again for every message: with 256 members and 12,000 messages the open page lost about 50 ms to it, up to 20 times a second.
- Turning a group's link off from the Share link screen no longer closes the screen without a word: it stays, says the link is off, and offers to turn it on again. The screen also no longer opens by itself when the link is turned on later from the members.
- Someone who accepted an invitation to a private group and closed the app (or lost the chat) while the admin's app was letting them in could wait on "Joining…" for good: the admin's app had added them, but the welcome never reached them and was never sent again, and the admin could not invite them again. Their app says its accept again, as it does, and now gets the welcome (sent again at most every half minute, so an app that keeps saying its accept cannot keep the admin's app busy sending it).
- A contact's group invitations that were taken back no longer pile up in the chat list: each contact's chat keeps its four newest, and older ones go, so a contact that invites and takes back over and over cannot fill the list for a week.
- Handing a private group's admin role over, or leaving it as its admin, now says that the group's link shared so far stops working and the new admin can share a new one.
- On a contact's invitation to a group, the line under the name and the group's picture no longer open a "0 members" list, and ⋮ no longer offers Members… or Mute notifications…: only Delete from this device. The card still says how many members the group has. Before, the list said "0 members" (with the group's read rules) under an invitation that said 3.
- An app with many live chats no longer spends the relays' requests that its groups need on keeping those chats up: with 30 live chats, people joining a group by its link waited from over a minute to nine minutes to get in.

**Wallets**

- In the extension and the desktop app, Open in wallet on a `bitcoin:` link whose label or message has ' ( ) ! * or ~ (such as "Bob's shop" or "Thanks!") said "Couldn't open a wallet". The link now carries those characters percent-encoded, and the wallet opens.
- An ecash token or ecash request in a message says which money it is, as every other money card does. Ecash of a test mint read "1,000 sats" with no "Test money" tag; it now carries the tag and reads "test sats". "Real money" is said for a token of one of the wallet's own mints and for a request to be paid at real mints.
- Fedimint wallet: the History of a federation with no movement says "Nothing yet" (it was an empty box once another federation had one), a row's fee is written like its amount ("fee 1,500", not "fee 1500"), and notes taken back say so under Send instead of showing under Receive as notes redeemed.
- Copy on money in a message (a Lightning invoice or address, an ecash token, a Bitcoin, Ark or USDT address, a BOLT12 offer) says "Copied" only once it is copied. When the browser refused the copy, the button still said "Copied" while the clipboard kept what it held before, which could be another address. The card now says it could not copy and shows the text to select.
- With a long history of reviewed payments, the check that runs every 10 seconds for payments still on their way no longer reads every payment ever reviewed: it reads the ones whose outcome is still open, usually none. At 2,000 reviewed payments that was about 9 MiB read from the database every 10 seconds while the app sat idle.
- A payment's two ticks, and a request closed because its wallet was removed, read the payment's own message instead of the chat's whole history.
- A chat takes at most twenty new payment requests a minute from its contact, and keeps at most fifty of them waiting to be paid. One left out is not lost: the contact's app sends its open requests again each time the chat connects, and it comes in once there is room. Before, there was no limit to how many a chat stored.
- With a long history of payments, the app no longer copies every payment it keeps each time anything changes on screen (typing, a file's progress, a contact coming online). The copy is made once when a payment changes and used until the next one does: at 2,000 payments, about 9 ms less work on each of those updates.
- In the Spark wallet's history, a fee is written like the amount beside it ("fee 1,500", not "fee 1500"), and a movement that is pending or failed says so in the app's language instead of in English.
- With no wallet, or a wallet whose balance has not moved, the app no longer rebuilds its wallet view every 15 seconds. The balance is still read every 15 seconds, and the view changes when the balance, an error or a payment does.
- A wallet card lists only its own network's payments: the Mainnet USDT card no longer shows the Testnet wallet's ("1,000 TEST-USDT · confirmed"), and the same for Ark, Bark, Spark and on-chain.
- Ecash a contact sent whose coins the mint holds pending (in a payment of theirs) is now refused at once, with "Could not receive…" in the chat and the contact told, instead of being kept and asked about every 30 seconds for good. A redeem that stays pending after the mint stopped answering is asked about every 10 minutes and let go after an hour.
- The same ecash sent again under another note is now one redeem: it is refused with "This ecash is already being received" instead of counting again in the sats on their way (20 copies of a 1,000-sat coin showed 20,000 sats, in the wallet, Remove wallet and the device move). A redeem that ends without the ecash now says "Could not receive N sats" in the chat too.
- Sending or redeeming ecash at a mint no longer waits while the wallet checks every unfinished swap there with a slow mint: it waits for one check at most.
- Web app: the first time a wallet (or the Iroh connection) loads after an update, its code is compiled while it downloads again. The service worker used to hand the file to the page only once all of it (2 to 12 MiB) was saved for offline use, so the compile started after the last byte. Slow phones gain the most.

**Calls**

- In a video call to a contact that takes no picture (a bot on the headless Ghostly), the camera button stays, so you can turn your camera off without hanging up. Before, the camera stayed on for your own picture the whole call, with its light on and, on Ghostly Desktop for Linux, about twice the call's processor use.
- A video call to a bot (a contact on the headless Ghostly) no longer uploads your camera. The bot shows no picture, but the app sent it the whole call, about 20 times the data of the voice; the same for a camera or a screen turned on during the call. You still see your own picture.
- The reason a chat's call buttons are turned off reads in the app's language. Pointing at them said "Calls need a live connection", "Your contact's app cannot take calls" or "Your contact needs an updated Ghostly for calls" in English in every language.
- A call started with the keyboard keeps the focus. The whole-screen call takes it when it opens and Tab stays on the call's own buttons; it used to walk nine controls of the chat hidden behind the call first. When the call ends, the focus is back on the Audio call or Video call button that started it, instead of at the top of the page.
- In a call with a contact on the command line (a bot, an agent) or on an older app, the call window now says "Reconnecting..." as soon as the connection is lost. It kept saying the call was connected, with the clock running, for about 30 seconds, and then the call just ended.
- On a phone, the notices at the top of a chat during a call ("Waking Ana for the call…" with its Cancel, "No answer") are as wide as their words, up to the screen. They used to be squeezed into half the screen, on three or four short lines. In the app installed on an iPhone, these and the other notices at the top of the window (a blocked microphone, "Your phone paused the mic", a link that could not be used) now sit below the status bar instead of behind the clock.
- The "Incoming call" notification now goes away when the call is answered, declined or given up by the caller (Linux, Android and the browser extension). Before, it stayed in the notification list and still said a call was coming in.
- On the Linux Desktop app, a video call with a bot that takes no picture no longer encodes and uploads your camera, and the camera button is off as in the other apps.
- Desktop on Linux: the contact's picture in a video call no longer stays blank for the rest of the call when one picture is lost on its way to the call window, or one takes too long to decode. The pictures after it now show within a second.
- Desktop on Linux: in a video call, the picture of a contact who sends 30 a second is shown 15 times a second, evenly. It was shown about 12 times a second, in uneven steps.
- Desktop on Linux: a video call no longer makes a JPEG of every picture the contact sends. The page is shown at most 15 a second and a browser sends 30, so more than half were scaled, made a JPEG and then thrown away. They are now left out as they are decoded. Showing a contact's 640x480 picture took 6.6% of a core and now takes 3.0%; at 1280x720 it took 37% and now takes 23%.
- In a call, why the screen could not be shared (the line over the controls) and why the share button is off (its tooltip) now read in the app's language. They were English in every language, the first one included: the one macOS shows the first time a screen is shared, with the next step.
- On a phone, the small call window's state line no longer runs under its corner button. In Portuguese "Chamada de áudio 00:05" started behind the button, which covered its first letter; the line now starts after the button, and when the window is too narrow for the words it keeps the clock.
- Calling a contact whose app is closed, then opening another chat or Settings while it says "Waking <name> for the call…", no longer drops the call without a word. The wait goes on wherever you are, with its Cancel on screen, and the call is placed in its small window once the contact's app is up. Before, the wait was forgotten, no call was placed, and the contact's phone had already said "Incoming call".

**CLI**

- `wallet add-mint` with something that is not a URL, or a mint not on https, answers code `bad_request` with the same words ("That is not a valid mint URL", "Mints must use https"), as `service add` does. Before, it answered `engine`, which a bot reads as the engine failing and may retry.
- `ghostly profile restore` of a folder says the path is a folder and asks for a file, instead of Node's "EISDIR: illegal operation on a directory, read", and `ghostly profile backup --out` into a folder that does not exist names that folder, not a temporary file you never typed.
- `ghostly button update` and `ghostly button press` read the one message they name instead of the whole history of the chat or group.
- `ghostly call answer` sends the answer at once. The daemon now prepares the answer while the call rings, so answering no longer waits for the network check that came after it. That check takes tens of milliseconds where the STUN server replies, and 2 s on a network that blocks it. A declined or missed call closes the connection it prepared, and nothing is sent or heard before the answer.
- A call from or to the CLI on a network where the STUN server does not answer (UDP to it blocked, as in many offices and hotels) rings after 2 seconds and connects 2 seconds after the answer, not 5 and 5. `call start` returns that much sooner.
- A `ghostly daemon` whose output nobody reads any more (the process that started it was killed, or the pipe it wrote to closed) no longer takes a full processor core and stops on SIGTERM again. It used to report each failed write with another write that failed, without end, and answered no command.
- `ghostly daemon --detach --timeout <s>` (and `daemon restart`) shorter than the daemon's start no longer says "The daemon did not start" while the daemon it started keeps running: it says the daemon is still starting, with its process id (exit 4). A `--timeout` of 0 or less on `daemon`, `daemon stop` and `daemon restart` is a usage error.
- `ghostly daemon --help` and `ghostly help daemon` show `daemon`'s own usage and options (`--detach`, `--timeout`) first, then the commands under it. Before, only the list of daemon commands was shown, and how long `--detach` waits was in no help. A group of one command says "1 command".
- `ghostly delete` and `ghostly forward` read the messages they name, one row each, instead of the whole history of the chat or group (and `forward --wait sent` no longer reads the target chat's whole history per message forwarded).
- `ghostly group edit`, and an `edit` the engine refuses, read the one message they name instead of the whole history of the chat or group, which held the daemon about 120 ms at 10,000 messages.
- An empty `--profile` (a script's `ghostly -p "$BOT" …` with `BOT` unset, or `--profile=`) ran the command as the current profile, so a script meant for its bot could send, make invites and change settings as the person's own profile. An empty `--home` (or `GHOSTLY_HOME`) used the current folder and made a new profile there. Both options are now a usage error when empty, and an empty variable counts as unset.
- Files a bot sends at once (`file send` run in parallel, or many requests on the daemon's socket) are each their own message in its chat. Before, files sent in the same millisecond shared one message: the sender's chat and `file list` kept only one of them, and the others were not sent again after a drop.
- `ghostly -p` and `ghostly --home` with no value say `--profile needs a value` (or `--home`), a usage error (exit 2) as `ghostly send -p` says, instead of printing the whole help with exit 0.
- A global option before the command (`--pretty`, `--profile bot`, `--home dir`) no longer changes an option whose value is `--`. Before, `ghostly --pretty profile set --name --` set the name contacts see to `--pretty`, and `ghostly --pretty edit <chat> <message> --text --` sent `--pretty` as the new text.
- `ghostly group join <word>` with something that is no link to a group answers `bad_request` (exit 1, "This is not a link to a group") as `ghostly invite join` does for a word that is no invite, instead of an engine error.
- `ghostly help help` shows how to use `help` instead of `Unknown command: help`, and `ghostly version --pretty` indents its answer as every other command does.
- `--help=true` shows the command's help as `--help` does, and `--help=false` runs the command. Before, `--help=true` ran it, even `chat remove --yes`.
- A global option's `--no-` form may come before the command, as the option itself may: `ghostly --no-pretty status` answered "Unknown command".
- `chat history`, `group history` and `wallet history` take only a whole number for `--limit`. Before, `--limit 1.5` on a chat or a group answered code `engine` (as if the engine had failed, which a bot may retry) and `wallet history` took it; now each answers `bad_request`, "limit must be a whole number from 1 to 10000".
- `settings set iceServers` takes a server as WebRTC writes it, with `urls` a list (`[{"urls":["stun:…"]}]`), and a server without `urls` is refused with what to write (`bad_request`). Before, both failed with a JavaScript TypeError as the message.
- `ghostly identity add nostr --field bunker=...` uses the remote signer (NIP-46) without `--signer nip46`. Before, the CLI picked the browser extension signer (NIP-07) first and failed with "No NIP-07 signer in this window". `identity providers` no longer marks NIP-07 and AT Protocol as `headless`; asking for them says to make the proof in the app. A subject the provider cannot read, or more days than it allows, is now a `bad_request`, not an `engine` error.
- A daemon no longer keeps an invite nobody joined as the chat on screen for good: once its 10-minute wait for a peer is over, it is read at the background pace like the daemon's other invites. Before, that last invite was read about 11 times a minute forever and held the other invites' reads back, so a join on an earlier invite of a daemon with many unused ones was noticed only after 3 to 7 minutes.
- A daemon reads a contact that is away at the same slow pace as its other chats. The chat of its last `invite create` or `invite join` stayed the chat "on screen" for good, so while that contact was away the daemon read it 2.5 to 3 times as often, about 18 of a Pkarr relay's 30 requests a minute. It now stops once the chat is paired.
- `ghostly listen --cursor <file>` whose folder does not exist, or cannot be written, is refused at once (`not_found`, exit 3, or `refused`, exit 1), before the profile is opened. Before, it started and ran: each event printed "event N failed: ENOENT" on stderr, the cursor was never written, and the next start skipped what came while it was down.
- `ghostly listen` refuses words it does not take (`ghostly listen bob`, `ghostly listen message.received`) with "Too many arguments" and its usage, exit 2, as the other commands do. It started a listener of every chat's events.
- `ghostly listen` whose output nobody reads (a consumer that hung), or whose `--exec` or `--webhook` falls behind, no longer keeps every event it cannot pass on in memory: it grew by about 2 KB per event without a limit. It now stops taking events about a thousand events ahead and goes on from the last one once its output or hook catches up. Meanwhile the daemon's event journal keeps them, as for a listener that was not running, and `events.gap` says if any are dropped.
- A profile's messages and their indexes are kept on disk (`rows.db` beside the store) instead of in the daemon's memory: a daemon's memory no longer grows with its history (50,000 messages: 0.3 MB of heap instead of 62 MB, about 63 MB in all instead of 186 MB), and its store opens in 5 ms instead of 0.3 s. On disk a message takes about 1.3 KB. The first start after the upgrade moves them once (about 1.7 s at 50,000), straight from the store's file to `rows.db`, without holding them in memory on the way. Needs Node 22.13 or newer; on Node 22.12 nothing changes. Once moved, the profile no longer opens with an older ghostly; a backup (`profile backup`) restores with any release. A deleted message or chat leaves no readable copy in `rows.db`: SQLite zeroes the space it frees.
- `call list`, `call auto` (with no on or off), `app served`, `identity providers`, `identity contact`, `service peer` and `profile backup` with no daemon running now read the profile offline too, as `status` does, in a fraction of a second and with nothing sent to the Pkarr relays. Each took 3 seconds with a slow relay. A `profile backup` with no passphrase given now says so before it opens the profile.
- A command that takes a chat or a group (`pin`, `forward`, `task send`, `routine send`, `usage send`, `button press`, `file send`) and is given a name neither has now says `No chat or group "<name>" (ghostly chat list, ghostly group list)`. Most of them said `No group`, though the name may have been a chat's.
- On Node 25 and newer, a command that opens a profile no longer prints "ExperimentalWarning: localStorage is not available" on stderr. With `--localstorage-file`, Node's storage is used as before.
- `ghostly service enable`, `service remove`, `service share`, `identity remove`, `identity withdraw`, `identity cancel` and `message retry` answer `not_found` (exit 3) for a service, an identity proof, a draft or a message that does not exist, naming it and where to look (`No service "nope" (ghostly service list)`). Before, each answered as done with exit 0: a mistyped service id read `"shared": true` with a contact.
- `payment check`, `payment reclaim`, `identity share`, `identity recheck`, `lightning default` and `lightning rename` answer an id that names nothing as `not_found` (exit 3) with the list to look in, as the other commands do. Before, each was an engine error (exit 1).
- Without a daemon, `ghostly chat remove <chat> --yes` on a profile's only chat really removes it: it answered `{"removed":…}` and the chat, its keys and its whole history were still there for the next command. The same for `service add` on a profile with no chat, and for `chat rename`, `message delete` and the `service` commands while the relays cannot be reached: what a command answers is on disk before it leaves.
- `ghostly settings set constructor 5` (or `toString`, `valueOf`, `hasOwnProperty`) is refused like any other name that is no setting. Before, it was accepted and the value stayed in the profile's settings for good. The same names are no longer taken for a transport (`chat transport bob constructor` handed the engine a function), for a command (`ghostly constructor bob hi` opened the profile and answered "No method undefined") or for a method of the daemon's socket, where `constructor` never got an answer.
- Payments and requests a bot makes at once (`chat pay` or `chat request` run in parallel, or many requests on the daemon's socket) are each their own message in its chat. Before, two of them made in the same millisecond, or one of them and a file sent then, shared one message: the sender's chat kept only one of them.
- `ghostly react <group> <message> <emoji>` says the name is a group's and how to react there (`ghostly group react <group> <message> <emoji>`), instead of `No chat "<group>"`.
- A command that only reads (`ghostly status`, `chat list`, `chat show`, `chat history`, `settings get`, `group list`, `wallet list`, `events` and the like) answers from the profile in a fraction of a second with no daemon running, and says nothing to the network. It used to start every chat, publish to the Pkarr relays and wait for them: 3 seconds with a slow relay, 10 with one that did not answer.
- `ghostly profile restore` on a file that is no Ghostly backup (a wrong file, an empty download) says "This is not a Ghostly backup" at once, with or without a passphrase, instead of asking for one. A backup that is encrypted and given no passphrase now names restore's own options, not backup's `--no-passphrase`.
- Reading a whole chat from `rows.db` no longer copies every message a second time after reading it from disk: a chat of 10,000 messages reads in 135 ms instead of 194 ms (50,000: 669 ms instead of 894 ms), close to what the store in memory took. Each message a daemon sends reads its chat, so sends in long chats get faster too.
- `routine send/update --next`, `usage send --resets` and `--also`, and `chat/group history --before/--after` refuse Unix seconds with the milliseconds they mean (exit 2). Before, seconds were taken as milliseconds: a card was dated January 1970 and a history page came back empty or whole. A history cursor of digits is now always a time, so `--after 0` reads from the start instead of answering "No message 0".
- A long-running daemon no longer keeps a note in memory for every message of its history: the record of what `listen` reported forgets a message 30 days after its last activity (its arrival, an edit, a reaction), unless it is one of yours not delivered yet. An edit or a reaction to an older message is still reported. The first start after the upgrade reads each chat's history once.
- `send --reply` to a message the chat does not have is `not_found` (exit 3), as `file send --reply` and `group send --reply` say. Before, it was `refused` (exit 1) with the same sentence.
- The CLI starts faster on a profile with a long history: it reads its record of the messages already reported in two requests instead of one step per message. With 100,000 stored messages that step took about 2 seconds of every `ghostly daemon` start, and of every command run without a daemon; it now takes about a tenth of that.
- `settings set iceServers` with a `turns:` or `?transport=tcp` TURN server warns on stderr that the CLI does not use it: the CLI reaches TURN over UDP only. The apps still use those servers. Before, the CLI skipped them without a word.
- `ghostly version` and `ghostly --version` answered the version for anything after them, so a typo such as `ghostly version --json` looked like it worked. They now refuse a stray word or an unknown option with a usage error (exit 2), as every other command does.
- `wallet remove`, `wallet faucet` and `wallet receive` check the Lightning card `--card` names before anything happens: with a type of wallet other than `lightning` it is a usage error (exit 2), and a card that is not on the network is `not_found` (exit 3), as `lightning default` says. Before, `wallet remove cashu --card <a typo>` removed the whole Cashu wallet and answered that the card was removed.
- The CLI's wallet and payment commands answer a wallet or card that is not there with `not_found` (exit 3), a token or invoice that is not one with `bad_request`, a wallet that already exists with `refused`, and no mint or source with `unavailable`, instead of `engine` ("the engine failed"). A contact that cannot be reached is `unavailable` too, and `chat pay` and `chat connect` on a chat whose invite nobody took say so at once instead of waiting 15 to 25 seconds.
- A daemon no longer checks the signature of a discovery packet it has just signed, twice per packet: about 0.5 s of CPU a minute for a daemon with many chats at its relay budget, 70% of what it spent idle.

**Desktop**

- Desktop: Ctrl+N and Ctrl+, (Cmd+N and Cmd+, on a Mac) do nothing while a dialog is open. They used to make a new chat or open Settings behind it, and a dialog that belonged to the page (the files about to be sent, a new wallet, a new identity) was closed with what was typed in it.
- On Desktop, a chat over HyperDHT no longer loses messages without a word when the app hands it frames faster than the link carries them (a file or a mini-app sending to a contact on a slow link): each frame is now answered once its connection has room, so the chat's send budget counts it until then and files and apps keep to their share, and a frame that could not go is a failed send instead of one dropped unseen.
- On Desktop (and Android), a chat over Iroh no longer drops its connection when the app hands it frames faster than the link carries them (a file or a mini-app sending to a contact on a slow link): each frame now waits for room on the connection instead of being refused once 32 were queued, and the chat's send budget counts it until it is written, so files and apps see the real queue and keep to their share.
- On Linux, a notification server that stops answering no longer holds back every later message's sound and notification: the app does not wait for a notification before the next event, nor more than 5 seconds for a server that does not answer. When the server comes back, a chat still has one notification, replaced by its next message and closed when the chat is read.
- On Linux the unread count now shows on the app's launcher icon in the docks that show one (KDE Plasma, GNOME with Dash to Dock or Ubuntu Dock, Plank). The app sends it on the session bus itself; before, it went through Unity's own library, which no current desktop runs, so no count ever showed.
- On Linux, the right-click menu on a link no longer offers Open Link and Open Link in New Window, which only closed the menu. A click on the link still opens it in your browser, and Copy Link Location stays. The same menu's Open Image, Video, Audio and Frame in New Window items, which did nothing either, are gone too.
- On Linux, clicking a Ghostly notification brings the window forward and opens the chat (or the group, or the profile) it is about, as on macOS. Before, the click only closed the notification.
- Linux: after the desktop's notification server restarts (mako, dunst, swaync, a reloaded shell), a click on another app's notification no longer brings Ghostly forward and opens one of its chats.
- On Linux, while the notification server is not answering, notifications no longer wait in line, 5 seconds each, behind the ones before them: different chats' notifications wait side by side, and a chat's notification that a newer one replaces is not sent at all. Five notifications in that moment took 25 seconds to get through, and now take 10.
- On Linux, each notification given up on a notification server that stopped answering no longer leaves a D-Bus connection and a thread behind for good: the connection given up on is closed, and its click listener ends with it.
- On Linux, a chat's new messages now share one notification, which goes away once you read the chat in the app. Before, each burst of messages added another one to the desktop's notification list, and they all stayed there after the chat was read.

**Devices**

- On a device that is not the active one, "Use here" and "Not now" on the offer of a move, "OK" and "This is wrong" on the new device list, and "Start as its own profile" on a restored copy now say what went wrong under the buttons when it could not be done (the offer is gone, not enough space, the answer could not be saved). The same goes for "Not now" on the new device secret offer and "Let <device> try again" in Profile, Devices. Before, the buttons dimmed, came back, and nothing was said.
- The answer of "Check connection" on a device's row ("Answered in 12 ms", "No answer") no longer stays there for good: it goes after ten seconds, and at once when that device's link changes, so a row never says "Not connected" over an old "Answered in 12 ms".
- A move of your profile to another device stays on screen after its dialog is closed: Profile, Devices shows the steps and Cancel while it runs, also for a move the other device started with "Use here". Before, closing "Move to" left no sign of the move and no way to cancel it, and pressing "Move to" again said the other device could not hand over the profile.
- On a device left on "Not finished", Try again and Remove say what happened when nothing changes: "Not finished: your other device has not listed this one yet.", or why it could not be done. Before, the buttons dimmed and came back with no word.
- A device on standby no longer asks its engine for the handoff twice a second and for the device set every 3 seconds while its window is hidden: about 120 calls and 20 reads of the device record a minute, for as long as the app stayed open on the device that is not in use. It asks once when the window shows again. In front, an answer that says the same no longer draws the device list again every 3 seconds. Profile, Devices on the active device does the same.

**Web**

- On an iPhone, iPad or Mac in Lockdown Mode, the web app's "Ghostly can't run in this browser" screen now says that Lockdown Mode is the likely reason and that it should be turned off for this site, with the steps for Safari and for other browsers behind ⓘ. Before, it only listed what was missing and suggested another browser, which does not help on an iPhone because every browser there uses WebKit.

**Website**

- On a phone, a store app's long version or developer name ran off the screen in the app page's header, and a long developer name ran past its card on /apps. They now wrap inside, like the title and tagline.
- On ghostly.tools/apps, an app whose title or tagline is one long word now wraps inside its card and its page's header on a phone, in place of running off the screen.
- `ghostly.tools/apps` loads an app's page only when you point at, focus or touch its card. Before, every card on the screen asked the server for its page as the list opened, one request for each app. A click still opens the page at once.
- In Safari on a phone or an iPad, the wallet and identity cards on the ghostly.tools home page now sit in the middle of the screen, in place of shifting right so that the last cards, the arrows and the card's text ran past the right edge.
- The Developers page no longer downloads an extra 83 KB font at every visit only to draw the bitcoin sign on one small coin of its step scenes.
- At the end of every page on ghostly.tools, the sleeping ghost in the footer kept the whole page laying itself out and repainting 60 times a second for as long as you stayed there, more on longer pages (up to about 60% of a mid-range phone's main thread on a long WISP page). Its hem now rests while it sleeps; only its z's move.
- On a phone 320 to 349 px wide, the ghostly.tools home page now fits its first screen and its download panel to the screen, in place of cutting their text and buttons at the right edge.
- An invite link opened on /privacy, /terms or a missing page (a code pasted after the path of the page being read, or a mangled link) opens the join dialog. The code left the address there as everywhere else, but no dialog showed it, so the invite was gone with nothing said.
- Website: the last step of a home page chapter with four steps (finding each other) rests fully opaque after a click on its step bar, a Tab to it or a scroll that stops in it. Its copy and picture stayed at about three quarters, already fading out.
- `/developers` on ghostly.tools, on a phone: the negotiation demo that plays by itself keeps one height through its four scenarios. It changed height by up to 353 px every two seconds, so the text below it jumped while you read, and a link to a section below it (`/developers#path`, `#availability`) stopped 275 px past the heading.
- On a computer, the little ghost that follows the pointer on ghostly.tools kept the page laying itself out 60 times a second for 45 to 57 seconds after every time the pointer stopped, up to about 14% of a core on a long WISP page. Its float and its z's kept doing it about 30 times a second for as long as it was on screen. It now moves and floats without laying out the page, and rests a few seconds after it reaches its spot.
- On the home page, moving with Tab into a chapter of the story shows its first step at once. Before, the screen stayed black for one to two seconds while the chapter faded in, so a keyboard reader was often on the second step before the first one showed.
- The home page of ghostly.tools, with the keyboard: a step button of the story that takes the focus brings its chapter to that step. Tab from a chapter's last step button to the next chapter's first put the focus on a button nobody could see, on a screen that was black or had no words.
- On a phone narrower than 375 px, the "On this page" list of a WISP wraps inside its box. A heading that names a source file set the width of every entry, so on the public-profiles reference they ran past the box's border and off the screen.

### For developers

- The native Android app's e2e lane: Playwright specs in `e2e/android` drive the debug APK on an emulator with a web peer on the same machine (launch, New, chat, files and video, and the Android host's links, clipboard, notifications, share and sign-in deep link), run by Actions > Android e2e. The phone checklist is `docs/ANDROID-PHONE.md`, with `tools/scripts/android-phone-check.mjs` reading what a computer can from a phone on USB.
- The gate that lets a security fix release by itself now reads every lock file the repository ships from. The lock files of the Desktop's HyperDHT sidecar, of the HyperDHT relay for browsers and of Iroh for browsers were read as code: a branch that added a dependency to one of them, or took an existing one from another registry or a git repository, passed the "only versions may change" check, and their lines counted against the 600-line limit. With `SECURITY_AUTORELEASE=deps` a dependency fix in one of them was refused as a code change; it now ships like the others.
- The security autorelease gate refuses a `claude/security-auto-*` branch that carries commits of `dev` that `main` does not have. `dev` holds `main`, so a branch rebased onto `dev` passed the "on top of main" check, and a small unreleased diff on `dev` would have been released with the security fix.
- Call signals: an offer or an answer may say `vr: 0`, "this side takes no picture". The other side's app then closes its half of the video lane and uploads no camera or screen on it. Older apps ignore the field (WISP 601, PROTOCOL §4.4).
- Private groups (WISP 902): the admin's `remove` commit made on a member's own leave goes with `left`, the admin's signature that the member asked to leave, on the `group-commit` frame. Members keep it and hand it on with the commit. A removal the admin chose carries none.
- A private group's message from another member is stored with the frame it came in (`StoredMessage.frame`, on the group's newest 256 rows at most), ready to be handed on to a member who was away. The engine keeps it to itself: histories, pages of them and changes reach a page or the CLI without it. No new store and no database version change.
- A cancelled CI run on a pull request no longer wakes the merge train. Such a run says nothing about its commit (a newer push or leaving draft replaced it, or the train cancelled it when the pull request boarded a batch), and the run that replaced it wakes the train when it ends. In 23 hours, 46 of the 174 wakes by a pull request's CI came from a cancelled run, and the train ran in full for 29 of them with nothing to do.
- The merge train reads CI's runs on a commit, and each run's jobs, once per run of the train. For a queued pull request waiting on its fast tier it asked GitHub for the same runs list twice and for the newest run's jobs twice, 7 calls per pull request per run; it is 5 now, so a long line reaches the queue app's hourly budget later. The cancel of a boarded pull request's own CI still reads the runs afresh.
- The merge train only takes as a batch a pull request it opened itself: a `batch/<base>-*` branch with the batch mark now also needs the train's own login as its author and at least one pull request in the mark. Before, any branch of this repository with that name and a hand-written mark was merged once its CI was green, and an open one with a lower number made the train close its real batch every run.
- The merge train takes a pull request labelled `queue:priority` and not `queue` as in the line, first. Before, only `queue` put a pull request in the line, so one with `queue:priority` alone waited for good while the train found no base to run (three green flaky-test fixes sat for eight hours on 2026-10-09).
- The merge train counts a green CI run on a commit only when that run tested what the pull request's own files need. CI plans each run from the files changed against the base the pull request had then, so a second run of the same commit for another base could skip the heavy jobs, turn green, and land a pull request or a batch whose own CI was red. Such a run is now passed over and the run before it counts; with no other run the pull request waits until CI runs on it again.
- The merge train no longer rebases and pushes a lone queued pull request whose head branch is `claude/security-auto-*` (or `master`): it goes in a batch, like `dev`, `main`, `epic/*` and `batch/*` heads. A push to `claude/security-auto-*` is what the security autorelease ships once CI is green, and the train's rebase put `dev`'s unreleased commits on that branch.
- The merge train writes `[skip ci]` (and `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`) in round brackets in every commit message it composes. A queued pull request whose title or an earlier commit carried one made the batch's head commit hold it, so GitHub started no CI for the batch and the train rebuilt the same batch every 20 minutes for good.
- The merge train no longer stops for good on a pull request that changes a workflow. The queue app may not push a branch whose commits change `.github/workflows/` (its token has no `workflows` permission), so every run failed on that batch's push and the whole line waited. Now such a refusal takes the pull requests that change a workflow out of the line with `queue:failed` and a comment saying why, and the rest board without them.
- The dependency scan (`tools/scripts/security-scan.mjs`, the Security workflow) reads every lockfile that ships. It read the root's two and the site's, and skipped the Desktop's HyperDHT sidecar (56 packages), the HyperDHT relay for browsers (74) and Iroh for browsers (361 crates), which each have a lockfile of their own: a known advisory in one of them left Security green. All three are clean today. A test holds the scan's list to the repository, so a new lockfile is scanned or named as test-only with the reason.
- A security autorelease moves the web image's `latest` from the default branch: `security-autorelease.yml` dispatches `web-latest.yml` without `--ref main`, so the tag still moves when `main` does not hold that workflow yet.
- The website's Docker image builds again: its build context now holds the four Markdown files outside `docs/` that a WISP links to (the CLI reference, the proofs and providers lists, the e2e guide). Since the check that refuses a link to a missing file, the image failed to build while CI, which has the whole repository, stayed green. A test now compares the WISPs' links with the image's context.

**Apps**

- The engine takes `apps: "wire"`: a host that runs no mini-app offers apps/1 and answers the chat calls (`appId`, `appOpen`, `appClose`, `appSend`), with no store, no installed app and no app storage. No client uses it yet.
- Behind the apps flag: an app whose icon was shown no longer keeps its whole bundle (up to 16 MiB) in memory. The icon kept for the Apps page, chat cards and the composer's Apps was a view of the bundle's bytes, which held all of them. With ten apps of 8 MiB, drawing their icons kept 80 MiB. Now it keeps 16 MiB, the two bundles of the cache.
- Behind the apps flag: a running app's storage calls, file reads and the messages it sends no longer each read the app's installed record from the device's database again. It is read once and kept until it changes (an update, its publisher's revocations, an uninstall). A run of 172 such calls made 172 reads of the record, now 1.
- Apps: the update check keeps the revocation lists it has already checked, so an unchanged one is not checked again. What it keeps is now limited by size (16 MiB in all) and not only by count (64 files). One app whose publisher serves large lists beside its 8 sources, or a list that changes at every check, could make the page hold hundreds of megabytes until it was closed.
- Behind the apps flag: an app update check on the web app and on Desktop no longer freezes the page for seconds when an app's publisher lists thousands of revocations. They are checked a few at a time, and a list that has not changed since it was last checked is not checked again.
- Behind the apps flag: with three apps or more running at once, an app reading one of its own files no longer reads its whole bundle (up to 16 MiB) back and checks it again. The engine kept the checked bundles of two apps only, so each read pushed out the one the next app needed: a 2-byte or missing file cost 18 ms of reading and hashing. Now each running app that used its files in the last minute keeps its checked bundle, and a read takes well under a millisecond; a closed app's bundle leaves memory a minute after its last use once two newer ones are kept, also while another app keeps running and reading only its own files.
- Behind the apps flag: opening the Apps page no longer reads each store's whole record (its list of apps, up to 4 MiB) from the device's database eight times and writes it back although nothing in it changed. The records are read once and kept, and a store is written only when its list or its state changed. A running app's next call no longer reads every store again after a check.

**CLI**

- The secret guard on `task`, `routine` and `usage` cards reads a card's text as the card carries it too. A card's lines lose their invisible characters (a zero-width space, a soft hyphen, an escape) on the way, so a key one of them broke in two passed the guard and went out whole; now it is refused (exit 5) unless `--force`.
- `ghostly listen` reports what a contact's app says in a chat, for the apps the profile serves: `app.opened`, `app.closed` and `app.message`, each with the chat and the app's reference. Frames of any other app are not reported.
- `ghostly app open <chat> <ref|name>` opens a served app in a chat as a bot: the contact gets the app's card, unless their app is open there already, and the two sides can talk once both opened it. `app close` ends it.
- `ghostly app send <chat> <ref|name> <json|->` sends one message of a served app's own protocol to the contact's app, live only; when it does not go, the error names why (`not-open`, `too-large`, `offline`, `peer-closed`, `too-fast`).
- `ghostly app serve <bundle|url> --grant chat [--grant name]` serves an app as a bot: the signed bundle is checked as a client checks it, each permission it asks needs its `--grant`, and the profile then offers apps/1 to its contacts, with no app running and no store. `app served` lists them and `app unserve` removes one.
- `ghostly button update --chosen` with a button the message does not have lists the buttons it has ("That message has no button "maybe"; its buttons: yes, no"), as `button press` does. It said "Buttons: chosen names one of the buttons".
- Calls: a program's audio stays at real time while the daemon is busy for a long stretch, such as sending a large file during the call. Every frame that is due goes out when the daemon gets to it, and after a stall of more than a second what the program wrote during it is dropped. Before, the contact heard the program about 2 s late for the rest of the call after a 200 MiB file.
- `call auto --from <chat>` or `--rate n` without `on`, and `call auto off --from <chat>`, are a usage error (exit 2) that says they go with `on`, where they changed nothing without a word.
- Calls: a headless call no longer runs its Opus encoder on every silent frame. Once silence has encoded to the same packet for half a second, that packet is sent again every 20 ms until the program's audio is back, so the contact receives what it did before. A call where the program only listens used 5.0% of a core at 48 kHz and 4.0% at 16 kHz, and now uses 3.9% and 2.4%.
- `ghostly task send`, `task update` and `usage send` name the flag that is wrong or missing, as a usage error (exit 2), where they answered with the card's field name and exit 1: `--steps 9/5`, a fourth `--tag`, `--pr-state` without `--pr-url` or with a word that is no state, `usage send` without `--left`, `--used` without `--limit`.
- `task send/update`, `routine send/update` and `usage send` refuse a card whose text (title, step, items, a run's summary, links, `--text`) looks like a recovery phrase, a private key or a Cashu token, as `send` does (exit 5), unless `--force`. Before, a card took any of them to the chat without a word.
- `task update`, `routine update` and `usage send` no longer read the whole history of the chat or group to find their card. The daemon remembers which message carries each card it sent or found, and reads that one message; only the first update of a card after a start still looks through the history. In a chat of 10,000 messages an update took about 120 ms of the daemon's time (a usage report twice that) and now takes under 1 ms, whatever the chat's length.
- A command run without a daemon, and a daemon that stops, no longer write the profile's whole store to disk again as they leave: the few rows they wrote are in the store's journal already, which now stays (up to 1 MiB) and is read back at the next start. With 100,000 stored messages that was 35 MB written and synced at every `ghostly status` or `ghostly chat list`, from 0.4 s to more than 2 s of each depending on the disk. A command that wrote nothing writes nothing as it leaves.
- A daemon (or a command run without one) that starts after a crash no longer builds the indexes of every stored row again for each store its last writes touched: it brings them in step for the rows those writes changed. With 60,000 stored messages, a start after a kill that had one message to recover spent about 5.5 s on that.
- `ghostly daemon status` and `ghostly daemon stop` on a profile that does not exist answer `not_found`, "No profile <name>: make it with `ghostly profile create <name>`" (exit 3), as `daemon restart` and `status` do. Before, `daemon status -p <a mistyped name>` answered `running: false` with exit 0, so a supervisor read a typo as a daemon that is down. `default`, which is made on first use, still answers `running: false`.
- Flags the help gives as either/or are refused together, as a usage error (exit 2) that names both, where one of them won without a word: `profile picture <jpeg> --clear` and `group picture <group> <jpeg> --clear` cleared the picture, `task send --progress n --steps a/b` and `usage send --left n --used n --limit n` sent a card with both, `group link --off --reset` dropped the reset, and `group hub --pin --exclude` pinned.
- A command a running daemon answers starts in about 40 ms instead of about 130 ms: the CLI loads the engine only when it runs the profile itself, and Node keeps its compiled code between commands. An `--exec` hook that calls `ghostly send` per event pays that once per event.
- `ghostly button update` without `--chosen`, `--close` or `--text`, `chat verify` without `--code`, and `typing` or `group typing` with a `--for` outside 1 to 600 are usage errors (exit 2) that name the flag. They answered in the words of the API's parameters ("code is required", "for must be a number from 1 to 600") with exit 1.
- `ghostly pin <chat|group> --remove` unpins. Before, it failed with "Missing <message>", and the message id it asked for was never read: any word beside `--remove` unpinned whatever was pinned. A script that names a message beside `--remove` goes on working.
- A daemon no longer waits for the disk each time it notes an event it reported. A text sent cost nine disk syncs, three of them for these notes, each holding every other chat, the socket API and `listen` for milliseconds; the notes now go to disk with the next write, or within a second. After a power cut, an event of the last second may be reported again.
- A daemon waits for the disk once per text it sends, where it waited nine times, and once per text it receives, where it waited twice. Each wait holds every other chat, the socket API and `listen`: about 13 of the 15 ms of a `chat.send` on a fast disk, and 100 ms on a disk that takes 10 ms per sync. The message itself is still on disk before the send answers. Its `sent` and `delivered` marks and its details go with the next write, or within a second; after a power cut a mark of the last second is made again when the daemon starts, by sending the message once more under the same id.
- A daemon, and a command run without one, no longer read the whole history of every chat and group at each start to know which events are new: after a clean stop they read each one's 100 newest messages, and the whole history only where something is new, after a crash, or once the engine changed it. With 100,000 stored messages that was about a second of every start and 50 MB of its peak memory.
- A profile's store comes back from disk faster at each start of a daemon or of a command run without one: its keys are put in order directly, where each comparison went through a check and a copy of both keys. With 100,000 stored messages that is 0.85 s instead of 1.4 s.
- A long-lived CLI or headless profile no longer slows down as its history grows: writing over a stored row (a message's delivery mark, an edit, a reaction, a file's state) or deleting one costs the same whatever the store holds. Before, each of those walked every row of the store, about 170 ms at 10,000 messages and 500 ms at 40,000, so one long chat slowed every other chat of the profile.
- `ghostly wallet redeem` with no token, typed on a terminal, answers with a usage error (exit 2) naming the two ways to give the token, where it waited on the keyboard without a word.
- The CLI guide and the Apps guide say how a bot is the contact's side of a mini-app: `app serve`, `app open`, the `app.*` events and `app send`.

**CI**

- CI ending on a pull request that is not in line no longer runs the merge train: the workflow checks whose head the run was on, and starts a base's train only when it is the head of a queued pull request or of a batch. In 23 hours, 105 of the 174 wakes by a pull request's CI were for one that was not in line, and the train ran in full for 47 of them with nothing to do. A head pushed after `queue` is seen when its own CI run ends, or at the next scheduled run.
- The labels the merge train puts on a pull request it drops from the line, `queue:conflict` and `queue:failed`, no longer start a merge-queue run each: only `queue` and `queue:priority`, the labels that put a pull request in line, wake the train.

**Website**

- `/developers` on ghostly.tools loads a WISP's page only when you point at, focus or touch its link: the explainer's "WISP nn" chips and the path list fetched 15 WISP pages as the page was read (1,144 KB, 35% of what it loaded). A click still opens the page at once, and the hero's button keeps its page ready.
- Pages on ghostly.tools no longer load the roadmap ahead of time. Its page data is 310 KB, and every page fetched it for the link in the main nav and the footer: over half of the 553 KB a page prefetched. `/roadmap`, `/cli` and `/developers/agents` also fetched up to four WISP pages for their "read more" links (up to 356 KB more). A link to the roadmap or to a WISP's page now loads it when you point at, focus or touch the link, and a click still opens the page at once. The other pages of the nav load ahead as before.
- The app screenshots on ghostly.tools load in the size they are shown at. Each one was a single file 2560 pixels wide (780 for a phone's screen), drawn at about 900 on the home page, and at 133 for the phone beside each window: 1,035 KB of screenshots on a visit to the home page in a 1280 pixel window. Each now has narrower copies, and the browser takes the one that fits its window and its screen's sharpness: 399 KB on that visit, 619 KB on a high-density screen. A phone gets the same phone screenshots as before.

**WISPs**

- WISP 1200 and WISP 1100 say how a bot on the CLI is the other side of a mini-app in a chat: it serves an app from its signed bundle, grants what the manifest asks, opens it with the app card, and exchanges the app's frames as `app.*` events and `app send`.

## 1.2.4

### Security

- Chats: someone holding a copy of a fresh invite, opening it at the same time as the real contact, can no longer stop the inviter's chat. A live session that began before the contact's key was pinned is now always checked against that key.

### Fixed

**Apps**

- An app opened on its own (from the Apps page) on a phone keeps its bar and its Close below the status bar. In the web app installed on an iPhone they sat under the clock, and Close could not be pressed.
- Export, offered before an app is uninstalled, wrote the app's data as indented JSON all at once: data kept in two or more chats could fail to export at all, and ten chats froze the page for seconds. The file now holds the same data written compactly, one entry a line, one chat at a time.
- An app that read a large file of its own bundle many times a second (16 MiB, 50 times a second) made Ghostly copy hundreds of megabytes a second, so the page stalled for most of a second and grew by about a gigabyte. File reads now go one at a time and add up to at most 16 MiB a second per app; past that `ghostly.file` answers `too-fast` until the second has gone.
- A file an app reads from its own bundle (`ghostly.file`) was copied twice on the web page's thread before the app got it. It is now copied once, which halves what each read of a large file costs.

**Wallets**

- In the extension and the desktop app, Open in wallet on a `bitcoin:` link whose label or message has ' ( ) ! * or ~ (such as "Bob's shop" or "Thanks!") said "Couldn't open a wallet". The link now carries those characters percent-encoded, and the wallet opens.
- Ecash a contact sent whose coins the mint holds pending (in a payment of theirs) is now refused at once, with "Could not receive…" in the chat and the contact told, instead of being kept and asked about every 30 seconds for good. A redeem that stays pending after the mint stopped answering is asked about every 10 minutes and let go after an hour.
- The same ecash sent again under another note is now one redeem: it is refused with "This ecash is already being received" instead of counting again in the sats on their way (20 copies of a 1,000-sat coin showed 20,000 sats, in the wallet, Remove wallet and the device move). A redeem that ends without the ecash now says "Could not receive N sats" in the chat too.
- Sending or redeeming ecash at a mint no longer waits while the wallet checks every unfinished swap there with a slow mint: it waits for one check at most.

**Calls**

- In a video call to a contact that takes no picture (a bot on the headless Ghostly), the camera button stays, so you can turn your camera off without hanging up. Before, the camera stayed on for your own picture the whole call, with its light on and, on Ghostly Desktop for Linux, about twice the call's processor use.
- Desktop on Linux: the contact's picture in a video call no longer stays blank for the rest of the call when one picture is lost on its way to the call window, or one takes too long to decode. The pictures after it now show within a second.

**Chat**

- Search in a chat or a group keeps every letter typed right after it opens. Before, the letters typed before the screen's next frame were selected and the next key replaced them, so on a busy phone "line" could read "ne" or "e".
- When both sides of a chat dial each other at once (two Desktops or CLIs with no WebRTC pairing for the first time, or both apps back after a restart) and one side's dial stalls, the connection that already worked carries the chat after half a second. Before, it waited up to 2 s more for the stalled dial to be made again (3 s at most).
- A file whose bytes had all arrived when the connection dropped now finishes as soon as the chat is back. Before, the sender could show it as sending for good, though the contact already had the whole file.
- A chat first stored by a release before 1.0 no longer shows "Dropped and came back N times" in English in its connection history, whatever the app's language: that drop now reads like any other.
- With many chats, the page's storage could fill up and a chat's new messages were no longer kept there across a reload. When a chat's copy does not fit, the other chats' copies (least recently active first) now keep only their last messages, which the app also keeps in its database, to make room.
- When the page's storage is full and a chat's copy cannot be kept there, a notice above the chat list now says "Storage full" and what to do: new messages still show, and deleting chats or profiles you no longer need keeps them after a reload. Before, nothing said so.
- Once the page's storage was full (many chats, or another profile on the same browser), a contact's new messages were marked delivered on their side but never shown here, not in the chat list, not in the chat, not after a reload, and your own sends stayed on the clock. They now show and count as unread, and your sends turn delivered, however full the storage is.
- On Linux, a message in a chat open in a Ghostly window that is on screen but not focused (on a second monitor, behind another app, on another workspace) shows its notification again. Before, the app took the notification back about 55 ms after showing it, so nobody saw it. It now stays until the window gets the focus with that chat or group open.
- On Linux, Download Video in the right-click menu of a playing video no longer saves a copy into Downloads under a made-up name, with no dialog and no sign in the app. A received file is saved through the app's own Save, which asks where and keeps the file's name.
- Scrolling through a long chat on a slower phone or computer froze the page for a moment every hundred messages or so, as each older page came in. Pages are now a quarter the size and the page holds half as many messages at once, so the longest freeze is about a third of what it was.
- An app left open for a while makes its next invite on keys already known to the network again, so it pairs as fast as one made just after start. Before, the ready invite aged out after 15 minutes but was still refreshed every 4, on keys no invite would use.
- A transport change that did not connect is now told in the app's language: the chat's line, its Why row, the connection history, the lines on why a chat is not live and the header's notice. Each says why in a few words ("Iroh did not connect in time", "Your transport choices don't match") and, where there is one, what to do next. The engine's own English stays behind the ⓘ.
- On the desktop app, Save on a voice message that can't play on this computer did nothing: no file, no word. It now opens the system's save dialog, like Download in the message's menu, and says why when the file could not be saved.
- Desktop for Windows: texts sent from the app now reach the contact in every chat. The Windows app sent them the old way, which a current chat does not read, so the contact (often the web app) never got them, calls stayed greyed out, and the app could show "You joined the chat" in a chat it made. Texts it sent before this release went nowhere: send them again.

**Everywhere**

- An app with many chats, back after a restart while its contacts are online, now brings every chat back within minutes. Before, its messages to the relays used up their limit, and the few looks left went to the chats already reconnecting. Some contacts were then looked for once in 10 minutes and their chats stayed down, and those contacts showed offline after 6 minutes. Now a look the limit has held back for a minute goes before the app's next messages, the oldest first. A daemon with 30 chats and 5 groups had 21 of its 30 chats back 10 minutes after a restart, and now has all 30 back in about 5 minutes.
- An app with many chats, back after a restart while its groups reconnect, no longer leaves some chats unread for many minutes. Its chats that are not connected yet now look for their contacts in turn, and a look the relays' limit held back goes again as soon as the limit allows. Before, the same chats took every look the limit allowed. A daemon with 30 chats and 5 groups looked for some contacts once in 10 minutes, and 5 of its 30 chats stayed down although both sides were online. Now it looks for every contact again within minutes, and 28 of the 30 chats come back.
- An idle chat no longer writes to the disk every time it keeps its DHT mailbox alive. Before, each keep-alive (every four minutes per chat) and each one the relays' limit held back (every 30 seconds on an app at its limit, as a daemon with 30 chats often is) rewrote the chat's saved state with a disk sync. That was 16 writes an hour per idle chat, and 242 at the limit, for nothing sent. Now it is 1 and 2.
- In a private group, a member whose app closed while another member's app was connecting to it is reached directly again once it comes back online. Before, the other app kept that member on a slower relayed connection until it restarted, and past four such members the rest stayed unreachable.
- With no network, the app no longer redraws the chat list every second or two for chats that never synced. Each failed look for such a chat made the page read every stored chat again: about 540 reads a second with 50 chats. Now a chat shows its first sync under way during its first look only, and a failed look changes nothing on screen.
- In a chat's connection panel, an Iroh or HyperDHT option this app could not start now says why in a few words of the app's language, as the line below the choices does ("All native connections in use", "HyperDHT relay unreachable"): its tooltip, its screen-reader description and the second line under it on a phone. Before, they read the engine's whole English sentence in every language.

**CLI**

- `wallet add-mint` with something that is not a URL, or a mint not on https, answers code `bad_request` with the same words ("That is not a valid mint URL", "Mints must use https"), as `service add` does. Before, it answered `engine`, which a bot reads as the engine failing and may retry.
- An empty `--profile` (a script's `ghostly -p "$BOT" …` with `BOT` unset, or `--profile=`) ran the command as the current profile, so a script meant for its bot could send, make invites and change settings as the person's own profile. An empty `--home` (or `GHOSTLY_HOME`) used the current folder and made a new profile there. Both options are now a usage error when empty, and an empty variable counts as unset.
- Files a bot sends at once (`file send` run in parallel, or many requests on the daemon's socket) are each their own message in its chat. Before, files sent in the same millisecond shared one message: the sender's chat and `file list` kept only one of them, and the others were not sent again after a drop.
- `chat history`, `group history` and `wallet history` take only a whole number for `--limit`. Before, `--limit 1.5` on a chat or a group answered code `engine` (as if the engine had failed, which a bot may retry) and `wallet history` took it; now each answers `bad_request`, "limit must be a whole number from 1 to 10000".
- A daemon reads a contact that is away at the same slow pace as its other chats. The chat of its last `invite create` or `invite join` stayed the chat "on screen" for good, so while that contact was away the daemon read it 2.5 to 3 times as often, about 18 of a Pkarr relay's 30 requests a minute. It now stops once the chat is paired.
- Payments and requests a bot makes at once (`chat pay` or `chat request` run in parallel, or many requests on the daemon's socket) are each their own message in its chat. Before, two of them made in the same millisecond, or one of them and a file sent then, shared one message: the sender's chat kept only one of them.
- `ghostly profile restore` on a file that is no Ghostly backup (a wrong file, an empty download) says "This is not a Ghostly backup" at once, with or without a passphrase, instead of asking for one. A backup that is encrypted and given no passphrase now names restore's own options, not backup's `--no-passphrase`.

**Groups**

- Being in several communities with the same people costs the relays less. A device that is the door of several communities now checks them for newcomers about as often as it would check one, and a member connected in several reads their hub lists less often. In 4 communities shared by 3 people, the member's idle relay requests drop from 24 to 8 a minute, and each hub's from 76-100 to 66. Someone who opens a community's link is still let in within seconds.
- People who share several communities no longer see some of them stay unconnected for minutes. A device that was a hub of several communities spent the relays' allowance on idle checks of each community's door, lobby and hub list, and the connections its members needed in the other communities got what was left: with 4 communities on one relay, or 8 on two, some stayed down for 10 minutes and more, and messages sent there reached nobody. A hub's idle checks now wait while connections are being set up. They keep their pace while someone is coming in.
- In a community, what a member wrote just before leaving now reaches the members who were away when they open the app again. Before, they came back to "… is no longer a member" without that member's last messages, while those who were online had read them. A removed member's messages still do not reach them.
- Back in a private group, the messages you missed from one member come in about a minute every time: when your app happened to ask that member first, it waited a whole extra minute before asking anyone else for the older ones, so 256 missed messages took over two minutes in about half the returns.
- Someone who accepted an invitation to a private group and closed the app (or lost the chat) while the admin's app was letting them in could wait on "Joining…" for good: the admin's app had added them, but the welcome never reached them and was never sent again, and the admin could not invite them again. Their app says its accept again, as it does, and now gets the welcome.

**Desktop**

- On Desktop (and Android), a chat over Iroh no longer drops its connection when the app hands it frames faster than the link carries them (a file or a mini-app sending to a contact on a slow link): each frame now waits for room on the connection instead of being refused once 32 were queued, and the chat's send budget counts it until it is written, so files and apps see the real queue and keep to their share.
- On Linux, a notification server that stops answering no longer holds back every later message's sound and notification: the app does not wait for a notification before the next event, and gives up on a server that has not answered in 5 seconds.
- On Linux, while the notification server is not answering, notifications no longer wait in line, 5 seconds each, behind the ones before them: different chats' notifications wait side by side, and a chat's notification that a newer one replaces is not sent at all. Five notifications in that moment took 25 seconds to get through, and now take 10.
- On Linux, each notification given up on a notification server that stopped answering no longer leaves a D-Bus connection and a thread behind for good: the connection given up on is closed, and its click listener ends with it.

**Website**

- At the end of every page on ghostly.tools, the sleeping ghost in the footer kept the whole page laying itself out and repainting 60 times a second for as long as you stayed there, more on longer pages (up to about 60% of a mid-range phone's main thread on a long WISP page). Its hem now rests while it sleeps; only its z's move.
- On a phone 320 to 349 px wide, the ghostly.tools home page now fits its first screen and its download panel to the screen, in place of cutting their text and buttons at the right edge.
- On a computer, the little ghost that follows the pointer on ghostly.tools kept the page laying itself out 60 times a second for 45 to 57 seconds after every time the pointer stopped, up to about 14% of a core on a long WISP page. Its float and its z's kept doing it about 30 times a second for as long as it was on screen. It now moves and floats without laying out the page, and rests a few seconds after it reaches its spot.
- On a phone narrower than 375 px, the "On this page" list of a WISP wraps inside its box. A heading that names a source file set the width of every entry, so on the public-profiles reference they ran past the box's border and off the screen.

### For developers

- Private groups (WISP 902): the admin's `remove` commit made on a member's own leave goes with `left`, the admin's signature that the member asked to leave, on the `group-commit` frame. Members keep it and hand it on with the commit. A removal the admin chose carries none.

**Apps**

- Behind the apps flag: with three apps or more running at once, an app reading one of its own files no longer reads its whole bundle (up to 16 MiB) back and checks it again. The engine kept the checked bundles of two apps only, so each read pushed out the one the next app needed: a 2-byte or missing file cost 18 ms of reading and hashing. Now each app started keeps its checked bundle, and a read takes well under a millisecond.

**CLI**

- Flags the help gives as either/or are refused together, as a usage error (exit 2) that names both, where one of them won without a word: `profile picture <jpeg> --clear` and `group picture <group> <jpeg> --clear` cleared the picture, `task send --progress n --steps a/b` and `usage send --left n --used n --limit n` sent a card with both, `group link --off --reset` dropped the reset, and `group hub --pin --exclude` pinned.

## 1.2.3

### Security

- Devices: after you change your lock password, your other devices no longer accept the old one for "My other device is lost or broken". A device that last had the profile before the change says the password was changed; choose Use here on it, with the new password. Adding a device with your current password no longer changes anything for the devices you already have.
- Chats: the Iroh and HyperDHT addresses a contact's app gives during a session now pass the same checks as the ones in its published record before Ghostly keeps or dials them (a well-formed key, an https or wss relay, a bounded list). An address that does not is ignored.
- Web app: every address of app.ghostly.tools, not only its pages, cuts the link to a site that opened it in a new window, so that site can no longer send the window somewhere else later.
- Desktop: the Ghostly window stays on the app's own pages. A file or a link dropped on it, or anything else, can no longer load another page in its place under Ghostly's name.

### Fixed

**Groups**

- A group member's connection whose answers WebRTC refused several times in a row (a race in the WebRTC library on a busy machine) is tried again after a few seconds, then over Iroh or HyperDHT, instead of waiting three minutes. Before, a member let in to a group could wait from 30 s to several minutes before it reached another member. Seen between headless Ghostly on CI.
- Someone removed from a community who opens its link to get back in is still listed with the group as they kept it (who was in it, its status) while they wait to be let in, and `ghostly group decline` then stops asking and keeps the group and its history. Before, the group was listed as a bare invitation while waiting, and the only ways to stop were to leave or delete it, which removed the history.
- Removed from a community and waiting to be let in again through its link, you still read the history you kept: the wait is a line above it ("Waiting to be let in"), and Cancel joining there only stops asking. Before, a join card covered the history for as long as nobody answered, and Cancel joining deleted the group and its history from the device without asking.
- Back in a private group twice within a minute (a phone that slept, woke and slept again), you read what one of the members wrote meanwhile in its place among the others' messages. Their messages could come in on their own, out of turn.
- Back in a private group after a while, you read what the others wrote meanwhile in the order they wrote it, the newest message last. With several members writing, each member's messages came in on their own and out of turn, and the newest ones sat above older ones, out of sight on a phone until you scrolled up.
- Declining a group invitation while the person who invited you has Ghostly closed now reaches them when they are back. Before, the answer was lost: in their Members list you stayed "Invited…" for good, they could not invite you again, and you held one of the group's 32 places.
- A member of a private group who was away while someone edited many messages (a bot closing dozens of task cards) now gets every one of those edits when it is back, not only that member's latest sixteen: cards that were closed no longer stay as running on its Tasks board.
- A member of a community who was away while someone edited more than thirty messages (a bot closing dozens of task cards) now gets every one of those edits when it is back: the ones past thirty in ten seconds wait a moment instead of being dropped, so closed cards no longer stay as running on its Tasks board.
- A member back from away gets every file a member sent to the group meanwhile. Past the first 30 from one member, the files showed as a line of text asking to update Ghostly, with no file and no Download. Now each one is a file with a Download.
- In a group, messages of a member that never arrived and that nobody holds any more are asked of each connected member once, as meant: they were asked for again every time their author wrote something new, a minute apart, for as long as the group was busy.
- "Delete from this device" on a group invitation now tells the person who invited you that you are not joining, as Decline does. Before, they were told nothing: you stayed "Invited…" in their Members list for good and held one of the group's 32 places.
- An invitation to a private group accepted after the group was deleted, or after whoever sent it stopped being its admin, no longer says "Joining…" for good: the inviter's app answers that it cannot let you in, and the invitation goes from your list.
- An invitation to a private group you accepted, whose inviter's app never answers, offers Accept and Decline again after a few minutes and says the app did not answer, instead of "Joining…" with nothing to tap.
- An invitation to a private group goes from the invited person's list when whoever sent it deletes or leaves the group, or makes someone else its admin, instead of staying there with Accept and Decline that lead nowhere.
- A contact you invited to a private group who has not answered in a week no longer stays "Invited…": the Invite button comes back, and the invitation stops holding one of the group's 32 places. Before, an invitation whose answer never reached you stayed pending for good.
- Cancel or Escape on a group link's "Make a new link?" or "Turn the link off?" question puts the keyboard focus back on the button that asked (New link, Turn off). It fell to the page, so the next Tab started from the top.
- On a phone the Members dialog's Share, Copy and Show QR for the group's link are a thumb's height (44 px), as New link and Turn off beside them already were. They were 24 to 28 px tall.
- The open Members list of a large group or community no longer draws every member's row again each time anything changes in the app. A row is drawn again only when its own member changed (their name, their connection, their role). Before, with 256 members the whole list was drawn again on every change, up to 20 times a second.
- A private group no longer writes its whole record to the device for every message received. Messages that arrive together (someone back in a busy group taking 250 of them, a lively conversation) are now one write a second at most: the record holds the last 256 messages kept for members who were away, 100 to 260 KiB each time, so a catch-up wrote tens of megabytes and held the CLI for seconds.
- A group's member list no longer keeps "N missing" beside a member for messages nobody holds any more (a member keeps its own last 32 and the group's last 256): once every connected member was asked for them and none had them, they stop being counted. The count stayed until the group's members changed, as if those messages were still on their way.
- Web app, extension and CLI: a group member reached over Iroh no longer waits for "a free connection on this device" once four others are. These apps now hold up to twelve Iroh connections for group members (four before, a limit that belongs to the Desktop app only), so in a group with five or more members that connect this way, every one is connected and none gets its messages late through the others.
- Opening the app after some time away from a community no longer loses reactions. When one member had reacted more than 30 times meanwhile, only the first 30 were shown and the rest never appeared on that device, so people saw different reactions on the same messages. The rest now show a few seconds later.
- An open group or community with many members and a long history no longer works its whole history over each time anything changes in the app (a message in another chat, a connection coming up). Before, every such change named every member again for every message: with 256 members and 12,000 messages the open page lost about 50 ms to it, up to 20 times a second.
- An app with many live chats no longer spends the relays' requests that its groups need on keeping those chats up: with 30 live chats, people joining a group by its link waited from over a minute to nine minutes to get in.

**Apps**

- An app's newer version that a store of yours removed, or that its publisher revoked, is no longer downloaded again each time the Apps page opens. Ghostly reads its first 64 KiB to see which version it is and stops there.
- An app can no longer keep far more on the device than the 5 MiB per chat it is allowed. Only the bytes of its keys and values were counted, not the roughly 140 bytes each key costs to keep, so an app that stored very many tiny values could take over 100 MiB in one chat before it was told its storage was full. Each key now counts 128 bytes more, which keeps what an app takes close to its 5 MiB. An app's data already on the device is kept as it is.

**Chat**

- Task cards: on a light theme, a blocked task's "Blocked" is written in a darker amber that can be read (4.5:1 or more, it was about 2:1), on its card in the chat, in the Tasks panel and on the Tasks board. The mark of a pull request whose checks are pending gets the same ink.
- In Safari and the macOS and Linux apps, a chat kept open in the background (on a call, or with an app running in it) is where you left it when you come back to it, at its last message or on the message you were reading, instead of far up its history.
- On Desktop and Android, opening a chat no longer reads every file in it that is not a picture (up to 64 MB each) into memory. Such a file shows its Save button from whether it is on the device, and none of its bytes are read until it is saved.
- A message sent right after the app opens shows at once as sending, instead of seconds later once the app has read every chat's history.
- With many saved chats, opening the app no longer spends its relay requests looking every few seconds for contacts who have been away for a long time. A message sent right after opening, and the app's own records, now go out in the first seconds instead of a minute later.
- Ending a choice of messages to forward (Cancel, Escape, or the forward itself) from the keyboard or with a screen reader leaves the focus on the message field that comes back, or on the messages on a touch screen. It used to drop the focus to the page, and Tab started again from the top.
- A chat that goes live no longer reads its whole history to find the files and payment requests that waited for it: they are known from the start of the app, then kept as they are written, and read one by one.
- A screen reader says what a contact is doing ("typing…", a bot's status) and nothing more: it used to read out the contact's key each time they stopped typing, and in a group the member count each time someone stopped.
- A bot's usage card, in its details: a window whose reset has passed says how long ago it reset ("reset 1 d ago"), muted. It said "resets 10:50 AM" of a time that was yesterday, and the card's own Resets row said "03:50 PM · now".

**Calls**

- A video call to a bot (a contact on the headless Ghostly) no longer uploads your camera. The bot shows no picture, but the app sent it the whole call, about 20 times the data of the voice; the same for a camera or a screen turned on during the call. You still see your own picture.
- A call started with the keyboard keeps the focus. The whole-screen call takes it when it opens and Tab stays on the call's own buttons; it used to walk nine controls of the chat hidden behind the call first. When the call ends, the focus is back on the Audio call or Video call button that started it, instead of at the top of the page.
- In a call with a contact on the command line (a bot, an agent) or on an older app, the call window now says "Reconnecting..." as soon as the connection is lost. It kept saying the call was connected, with the clock running, for about 30 seconds, and then the call just ended.
- On a phone, the notices at the top of a chat during a call ("Waking Ana for the call…" with its Cancel, "No answer") are as wide as their words, up to the screen. They used to be squeezed into half the screen, on three or four short lines. In the app installed on an iPhone, these and the other notices at the top of the window (a blocked microphone, "Your phone paused the mic", a link that could not be used) now sit below the status bar instead of behind the clock.
- The "Incoming call" notification now goes away when the call is answered, declined or given up by the caller (Linux, Android and the browser extension). Before, it stayed in the notification list and still said a call was coming in.
- On a phone, the small call window's state line no longer runs under its corner button. In Portuguese "Chamada de áudio 00:05" started behind the button, which covered its first letter; the line now starts after the button, and when the window is too narrow for the words it keeps the clock.

**CLI**

- A call from or to the CLI on a network where the STUN server does not answer (UDP to it blocked, as in many offices and hotels) rings after 2 seconds and connects 2 seconds after the answer, not 5 and 5. `call start` returns that much sooner.
- A `ghostly daemon` whose output nobody reads any more (the process that started it was killed, or the pipe it wrote to closed) no longer takes a full processor core and stops on SIGTERM again. It used to report each failed write with another write that failed, without end, and answered no command.
- `ghostly listen --cursor <file>` whose folder does not exist, or cannot be written, is refused at once (`not_found`, exit 3, or `refused`, exit 1), before the profile is opened. Before, it started and ran: each event printed "event N failed: ENOENT" on stderr, the cursor was never written, and the next start skipped what came while it was down.
- `ghostly listen` refuses words it does not take (`ghostly listen bob`, `ghostly listen message.received`) with "Too many arguments" and its usage, exit 2, as the other commands do. It started a listener of every chat's events.
- `ghostly service enable`, `service remove`, `service share`, `identity remove`, `identity withdraw`, `identity cancel` and `message retry` answer `not_found` (exit 3) for a service, an identity proof, a draft or a message that does not exist, naming it and where to look (`No service "nope" (ghostly service list)`). Before, each answered as done with exit 0: a mistyped service id read `"shared": true` with a contact.
- Without a daemon, `ghostly chat remove <chat> --yes` on a profile's only chat really removes it: it answered `{"removed":…}` and the chat, its keys and its whole history were still there for the next command. The same for `service add` on a profile with no chat, and for `chat rename`, `message delete` and the `service` commands while the relays cannot be reached: what a command answers is on disk before it leaves.
- The CLI starts faster on a profile with a long history: it reads its record of the messages already reported in two requests instead of one step per message. With 100,000 stored messages that step took about 2 seconds of every `ghostly daemon` start, and of every command run without a daemon; it now takes about a tenth of that.

**Everywhere**

- A group's link in a chat no longer says "You are in this group." when you were removed from it. The card now says why you are out. For a community group it offers "Join again"; for a private group whose messages are still on the device it says to delete the group from the device first, since its link is refused until then. A group you left offers "Join group" again.
- A profile with two devices opened with "Start anyway": what it cannot do yet (send or download a file, create or join a group, remove or move a device) says why in your language, and to check your connection. It was one English sentence in all eight.
- On Linux, a file dragged from a file manager onto the Ghostly window no longer opens in place of the app. The window used to show the picture, the text or the folder's listing instead of your chats. A link dragged onto the app, from a browser for example, is left out the same way on every platform; dropped into a text field it is still its text.
- Going Back to Ghostly after its window or tab showed another page starts the app again. The page that came back used to be the one that had left: it had said goodbye to your contacts, so no chat went live again and messages stopped arriving until the app was closed and opened.
- Light theme: the warning lines outside the notices read at 4.5:1 or more instead of pale yellow at about 2:1. A public DID's "Public to everyone, forever", the wallets' test-coin, unconfirmed and fee lines, a full group's link note, the message size counter and an identity about to expire.

**Desktop**

- Linux: after the desktop's notification server restarts (mako, dunst, swaync, a reloaded shell), a click on another app's notification no longer brings Ghostly forward and opens one of its chats.
- On Linux, a chat's new messages now share one notification, which goes away once you read the chat in the app. Before, each burst of messages added another one to the desktop's notification list, and they all stayed there after the chat was read.

**Wallets**

- With a long history of reviewed payments, the check that runs every 10 seconds for payments still on their way no longer reads every payment ever reviewed: it reads the ones whose outcome is still open, usually none. At 2,000 reviewed payments that was about 9 MiB read from the database every 10 seconds while the app sat idle.
- A wallet card lists only its own network's payments: the Mainnet USDT card no longer shows the Testnet wallet's ("1,000 TEST-USDT · confirmed"), and the same for Ark, Bark, Spark and on-chain.

**Website**

- `ghostly.tools/apps` loads an app's page only when you point at, focus or touch its card. Before, every card on the screen asked the server for its page as the list opened, one request for each app. A click still opens the page at once.

### For developers

- Call signals: an offer or an answer may say `vr: 0`, "this side takes no picture". The other side's app then closes its half of the video lane and uploads no camera or screen on it. Older apps ignore the field (WISP 601, PROTOCOL §4.4).
- A private group's message from another member is stored with the frame it came in (`StoredMessage.frame`, on the group's newest 256 rows at most), ready to be handed on to a member who was away. The engine keeps it to itself: histories, pages of them and changes reach a page or the CLI without it. No new store and no database version change.
- The website's Docker image builds again: its build context now holds the four Markdown files outside `docs/` that a WISP links to (the CLI reference, the proofs and providers lists, the e2e guide). Since the check that refuses a link to a missing file, the image failed to build while CI, which has the whole repository, stayed green. A test now compares the WISPs' links with the image's context.

**CLI**

- A daemon (or a command run without one) that starts after a crash no longer builds the indexes of every stored row again for each store its last writes touched: it brings them in step for the rows those writes changed. With 60,000 stored messages, a start after a kill that had one message to recover spent about 5.5 s on that.
- A daemon no longer waits for the disk each time it notes an event it reported. A text sent cost nine disk syncs, three of them for these notes, each holding every other chat, the socket API and `listen` for milliseconds; the notes now go to disk with the next write, or within a second. After a power cut, an event of the last second may be reported again.
- A daemon waits for the disk once per text it sends, where it waited nine times, and once per text it receives, where it waited twice. Each wait holds every other chat, the socket API and `listen`: about 13 of the 15 ms of a `chat.send` on a fast disk, and 100 ms on a disk that takes 10 ms per sync. The message itself is still on disk before the send answers. Its `sent` and `delivered` marks and its details go with the next write, or within a second; after a power cut a mark of the last second is made again when the daemon starts, by sending the message once more under the same id.
- A profile's store comes back from disk faster at each start of a daemon or of a command run without one: its keys are put in order directly, where each comparison went through a check and a copy of both keys. With 100,000 stored messages that is 0.85 s instead of 1.4 s.

## 1.2.2

### Fixed

**Apps**

- Apps, stores: reading a store's list no longer holds the page while its publishers' revocations are checked. A list may carry up to 4096 of them, each a signature check, and all were checked in one go before anything else could run: about 10 seconds with a full list, at the preview in Add, again at Add, and at every refresh of a list that had changed. They are now checked a few milliseconds at a time, and one already checked is not checked again when the list changes around it or when Add reads what the preview just read.

**Everywhere**

- A Testnet Ark wallet can move to another test network (Mutinynet, Signet, Regtest) when the server of the one it is on has stopped answering: the app waits 10 seconds for that server to say the wallet is empty, then goes by the last balance it read. Before, the switch waited on that server for as long as it stayed quiet. A Mainnet wallet still waits for its server's own word.
- A Testnet Bark wallet can move to another test network (Signet, Regtest) or be restored over when the server of the one it is on has stopped answering: the app waits 10 seconds for that server to say the wallet is empty, then goes by the last balance it read, pending and exiting coins included. Before, the switch waited on that server for as long as it stayed quiet. A Mainnet wallet still waits for its server's own word.
- On a computer, a link to a chapter of the ghostly.tools home page (the menu's "How it works", a WISP's "In the app" link, `ghostly.tools/#invite`, `#dht`, `#agree`, `#alive`) shows the chapter's title and first step. It used to land on a screen with no words.
- The download panel of ghostly.tools no longer marks the macOS installer as yours on an iPad. A tablet gets no marked installer, like a phone.
- On ghostly.tools, the download panel no longer marks the amd64 AppImage as your installer on a Linux ARM machine, where it does not run.
- A link to a section of the ghostly.tools home, such as ghostly.tools/#download, opened on a phone lands on that section. It used to stop up to two screens above it.
- On ghostly.tools, the caption under each app screenshot names the release the page offers ("Ghostly 1.2"). It said "Ghostly 1.0.1" under screens that show what came later, like a photo sent to a group.
- On ghostly.tools, a link to another WISP in a WISP's revision log opens that WISP's page. On seven pages such links used to open a GitHub page that does not exist.
- The "page not found" page of ghostly.tools is a still when your system asks for reduced motion, as the other pages are. Its ghost kept drifting, its flashlight kept dimming and 25 small ghosts kept floating by.

**CLI**

- `ghostly button update` and `ghostly button press` read the one message they name instead of the whole history of the chat or group.
- `ghostly daemon --detach --timeout <s>` (and `daemon restart`) shorter than the daemon's start no longer says "The daemon did not start" while the daemon it started keeps running: it says the daemon is still starting, with its process id (exit 4). A `--timeout` of 0 or less on `daemon`, `daemon stop` and `daemon restart` is a usage error.
- `ghostly delete` and `ghostly forward` read the messages they name, one row each, instead of the whole history of the chat or group (and `forward --wait sent` no longer reads the target chat's whole history per message forwarded).
- `ghostly group edit`, and an `edit` the engine refuses, read the one message they name instead of the whole history of the chat or group, which held the daemon about 120 ms at 10,000 messages.
- `ghostly -p` and `ghostly --home` with no value say `--profile needs a value` (or `--home`), a usage error (exit 2) as `ghostly send -p` says, instead of printing the whole help with exit 0.
- `ghostly group join <word>` with something that is no link to a group answers `bad_request` (exit 1, "This is not a link to a group") as `ghostly invite join` does for a word that is no invite, instead of an engine error.
- `ghostly help help` shows how to use `help` instead of `Unknown command: help`, and `ghostly version --pretty` indents its answer as every other command does.
- A command that takes a chat or a group (`pin`, `forward`, `task send`, `routine send`, `usage send`, `button press`, `file send`) and is given a name neither has now says `No chat or group "<name>" (ghostly chat list, ghostly group list)`. Most of them said `No group`, though the name may have been a chat's.
- On Node 25 and newer, a command that opens a profile no longer prints "ExperimentalWarning: localStorage is not available" on stderr. With `--localstorage-file`, Node's storage is used as before.
- `ghostly react <group> <message> <emoji>` says the name is a group's and how to react there (`ghostly group react <group> <message> <emoji>`), instead of `No chat "<group>"`.

**Groups**

- A large group with a link no longer gets stuck when its member history fills up: it stops taking new members, new links and new keys while there is still room for everyone in it to leave, be removed or hand over the admin role. Before, a full history kept a member who left in everyone's list for good and the admin could not remove anyone or leave.
- In a group with a link, when one of the apps that connect the members leaves shortly after someone joined, the members it connected are taken by another one sooner. Before, that app could still be waiting for the newcomer, whom the other had already let in, and looked for the members asking it only every half minute.

**Chat**

- In Arabic on Linux, the message field no longer shows scrollbars across it after the window is made narrow with a chat open. They stayed until you typed.
- A file a contact sends the earlier way (files/2) no longer loads every file record of the chat before it starts: the chat already knows which files it holds.
- A receipt on the DHT for a file that waits for the live link, or for an edit sent there, no longer reads the chat's whole history each time: the files said there are read once, then kept as they are said.
- Opening a message's details, retrying a message, and storing a text for a contact who is away read that one message instead of the chat's whole history (a held text read it up to three times).

**Wallets**

- Fedimint wallet: the History of a federation with no movement says "Nothing yet" (it was an empty box once another federation had one), a row's fee is written like its amount ("fee 1,500", not "fee 1500"), and notes taken back say so under Send instead of showing under Receive as notes redeemed.
- Copy on money in a message (a Lightning invoice or address, an ecash token, a Bitcoin, Ark or USDT address, a BOLT12 offer) says "Copied" only once it is copied. When the browser refused the copy, the button still said "Copied" while the clipboard kept what it held before, which could be another address. The card now says it could not copy and shows the text to select.
- A payment's two ticks, and a request closed because its wallet was removed, read the payment's own message instead of the chat's whole history.
- In the Spark wallet's history, a fee is written like the amount beside it ("fee 1,500", not "fee 1500"), and a movement that is pending or failed says so in the app's language instead of in English.

**Desktop**

- On Linux, clicking a Ghostly notification brings the window forward and opens the chat (or the group, or the profile) it is about, as on macOS. Before, the click only closed the notification.

**Website**

- `/developers` on ghostly.tools, on a phone: the negotiation demo that plays by itself keeps one height through its four scenarios. It changed height by up to 353 px every two seconds, so the text below it jumped while you read, and a link to a section below it (`/developers#path`, `#availability`) stopped 275 px past the heading.
- The home page of ghostly.tools, with the keyboard: a step button of the story that takes the focus brings its chapter to that step. Tab from a chapter's last step button to the next chapter's first put the focus on a button nobody could see, on a screen that was black or had no words.

### For developers

- The merge train takes a pull request labelled `queue:priority` and not `queue` as in the line, first. Before, only `queue` put a pull request in the line, so one with `queue:priority` alone waited for good while the train found no base to run (three green flaky-test fixes sat for eight hours on 2026-10-09).
- The merge train writes `[skip ci]` (and `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`) in round brackets in every commit message it composes. A queued pull request whose title or an earlier commit carried one made the batch's head commit hold it, so GitHub started no CI for the batch and the train rebuilt the same batch every 20 minutes for good.

**Apps**

- An app's `icon.png` is at most 1024 × 1024 pixels. Only its bytes were bounded (256 KiB), so a small file could ask for a very large picture, which the install screen decoded whole before anything was installed. A larger icon is now refused as `bad-icon` when the bundle is read, and `ghostly app publish` refuses to build it.
- A store index's own signature is checked before the signatures of the revocations it carries, so an index nobody signed costs its reader one signature check, not up to 4097. Only an index with two faults reads differently: a revocation that does not verify in an index whose own signature does not verify is now `bad-signature` (it was `bad-revocation`). `readAppStoreSteps` reads an index in steps for a reader that shares its thread, and takes the revocations already checked (WISP 1200, Stores).

**CLI**

- A long-lived CLI or headless profile no longer slows down as its history grows: writing over a stored row (a message's delivery mark, an edit, a reaction, a file's state) or deleting one costs the same whatever the store holds. Before, each of those walked every row of the store, about 170 ms at 10,000 messages and 500 ms at 40,000, so one long chat slowed every other chat of the profile.

**CI**

- The labels the merge train puts on a pull request it drops from the line, `queue:conflict` and `queue:failed`, no longer start a merge-queue run each: only `queue` and `queue:priority`, the labels that put a pull request in line, wake the train.

**Website**

- The app screenshots on ghostly.tools load in the size they are shown at. Each one was a single file 2560 pixels wide (780 for a phone's screen), drawn at about 900 on the home page, and at 133 for the phone beside each window: 1,035 KB of screenshots on a visit to the home page in a 1280 pixel window. Each now has narrower copies, and the browser takes the one that fits its window and its screen's sharpness: 399 KB on that visit, 619 KB on a high-density screen. A phone gets the same phone screenshots as before.

### Security

**Groups**

- In a private group, only a member who is still the admin can name everyone, and a member's pins are paced.
- A community hub gives its lobby only to members of its roster, and a commit that came before its parent waits only when the admin signed it, for two minutes.
- Group files: a holder counts what it sends toward its day whatever the asker confirms, keeps the records of its last few ended transfers only, and never sends the same piece again without bound. A file that is coming can be cancelled or paused, and turning automatic downloads off stops the ones not here yet.

**Chat and devices**

- An invite or group link opened in the app makes a chat only after the lock, and only a few at a time.
- A chat that was live is never told its invite was used by someone else.
- Held messages are fetched only from HTTPS addresses on the public Internet.
- "Lock after N minutes" counts the time the device was asleep.
- A name with nothing to see in it (only invisible characters) is no name.
- The question before a secret goes out reads the text without its invisible characters.

**Apps**

- A running app is judged by the version it runs, and an app uninstalled while it runs is stopped.
- An app's icon is at most 1024 × 1024 pixels.
- Reading a store's list pauses every few milliseconds, checks the list's own signature first and each revocation once.
- An app card's name for a screen reader is the installed app's title.

**Website**

- No other site can show the website's pages in a frame, and its answers say how their files and links may be read.

**CLI**

- `chat list`, `chat show` and the other commands that print a chat no longer print a pending chat's invite code; it shows as `<hidden>` unless you add `--show-secret` to `chat list` or `chat show`. `engine getState` hides it too. `invite create` prints it as before.

## 1.2.1

### Fixed

**Identities**

- Add a device: a double click on They match (or They match, then They don't match) is one answer. It no longer leaves a red error line next to "added", and the new device is sent its place in the profile once.

**Everywhere**

- In Add a device, Try again after a code that ended now says "Getting ready" while the new code is made, and when the new code cannot be made (no connection, for example) the reason comes with Try again under it. Before, the dialog was left with one red line and nothing to press, and getting another try meant closing it and typing the lock password again.
- In Arabic, the Back arrow of a chat, a group, a page and an app opened in a chat now points to the right, the side it goes back to. It still pointed left.
- On ghostly.tools, the phone menu scrolls when the screen is shorter than it is, as on a phone turned on its side. Its last entries used to sit below the screen's edge, out of reach.
- A link to the WISPs page on ghostly.tools whose `#anchor` has a stray `%` (such as `/wisps#100%`) opens the page. It used to show "This page couldn't load".

**Apps**

- Apps, Add: a link written without `https://` (`github.com/owner/repo`) is read as the repository it names. Before, the browser stopped it with its own "Please enter a URL" bubble, or Check did nothing. Text that is no link now gets the dialog's own message, in the app's language.
- An app that talks a lot with the contact's app (a game sending many frames a second) costs the chat less: each frame it sent made Ghostly derive the chat's own key from its seed again, only to name the app to the contact, about 0.6 ms a frame and 30 ms of every second at the 48 frames a second an app may send. The key the chat already keeps is used, and a frame now takes about 0.02 ms to name.
- On the web, a full-screen app whose Open was pressed twice before it showed (a double click or double tap) started twice, one layer over the other: Close took the top one away and the same app was still there under it. It starts once now, and opens again after Close as before.
- On the Apps page, Show more under a store's listings moves the keyboard focus to the first listing it added. After the last ones the button goes away, and the focus went with it to the top of the page, so the next Tab started far from the listings just shown.
- On the Apps page, a store shows its apps right away when it is your only store or lists a few (the Ghostly Store and Chess, on a new profile). They were behind the store's name, which opened them when pressed and looked like a label, so the page read "1 app" and showed none. A store with a longer list beside others still opens from its name, which now has an arrow.
- In a chat, + then Apps no longer shows an app as "Stopped", with Open off, when its files are just not on this device (a profile restored from a backup brings the list of apps, not their files). It says "Needs its files", and Open fetches them and opens the app. A version its maker revoked or a store removed still reads "Stopped".

**Chat**

- Pressing a button on a message reads that message alone; the chat's or group's history is read only for a question that one answer closes.
- Editing a message no longer gets slower as a chat grows: an edit and its confirmation read the edited message, not the chat's whole history. A bot that updates a card in place read the history three times for every update, and once more 20 seconds later. On the CLI, ten edits in a chat of 5,000 messages took 3.7 s and now take 1.9 s.
- A chat with many files and voice messages no longer slows the app down when it connects: each file that had already finished read the chat's whole history again on the chat's first connection after every start, and its details then said it was completed at that moment. On the CLI, a chat of 5,000 messages and 300 files took 41 s of reading there and now takes 0.2 s. A file's details keep the time it really finished.
- Sending or receiving a file or a voice message no longer gets slower as a chat grows: it reads the message that carries the file, not the chat's whole history (twice for each file sent, once for each received).
- Forwarding messages no longer reads the whole history of the chat or group they come from: only the messages forwarded are read.
- A chat whose contact restarts soon after a restart before is live again on the fast look, not 8 s later: in the first seconds after the contact went away, a few reads of it may go past the relays' request budget, which the earlier restarts had spent.
- On a phone, a bot's usage meter in the chat's header is the small meter and the percent ("96%"), without the reset time (a tap still says it): the bot's status beside it ("Reading…") has the room, and a long one ends in an ellipsis instead of being cut.
- The timeline's ↓ button (scroll to bottom, new messages) pressed from the keyboard or with a screen reader leaves the focus on the messages, so the next Tab reaches the message field. It used to drop the focus to the page, and Tab started again from the top.
- Taking back your reaction from its chip under a message, or pressing the red "not sent" mark to send again, keeps the keyboard focus on that message. The chip or the mark goes away once pressed, and the focus went with it to the top of the page, so the next Tab started far from the message. In chats and groups.
- Reacting to a message, or taking a reaction back, no longer reads the whole history of a long chat or group each time: only the message is read.
- Taking back the reaction the chat list shows no longer reads the whole history of a long chat or group to find the one shown before it.
- Unpinning a message with the keyboard, from the ✕ on the pinned message's bar, leaves the focus on the chat's options button instead of dropping it to the page, in a chat and in a group.
- A chat back from the background while the contact is trying to reach it is live again in about a second, not at the contact's next look (up to 8 s): the app back also reaches the contact on its other transport while it answers.

**Calls**

- The reason a chat's call buttons are turned off reads in the app's language. Pointing at them said "Calls need a live connection", "Your contact's app cannot take calls" or "Your contact needs an updated Ghostly for calls" in English in every language.

**CLI**

- A global option before the command (`--pretty`, `--profile bot`, `--home dir`) no longer changes an option whose value is `--`. Before, `ghostly --pretty profile set --name --` set the name contacts see to `--pretty`, and `ghostly --pretty edit <chat> <message> --text --` sent `--pretty` as the new text.
- `ghostly settings set constructor 5` (or `toString`, `valueOf`, `hasOwnProperty`) is refused like any other name that is no setting. Before, it was accepted and the value stayed in the profile's settings for good. The same names are no longer taken for a transport (`chat transport bob constructor` handed the engine a function), for a command (`ghostly constructor bob hi` opened the profile and answered "No method undefined") or for a method of the daemon's socket, where `constructor` never got an answer.

**Devices**

- The answer of "Check connection" on a device's row ("Answered in 12 ms", "No answer") no longer stays there for good: it goes after ten seconds, and at once when that device's link changes, so a row never says "Not connected" over an old "Answered in 12 ms".
- A move of your profile to another device stays on screen after its dialog is closed: Profile, Devices shows the steps and Cancel while it runs, also for a move the other device started with "Use here". Before, closing "Move to" left no sign of the move and no way to cancel it, and pressing "Move to" again said the other device could not hand over the profile.

**Wallets**

- An ecash token or ecash request in a message says which money it is, as every other money card does. Ecash of a test mint read "1,000 sats" with no "Test money" tag; it now carries the tag and reads "test sats". "Real money" is said for a token of one of the wallet's own mints and for a request to be paid at real mints.
- A chat takes at most twenty new payment requests a minute from its contact, and keeps at most fifty of them waiting to be paid. One left out is not lost: the contact's app sends its open requests again each time the chat connects, and it comes in once there is room. Before, there was no limit to how many a chat stored.
- With a long history of payments, the app no longer copies every payment it keeps each time anything changes on screen (typing, a file's progress, a contact coming online). The copy is made once when a payment changes and used until the next one does: at 2,000 payments, about 9 ms less work on each of those updates.

**Groups**

- Editing a message in a group no longer gets slower as the group grows: an edit reads the edited message, not the group's whole history. A bot that updates a card in place in a group read the history once for every update.
- Leaving or deleting a group with a long history no longer takes longer and longer: its messages go from the device in one step, not one at a time. On the CLI a group of 2,000 messages took over a minute to leave.
- A group's link: "New link" and "Turn off" ask first, saying that the link shared so far stops working for good. One tap, next to Share and Show QR, used to end it with no way back.
- A group's link, with the keyboard: after "Turn off" the focus is on "Turn on the link", and after turning it on, on Share. It used to be lost, so the next Tab started from the top of the dialog.
- A group's link on a phone: "New link" and "Turn off" are a full thumb's height and sit on a row of their own, under Share, Copy and Show QR. They used to be small text buttons one mis-tap from Show QR.
- Turning a group's link off from the Share link screen no longer closes the screen without a word: it stays, says the link is off, and offers to turn it on again. The screen also no longer opens by itself when the link is turned on later from the members.

### For developers

- The gate that lets a security fix release by itself now reads every lock file the repository ships from. The lock files of the Desktop's HyperDHT sidecar, of the HyperDHT relay for browsers and of Iroh for browsers were read as code: a branch that added a dependency to one of them, or took an existing one from another registry or a git repository, passed the "only versions may change" check, and their lines counted against the 600-line limit. With `SECURITY_AUTORELEASE=deps` a dependency fix in one of them was refused as a code change; it now ships like the others.
- A cancelled CI run on a pull request no longer wakes the merge train. Such a run says nothing about its commit (a newer push or leaving draft replaced it, or the train cancelled it when the pull request boarded a batch), and the run that replaced it wakes the train when it ends. In 23 hours, 46 of the 174 wakes by a pull request's CI came from a cancelled run, and the train ran in full for 29 of them with nothing to do.
- The merge train reads CI's runs on a commit, and each run's jobs, once per run of the train. For a queued pull request waiting on its fast tier it asked GitHub for the same runs list twice and for the newest run's jobs twice, 7 calls per pull request per run; it is 5 now, so a long line reaches the queue app's hourly budget later. The cancel of a boarded pull request's own CI still reads the runs afresh.
- The merge train counts a green CI run on a commit only when that run tested what the pull request's own files need. CI plans each run from the files changed against the base the pull request had then, so a second run of the same commit for another base could skip the heavy jobs, turn green, and land a pull request or a batch whose own CI was red. Such a run is now passed over and the run before it counts; with no other run the pull request waits until CI runs on it again.
- The dependency scan (`tools/scripts/security-scan.mjs`, the Security workflow) reads every lockfile that ships. It read the root's two and the site's, and skipped the Desktop's HyperDHT sidecar (56 packages), the HyperDHT relay for browsers (74) and Iroh for browsers (361 crates), which each have a lockfile of their own: a known advisory in one of them left Security green. All three are clean today. A test holds the scan's list to the repository, so a new lockfile is scanned or named as test-only with the reason.

**Apps**

- An app whose icon was shown no longer keeps its whole bundle (up to 16 MiB) in memory. The icon kept for the Apps page, chat cards and the composer's Apps was a view of the bundle's bytes, which held all of them. With ten apps of 8 MiB, drawing their icons kept 80 MiB. Now it keeps 16 MiB, the two bundles of the cache.
- A running app's storage calls, file reads and the messages it sends no longer each read the app's installed record from the device's database again. It is read once and kept until it changes (an update, its publisher's revocations, an uninstall). A run of 172 such calls made 172 reads of the record, now 1.
- An app update check on the web app and on Desktop no longer freezes the page for seconds when an app's publisher lists thousands of revocations. They are checked a few at a time, and a list that has not changed since it was last checked is not checked again.
- Opening the Apps page no longer reads each store's whole record (its list of apps, up to 4 MiB) from the device's database eight times and writes it back although nothing in it changed. The records are read once and kept, and a store is written only when its list or its state changed. A running app's next call no longer reads every store again after a check.

**CLI**

- The secret guard on `task`, `routine` and `usage` cards reads a card's text as the card carries it too. A card's lines lose their invisible characters (a zero-width space, a soft hyphen, an escape) on the way, so a key one of them broke in two passed the guard and went out whole; now it is refused (exit 5) unless `--force`.
- `ghostly button update --chosen` with a button the message does not have lists the buttons it has ("That message has no button "maybe"; its buttons: yes, no"), as `button press` does. It said "Buttons: chosen names one of the buttons".
- Calls: a program's audio stays at real time while the daemon is busy for a long stretch, such as sending a large file during the call. Every frame that is due goes out when the daemon gets to it, and after a stall of more than a second what the program wrote during it is dropped. Before, the contact heard the program about 2 s late for the rest of the call after a 200 MiB file.
- Calls: a headless call no longer runs its Opus encoder on every silent frame. Once silence has encoded to the same packet for half a second, that packet is sent again every 20 ms until the program's audio is back, so the contact receives what it did before. A call where the program only listens used 5.0% of a core at 48 kHz and 4.0% at 16 kHz, and now uses 3.9% and 2.4%.
- `ghostly task send`, `task update` and `usage send` name the flag that is wrong or missing, as a usage error (exit 2), where they answered with the card's field name and exit 1: `--steps 9/5`, a fourth `--tag`, `--pr-state` without `--pr-url` or with a word that is no state, `usage send` without `--left`, `--used` without `--limit`.
- `task send/update`, `routine send/update` and `usage send` refuse a card whose text (title, step, items, a run's summary, links, `--text`) looks like a recovery phrase, a private key or a Cashu token, as `send` does (exit 5), unless `--force`. Before, a card took any of them to the chat without a word.
- `task update`, `routine update` and `usage send` no longer read the whole history of the chat or group to find their card. The daemon remembers which message carries each card it sent or found, and reads that one message; only the first update of a card after a start still looks through the history. In a chat of 10,000 messages an update took about 120 ms of the daemon's time (a usage report twice that) and now takes under 1 ms, whatever the chat's length.
- `ghostly daemon status` and `ghostly daemon stop` on a profile that does not exist answer `not_found`, "No profile <name>: make it with `ghostly profile create <name>`" (exit 3), as `daemon restart` and `status` do. Before, `daemon status -p <a mistyped name>` answered `running: false` with exit 0, so a supervisor read a typo as a daemon that is down. `default`, which is made on first use, still answers `running: false`.
- `ghostly button update` without `--chosen`, `--close` or `--text`, `chat verify` without `--code`, and `typing` or `group typing` with a `--for` outside 1 to 600 are usage errors (exit 2) that name the flag. They answered in the words of the API's parameters ("code is required", "for must be a number from 1 to 600") with exit 1.
- `ghostly pin <chat|group> --remove` unpins. Before, it failed with "Missing <message>", and the message id it asked for was never read: any word beside `--remove` unpinned whatever was pinned. A script that names a message beside `--remove` goes on working.

**Website**

- `/developers` on ghostly.tools loads a WISP's page only when you point at, focus or touch its link: the explainer's "WISP nn" chips and the path list fetched 15 WISP pages as the page was read (1,144 KB, 35% of what it loaded). A click still opens the page at once, and the hero's button keeps its page ready.
- Pages on ghostly.tools no longer load the roadmap ahead of time. Its page data is 310 KB, and every page fetched it for the link in the main nav and the footer: over half of the 553 KB a page prefetched. `/roadmap`, `/cli` and `/developers/agents` also fetched up to four WISP pages for their "read more" links (up to 356 KB more). A link to the roadmap or to a WISP's page now loads it when you point at, focus or touch the link, and a click still opens the page at once. The other pages of the nav load ahead as before.

### Security

**Wallet**

- A Lightning address or LNURL service that redirects is checked at every hop before anything is sent to it. Ghostly Desktop and the CLI follow a checked redirect; the web app and the extension refuse a service that redirects.
- One payment pays one request: a second receipt for a request that already has one is no longer stored or shown as another payment.

**Groups**

- An invitation that waits for your answer, or a leave not yet heard, is no longer replaced by an invitation from another contact.
- A member invited again joins the history it kept only when the welcome continues the same group.

**Chat and devices**

- Ghostly Desktop counts a relay's answer as it arrives and gives up past the size limit, instead of reading it whole first.

**Apps**

- An app that sends ten times the allowed request rate is stopped.

**CLI**

- A call that ends while it is being answered or placed closes its audio socket.
- A name that a contact or a member chose never takes the place of a group's id, a group of yours or a member's key.
- `file save --dir` writes a file whose name starts with a dash with a `_` first.
- An agent turn's ids are made on this device.

**Website**

- The site's compose file publishes its port on this machine only by default (`WEBSITE_BIND` opens it to a proxy on another address).

## 1.2.0

### For users

- The errors people meet most often (amounts, wallets, chats, files, groups, settings) now read in your language, with the original wording behind the ⓘ.

**Apps**

- **Apps are in Ghostly.** The Apps page installs mini-apps from the official store, from a link or from a contact's card, each checked against its publisher's signature and run in a sandbox. Chess is the first: play it with a contact in a 1:1 chat. On the web app and on Desktop for macOS and Linux.
- **The Apps page.** It lists your installed apps and your stores, starting with the official Ghostly Store. **Add** takes the link of an app or of another store. A store shows its first 50 apps, with a search and Show more past that.
- **You see what you install.** Before anything is installed, Ghostly checks the app against its publisher's signature and shows the publisher's key, the store that lists it, what the app asks for (talking to the same app on your contact's side, your name in that chat, the internet) and who learns your IP address when it downloads.
- **Play with a contact.** In a 1:1 chat, + > Apps opens an installed app with that contact, and they get a card with Install and open. Apps are live: you are both online, each side keeps the game, and it is back when you open it again or after a reload.
- **An app keeps Ghostly's look.** On a wide screen it opens beside the chat, which stays usable, with Full width and Close. On a phone it covers the chat, with Back to the chat. On Desktop it gets a window of its own, titled after it and the contact, such as "Chess with Ana". A full-screen app opens alone from the Apps page.
- A contact on an older Ghostly, or on a client that runs no apps, sees the card as a line of text with the app's link, and + > Apps tells you their app can't run apps.
- **Apps run in a sandbox**, apart from your chats, keys and wallets. An app reaches the internet only with the permission you grant at install, and then over HTTPS and WSS only. In Safari, and in every browser on iPhone and iPad, an app can still contact other servers: the install screen says so there.
- **Updates you can trust.** An app installed from a store updates only to the version that store lists. A version its publisher revoked never runs. A version a store removed stays stopped until you choose Run anyway. An update that asks for a new permission waits for you.
- **Uninstall** deletes an app's files and its data in every chat, and offers an export of that data first. Deleting a chat removes what each app kept for it.
- ghostly.tools/apps lists the apps of the Ghostly Store, each with its own page: what it does, what it may do on your device, who signed it, and how to install it in Ghostly. The site checks the store's and each app's signatures with the app's own code when it is built, and serves the icons itself, so your browser asks no one else. The pages, their links and the privacy policy's lines about stores appear only once the released Ghostly has Apps.
- The docs say how to use Apps: [Apps and the official store](docs/APPS.md) has where they run, how to get one, what an app can and cannot do, and how updates and takedowns work. The README and the feature list name them.
- **Where apps run:** the web app and Ghostly Desktop on macOS and Linux. Not yet on Desktop on Windows or in the browser extension, which show no Apps. A contact there sees your app card as text, and you are told their app can't run apps.
- The Apps screens are checked for accessibility (WCAG 2.2 A and AA, light and dark, left to right and right to left), work with the keyboard and a screen reader, and show an app's title, tagline and store names in their own direction in every language.

**Groups**

- A long group (or chat) left open while it catches up no longer freezes the page: the messages that come in a row are drawn together, about once every 50 ms, instead of the whole history being drawn again for each one (a 256-message catch-up in a group of 10,000 messages took about 12 seconds of the page's time).
- A member turned away because everyone holding a group file was already sending it to others now gets it as soon as one of them is free again; before, it could wait up to 30 seconds more with that member online and sending nothing.
- A group file that arrives damaged from every member who has it is fetched once, then says it did not arrive, with Ask again to try once more; before, it was downloaded again in full about every 34 seconds, without end, while it said nobody connected had the file.
- A group file that stops coming mid-way (the member sending it went away or its app was closed) goes on from what already came, from that member once it is back or from another member who has it; before, what came was deleted after 30 seconds and the file started again from the beginning.
- A member that goes away mid-way through a group file (phone asleep, app closed, removed from the group) no longer keeps one of the three places a member's app serves files from: within 30 seconds the place is free, and the next member who asks gets the file instead of waiting forever.
- A group file that cannot come yet says why: "Busy, trying again soon" when the members who have it are busy, and "Arrived damaged" with Ask again when what came did not match the original; before, every case showed the same waiting line.
- Files and voice messages in groups, from the CLI too (`ghostly file send <group> <path> [--voice]`): everyone in the group sees the file at once, voice messages and files up to 8 MiB download by themselves, and a member who was away gets the file from any member who has it. An app from before shows a line that names the file.
- Several files or voice messages sent to a group together come one after another from the member who sent them, each as soon as the one before it is in; before, all but the first could wait 30 seconds or more each, with that member online.
- Send files, pictures, videos and voice messages in private groups and communities from the composer, as in a chat, up to 100 MiB a file. Each member sees who sent it, downloads it with one tap, and sees when nobody they are connected to has it yet.
- Forward and Share to now list your groups for files too.
- Settings, Data & storage, has "Download automatically in groups": Off, Wi-Fi only (where your browser can tell) or Always, the default. It is set per device and nothing about it is sent to the group.
- When a group's membership history forks for a reason the app names (a member with another history, the admin's two branches), its line in the chat reads in the app's language, as other such lines do; before, it showed the reason in English.
- Coming back to a private group with a long history no longer stalls on the reactions the others say again before their messages arrive: a reaction to a message not here yet waits after a lookup of that one message, and the message landing takes its reactions without the whole history being read again (7 members' reactions in a group of 10,000 messages took about 15 seconds).

**Everywhere**

- The local web apps you share with a contact over a chat are called Shared services everywhere now: the dialog the chat's + opens ("Shared services with Ana"), Clear all data, what a backup holds, and the Desktop dialog that asks before a contact reaches a local address.

**Chat**

- The Tasks board reads its cards once when the app starts, and again only when a message brings, edits or removes a card. Before, every message in a bot's chat read every card of the profile again, and so did each chat history loaded at start (a profile with 2,500 cards read about 73,000 card rows in its first 15 seconds).
- A bot's usage meter in the chat list stays in the same place on every row: right after the contact's key in Comfortable, and in a column of its own before the unread count in Compact. It no longer moves when a chat has unread messages.
- A bot's chat says what it is working on at the top, beside its usage meter ("Working · Fix relay rotation"), and when it last gave an update once it goes quiet. Tap it to open the bot's tasks. Opened from the keyboard, the tasks give the focus back to that line when they close.
- The chat list shows when a bot is working: a small dot beside its name (beside its key and usage meter in the Comfortable list) while one of its tasks is running. It turns into a grey ring when the bot has not updated its tasks for 15 minutes, and goes away when nothing is running.

### Fixed

- In Arabic and other right-to-left languages, a switch that is on keeps its knob inside its track.
- A bot's usage card says when its numbers were read, not when the card was last sent, so old numbers no longer read as updated now.

**Chat**

- A voice message or a video that comes into the open chat is read out to a screen reader in the app's language ("Ana: 🎤 Mensagem de voz (0:07)"), as the chat list, quotes and the pinned bar already say it. Before, it was read in English in every language, in chats and in groups.
- A message written in the other direction from the app's language (Arabic in the English app, English in the Arabic app) no longer has its time stuck to its last word.
- In Arabic a voice call's line at the top keeps a space between "Audio call" and the clock; the two were stuck together.
- A first pairing straight over the DHT (Linux Desktop, CLI) goes live a second or more sooner: each side reads how to reach the other as soon as it learns of it, instead of waiting for its own record to finish going out.
- When a chat is live again, the cards that went as text while your contact was away no longer go again all at once: only the latest version of each card goes, one every 2 seconds.
- A chat or group open at its bottom no longer freezes for seconds when thousands of messages arrive at once (a contact's backlog, or the history catching up after the app was closed): only the last messages are drawn, as when the chat opens. Scrolled up, those messages are counted on the ↓ button and drawn when you go down.
- Deleting a chat with a long history no longer deletes its messages one at a time: the whole history goes in one step, and the chat list stays responsive while it does.
- With many bot cards in a profile, the chat list and an open chat no longer go through every card again each time the app checks its connections: the working dots and usage meters are worked out only when a card comes, changes or goes. Before, a profile with 2,000 cards spent about 5 ms on it several times a second while nothing changed.
- With many chats and groups, the chat list no longer redraws every row each time the app checks its connections while nothing arrives: a row is drawn again only when what it shows changes, so the app stays quiet and responsive.
- When a chat refuses a message or an edit (too long, the invite was taken by someone else, you are offline, the message you reply to is gone, too many edits), the composer says why and what to do in the app's language. Before, it showed the reason in English in every language.
- A long chat list starts and idles with less work: each row's mute menu worked out the end time of every duration on every redraw, even while it was closed (about 1 s of a start with 70 chats and groups, and about 0.5 s of every idle 20 s). It now does that only when the menu opens.
- A long message in a chat or a group counts the way it is sent: 16 KiB, where an accented letter takes two bytes, most Chinese or Japanese characters three and an emoji four. Near the limit the field shows the bytes left, and a message past it stays in the field with why, in your language, instead of the field saying there was room and Send coming back with "Message exceeds 16384 UTF-8 bytes." in English.
- When a contact joins with your invite and the chat connects in under a second, you hear the "connected" sound again. On a quick network it was left out, because the knock that announces the contact had started less than a second before.
- A chat's connection panel closes when Tab moves the focus out of it, so on a phone the focused button is never hidden under the panel.
- In Arabic, the first line of a chat's connection panel keeps the round trip's number next to its unit instead of moving it beside the transport name.
- A chat whose contact's app crashed and was opened again a few seconds later is live again about 3 seconds after it is back. It could take 11 seconds: the app that stayed looked for the contact only once, at the moment it noticed the connection had stopped answering.
- A `ghostly` daemon with long histories answers its first command right after it starts, and `ghostly daemon stop` is done, in a fraction of a second. Before, the daemon read every chat's whole history again after it had read them at start, and once more at stop, which could take about 2 seconds each with 50 chats of 1000 messages.
- Deleting a file that is still sending or arriving no longer says "Your contact keeps their copy": deleting it stops the transfer on both sides, and the confirmation now says so (sending stops and your contact won't get the file, or it stops arriving and your contact sees it cancelled).
- On Desktop, a paste the app cannot take (a picture too large, a paste that expired, a clipboard it cannot read) is said in your language with what to do next, such as sending it with + → Document, instead of in English.
- On Desktop, pasting several copied files that are over 256 MB together says they are too large to paste, instead of
  reading all of them into memory before the send sheet shows (up to 32 files of 256 MB each).
- On Desktop, saving a file, audio or video from its bubble to a folder you cannot write to, or to a full disk, now says "Couldn't save the file there. Try again and choose another folder." in your language, instead of the system's English ("Permission denied (os error 13)").
- On Desktop, the connection panel's Details say "DHT direct" as soon as the app has read the DHT, not "Not read yet" on a chat that is already live.
- When a chat cannot connect because you and your contact allow no transport in common, no transport connected, your contact closed the connection, or their app cannot switch transports, the chat's connection panel now says so in your language with what to do next ("Allow another transport, or turn Fallback on"). Before, it showed a red English sentence in every language. The original message is behind the ⓘ.
- On desktop, a Download from a message's menu that the system refuses (a folder you cannot write to, a full disk) now says "Not saved. Try another folder" and stays available, with the system's reason in its hover text. It used to say the file was not on this device and grey Download out.
- Turning Fallback on or off in a chat on Automatic no longer pins the chat to one connection.
- `ghostly daemon stop` (and quitting the app) publishes nothing after saying goodbye to your contacts except the packet that says the app left. Before, a chat could start a new connection offer and publish it about 3 seconds after the goodbye. A daemon stopped soon after it started is also done in about 0.1 s instead of 3 to 5 s: it no longer waits for a HyperDHT or Iroh connection that is still starting.
- Keyboard: Download (or Accept, Decline) on a file, a voice message, an audio or a video keeps the focus on that message once it is answered, in a group and in a chat. The next Tab goes on from there, to Save once the file is here, instead of starting again from the top of the page.
- A double click on a button inside a message (a file's Accept, Pause, Cancel or Save, a voice message's Play, a link) no longer opens the message's details as well; a double click elsewhere on the message still does.
- A large file its sender cancels mid-way leaves nothing on the receiver's device: before, when the pieces arrived faster than the device stored them, the ones still waiting to be written were stored after the part was removed, and that leftover stayed on the device.
- A file your contact's app could not take (no room on their device, too many files waiting, arrived damaged, not accepted in time) now says why and what to do next in your language, instead of "Not sent" with the reason in English. An error the app does not know is still shown in English behind the ⓘ, now laid out as English in Arabic.
- A large file you paused before your contact accepted it stays paused when they accept: before, the pause was lost about a second later and the file went as soon as they said yes. Your contact sees it paused by you until you resume.
- A file too large for your contact's free space or for their app is now refused in your language, with what to do next, instead of always in English.
- Forward says why a chat refused a message in the app's language, not in English.
- A message held for an away contact whose storage is full (64 items or 64 MB waiting) now says so on its red mark, in your language, and that it can be sent again once they pick some up. Before, it only said "Not sent. Tap to send again.", and each tap failed again with nothing on screen.
- Messages held for an away contact: the line above the composer and ⋮ → Hold messages now say what went wrong and what happens next in your language, such as "Couldn't pick up what your contact left for you. Ghostly tries again by itself." What the storage or the network answered is behind the ⓘ instead of in the line.
- The first HyperDHT connection a freshly started Desktop app makes no longer opens and then carries nothing for seconds (a patch to hyperdht until a release of it has the fix).
- On a slow connection (a round trip of more than about 0.7 seconds), the Desktop app and the CLI no longer drop a HyperDHT connection that is only slow and dial it again. The wait for a silent HyperDHT connection now follows the connection's measured round trip, from 2 to 8 seconds: on a 3-second path a chat goes live with one dial, 2 seconds sooner. Fast paths still dial again after 2 seconds.
- Opening an invite someone else already used now tells you so within seconds. Before, it took about 5 minutes, and meanwhile the chat showed "on the DHT" and your first message showed as sent.
- A new invite's first message to the person who opens it goes on the DHT as the invite is made, not two seconds later after a first look at an empty mailbox. Two Desktops that find each other on the DHT alone go live sooner after an invite.
- A Linux Desktop that joins an invite says it is there as it opens the chat, not after it first reads the inviter's record: the inviter sees it a read sooner, with no extra DHT put.
- A chat stopped because the contact's key changed now says "This chat stopped: your contact's key changed." in your language on its file, media, voice and payment buttons, instead of a long English sentence.
- On Linux Desktop, which has no WebRTC, a chat's Automatic connection says it puts Iroh first, the connection panel no longer says both apps rank HyperDHT first when the contact's app ranks WebRTC first, and Settings no longer shows the HyperDHT relay field the Desktop ignores.
- On Linux, files copied in a file manager (Nautilus, Dolphin, Thunar) and pasted into a chat open the send sheet again,
  and copied files that cannot be read say so instead of doing nothing.
- On Desktop on Linux, pasting another screenshot or copied file while the send sheet is open adds it to the sheet,
  instead of doing nothing. A paste that cannot be added (too large, unreadable) now says so on the sheet itself, not
  behind it.
- On Linux, a copied picture pasted into a chat opens the send sheet much sooner: making a 4K screenshot ready took 1 to
  6 s with nothing on screen, and now takes 0.2 to 0.6 s. The picture sent is 10 to 20% larger.
- Messages that arrive together while Ghostly is in the background show one system notification per chat, not one per message. A mention still shows its own.
- A chat or a group member no longer stays "Connecting" for a minute and a half when the two apps' first attempt to connect fails on one side. That app asks again at once, and the other one, still busy answering the first request, used to drop the second and never answer it: nothing went through until the attempt ran out. It now answers the newer request.
- Pairing two apps without WebRTC (such as two Linux Desktops) on a slow DHT no longer shows the chat as On DHT while neither app has learnt how to reach the other yet, and no longer waits up to three minutes before the next try.
- The pairing progress says why it is slow or failed in your language only: the relay or connection error behind it is behind an ⓘ, and an invite someone else took is no longer said a second time in English.
- On Desktop on Linux, a paste that finishes reading after you began editing a message now says it could not be
  added, instead of vanishing in silence.
- On Desktop on Linux, a pasted screenshot or copied files say "Reading what you pasted…" while they are read, instead
  of showing nothing until the send sheet opens. Pressing Ctrl+V again meanwhile no longer puts every file on the
  sheet twice.
- When someone takes a reaction back, the chat list no longer says they reacted until the app restarts: it shows the reaction before it again, or none.
- Reloading the web app with many long chats no longer stalls the page while each chat's history comes back from the peer: the chat list reads it once, and only the chats that changed.
- Send again on a message or file that was not sent says why when it cannot be sent (no S3 storage to hold it, a file that is gone), under the message, instead of doing nothing. So does Cancel sending.
- Sending a text no longer gets slower as a chat grows: a send and its receipt read the message itself, not the whole history. On the CLI, a send in a chat of 1,300 messages took about 650 ms of CPU.
- With the Tasks page open, the board is no longer built and drawn again each time the app checks its connections while nothing arrives (a few times a second, and twenty a second while a file moves or a group catches up): it is built again only when a card, a chat's or group's name, a member's name or a contact's picture changes. With thousands of cards the page stays responsive.
- A chat's connection details say in your language why HyperDHT or Iroh is not listening (its relay unreachable, silent or refusing, or the endpoint stopped). When all eight native connections are in use, they also say what to do: disconnect another chat's native connection, or wait for one to go quiet.
- On a phone, a transport the chat can't use (Iroh or HyperDHT on the web) says why under its name in the connection panel, where before only a hover tooltip did.
- Verifying a contact when the connection changed or closed just before "The codes match" now says "The code changed" or "The connection closed" in your language, next to the code, with what to do next. It no longer turns the chat's connection icon red as a connection issue.
- A screen reader names a video in the app's language ("Vídeo, 0:12" in Portuguese), and the system's media controls show "You" in that language as the artist of an audio file you sent. Both were English in every language.

**Wallets**

- An Ark request keeps one waiting receipt from the contact. Before, every further receipt the contact sent for it was kept waiting with its own chat line, and each one was checked with the Ark server again on every check.
- A Bitcoin Core wallet pays an address written in capital letters, the way a `bitcoin:` link reads in a QR code. Preparing such a payment always failed with "The node built a transaction that does not pay the address and amount asked for", though nothing was spent.
- An ecash token in another unit than sats (a usd token, say) is shown as one: "A usd token" and "Only sat ecash can be redeemed here", with no Redeem button. Its card used to read a $5.00 token as "⚡ 500 usd" and offer a Redeem that always failed with "That is not a valid ecash token". Redeeming one now says which unit it is in. A Cashu payment request in another unit is shown the same way.
- An ecash token of 10 or more coins (about 1,000 sats and up, as the app's own Send makes them), or a very long payment request or invoice, shows as its card again, with Redeem and Copy. It no longer fits one QR code, which broke the message ("This message could not be shown."); the card now says it is too long for a QR code instead.
- A Cashu payment that never reached the mint now says so in the app's language, with "Nothing was sent, and the sats are back" in the line. So do a USDT payment that was never sent and one whose transaction was reverted. All three were in English in every language.
- A payment's review takes the keyboard focus when Review payment opens it in a chat, and keeps it after Approve. Before, the focus fell to the page each time and the next Tab started again at the top.
- On a Cashu or Lightning card, the keyboard focus moves to the invoice once Receive makes it, and to the quote once Send has asked the mint, so the next Tab is Copy or Pay. Before, it fell to the page and the next Tab started again at the top.
- A Cashu wallet update no longer slows down as its history grows: each network reads only the 100 movements it shows, so a long Testnet history no longer slows Mainnet payments or pushes Mainnet movements out of the Mainnet history.
- A long invoice or address and a long wallet History scroll with the keyboard too: Tab reaches them in Safari, the iPhone app and the Desktop app, where only a mouse or a finger could scroll them before.

**Everywhere**

- A profile backup with many pictures, voice notes and files no longer freezes the app for seconds while it is written: each 16 MiB file now takes tens of milliseconds instead of over a second.
- Sending a file costs much less of the app's time: each piece of a file is turned into text before it goes out, and that step took about 45 ms per MiB (some 9 s of a 200 MiB file's sending). It now uses the browser's or Node's own encoder where there is one (about 0.3 ms per MiB) and a faster one elsewhere (about 3 ms per MiB, e.g. the CLI on Node 22 and 24). The same text goes over the wire, so nothing changes for the contact.
- The web app in a browser it cannot start in no longer ends on an empty page when the browser was slow to answer at the start: after showing "Ghostly is already open in another tab" for a moment, the page now says "Ghostly could not start", with the details to copy, as it does when the browser answers quickly.
- A Cashu payment from a wallet that took in many small payments reaches the contact. Its coins could add up exactly in hundreds of small ones, a token too long for the contact's app, which dropped it: the payment stayed pending and the contact never saw it. Such a payment is now made of a few coins from the mint first.
- `ghostly settings set nick 2024` sets the name 2024: a nick that also reads as JSON (a number, `true`, `null`) was refused with "nick must be a string".
- The CLI and Desktop-headless load a profile's saved store much faster at start. A profile with 70,000 messages took about 9 seconds to load before a daemon, or any command run without one, could begin. It now takes about 0.7 seconds. The store is also no longer rewritten at every start when nothing changed since it was saved.
- A `ghostly` daemon that was killed or lost power is ready again in about the time of a normal start. Before, it replayed what it had saved since its last stop one write at a time against the whole profile, and could take tens of seconds to minutes after a busy chat.
- Chats and groups connect on a shared Wi-Fi or office network from a computer that also has virtual machine networks, Tailscale or a VPN. Before, such a computer could tell its contacts only the addresses of its virtual machine networks, which nobody else can reach, and the connection then depended on the router.
- A name that starts with an emoji shows that emoji in its round avatar (chat list, chat header, calls, group members, profiles); it showed "�".
- The app opens with less to load: the web app ran 7.4 MiB of JavaScript before its first screen, with all eight languages, every page and the Ark and USDT wallets' libraries in it. It now loads only the profile's language, opens Settings, Wallet, Services, Profile, Identities, Apps and Tasks the first time they are used, and loads the Ark and USDT libraries when those wallets start: 4.2 MiB before the first screen.
- A member back in a private group after many messages gets them in about a minute. Before, when the author's connection came up first, the rest came from the other members 32 a minute: about five minutes for 200 messages, with everyone online.
- A member back in a private group gets every message it missed that the other members hold, up to the group's last 256, also from an author who is online. Before, an author already connected handed on only its own last 32 messages, and the older ones never arrived although the others had them.
- Moving a profile with many files to another device no longer slows down as it goes. The device taking the profile kept one list of the files it already had and rewrote all of it twice for every file, so each photo or voice note cost more than the one before (about 0.77 GB of text through the page's storage for 2,000 files). Now each file is noted on its own, and a move that stopped before an update still goes on from what it had.
- When Ghostly closes or its CLI daemon stops, a contact connected over HyperDHT hears that it is going, as a contact over WebRTC already did, and looks for it to come back. Before, the goodbye was dropped unsent and the contact found out only when the connection closed.
- With many chats and nothing happening, the app no longer redraws the whole chat list about once a second. Each routine read of a chat's link or mailbox used to send the whole app state to the page. Now the state goes out only when something the list shows changes, or for the chat that is open.
- Settings > Network says only "Use an https:// relay address" with the address you typed when it refuses a plain http:// Iroh relay, in your language, without "Something went wrong" in front.
- Notification sounds no longer play on top of one another. When many chats and groups catch up at once (after the app restarts, or while bots post), you hear one sound instead of a pile: messages from all chats that come within 1.5 seconds are one sound, and for a second after a sound starts no other one plays (a mention or a payment that comes with a plain message is the one you hear). A ringing call is never cut short, and nothing else plays while it rings.
- With many chats, the app spends less time each time the screen updates: a chat's own key is worked out once, not again every time the chat list is drawn. With 50 chats, about half of that time went to it, on the page's own thread on the web and on Desktop.
- Paying a contact whose app has closed says at once that they are offline and nothing was sent. Before, the payment waited about a minute and a half for an app that had said it was going, then said only that it could not connect.
- An app that stays open no longer uses more memory for every file it receives. Each received file kept 256 KiB until the app quit, whether the file arrived, failed or was declined (about 250 MiB for 1,000 photos or voice notes). Now that memory is freed when the transfer ends.
- Settings > Network says "Not a relay address" and the push relay's "Use an https:// relay address" in your language, with the address you typed. In Portuguese, Spanish, Italian and Arabic, "https://" now comes before the address's colon, so the line no longer reads like a typo.
- In Arabic, the Share to… page shows a shared English text and file name in their own direction: "Look at this, it's great!" no longer reads "!Look at this, it's great".
- The Privacy Policy and Terms of Service pages on ghostly.tools rest the footer's moving ghosts while you read far above them, as the other pages do. They used to keep them moving the whole time, using about three times the processor of the other pages while you only read.
- The moving ghosts on ghostly.tools (the rising ones, the network's twinkles, the footer's sleeping ghost) really rest while they are off screen. The site marked them to rest, but their own animation kept them going.
- The little ghost that follows the pointer on ghostly.tools now rests when the pointer stops near the window's right edge or the page's bottom. It used to keep moving there for as long as the page was open, using the computer's processor the whole time (about a sixth of a core in our measures).
- Web app: wake-ups no longer turn themselves off when you close the app right after you mute a chat or delete a contact. The app replaces its push subscription then, and a page that was being closed read notifications as blocked and switched wake-ups off for good, with nothing said. Now a page that is hidden waits until you see it again before it believes that notifications were taken away.
- On the light themes, warnings (a DID identity's "Experimental" line, the wallets' seed, Mainnet and server warnings, device and backup warnings) are dark amber instead of a pale yellow that was hard to read.
- ghostly.tools asks GitHub for the latest release at most once an hour again, also while GitHub is rate-limiting it or not answering: before, each visit to the Apps pages, Privacy or the sitemap asked GitHub again and waited for it (up to 10 seconds), and a few dozen requests kept the site's GitHub allowance drained.

**Calls**

- On a network that blocks STUN (many office, school and hotel networks), a call rings about 2 s after you start it and connects about 2 s after Answer, instead of about 10 s each.
- Ghostly Desktop on Linux draws its first screen without waiting for the call engine (GStreamer) to start and check its plugins, which took about 0.6 s more on a first launch or the first after a GStreamer update.

**Groups**

- A member whose app is slow to take in a catch-up after time away (a phone with a long history) is sent the next part only once it took in the last. Before, it could be handed over a hundred messages at once, and an older app ended the connection.
- Deleting a community from this device now leaves it first, so the others no longer keep you as a member, and an admin hands the role on instead of leaving the community with no admin. With nobody connected to take the leave, the delete waits and says why.
- A community's member list no longer says every member is reached "Through a hub" while your app reaches nobody (offline, or every hub's app closed): each member says there is no connection yet until a hub is linked again.
- A group with only you in it (just created, or everyone else left) says "1 member" at the top, not "1 member · 0 of 0 reachable".
- In a large private group, a member who leaves while the admin's app is closed is taken out of the group once the admin's app is back, instead of staying listed for everyone.
- In a large private group with three or more hubs, a member's leave no longer goes round the hubs again and again while the admin is away.
- In Arabic, a member's English name in a group's connection panel is cut at its end ("Hermes Two with a much…"), not at its start.
- In Arabic on a wide screen, a group's connection panel opens inside the window again instead of partly off its left edge.
- Declining an invitation back into a private group you were removed from no longer deletes the history you kept, your own messages included: the removed group stays as it was.
- The admin of a private group could delete it from their device while no member was online, and the group was left with no admin for good. Deleting an active private group now says it leaves the group and who becomes admin, and waits, as Leave does, until a member is online to take over.
- Coming back to a private group with a long history is faster: the links to the other members that open together read the group's history once, not twice each.
- In a community, a file whose announcement came before more than 64 membership changes (joins by link, leaves, removals) can still be downloaded by a member who got the announcement and is still in the group; before, every member who had it refused it, and the download waited forever.
- A file a group cannot take right now (more than 8 files sent to it within a minute, or you are no longer in the group) is refused at once in the app. Without this, the app first copied the whole file into its storage and checked it, up to 100 MB, and only then said no and deleted the copy.
- Sending many files to a group, the app asks you to wait after 30 in 10 minutes, as many as the other members take from one person. Before, it let up to 8 a minute through, and from the 31st on the others saw "update Ghostly to get files in groups" with no file.
- The files of a group you left on an earlier version, which stayed on the device where nothing showed them, are removed the next time the app starts. They no longer take space or go into a backup.
- Accepting a private group invitation after the admin's app restarted (a reloaded tab counts) no longer waits on "Joining..." for good: the admin's app keeps its pending invitations, the invitee's app says its accept again when the admin is back, and a new invitation from the admin replaces one that was never answered.
- When a private group is full, its Invite a contact list now says so under the heading, counting the invitations nobody has answered yet, instead of only greying out every Invite button.
- Inviting a contact who already joined a private group through its link no longer leaves "Invited…" on their row until the app restarts, and no longer counts toward the 32 members.
- Leaving a group takes its files off the device with its history. Before, the files of a community you left stayed in storage for good, where nothing listed them, and those of a private group stayed until the admin's app had heard of the leave (up to a week with the admin away). Only "Delete from this device" removed them.
- Turning a group's link off now says that the link shared before stops working for good, and that turning it on again makes a new link to share.
- Pasting or opening a group's link while Ghostly is offline says "You are offline" in your language, and to go online in Services, instead of an English line. From a link, it stays until you close it, with any detail behind the ⓘ.
- A group member reached only over Iroh or HyperDHT is reachable again once the network comes back. If those connections could not start while the network was down, the app now tries again instead of waiting for a restart.
- A new group's name stopped at 48 characters, while renaming the group took 64; both now take 64.
- In a private group, a reaction a member missed while away now reaches them when you connect again. Before, once you had reacted to more than 30 messages, the newest two were dropped every time.
- A member back in a busy private group now sees the reactions made while it was away; before, most of them were dropped while the missed messages were still coming in.
- After being removed from a group, your own earlier lines there still read "You are now the admin" and "You renamed the group", in the app's language, instead of naming you as an unknown member.
- A member whose app was closed when the admin role moved no longer reads that the new admin renamed the group or changed its picture when the former admin did: the line now says what changed without naming anyone.
- A reply received in a group with a long history no longer reads and sorts the whole history to find the message it quotes, so catching up on many replies is fast again and the CLI daemon no longer stalls for seconds. Replies to texts in chats are looked up the same way.
- The app opens faster with groups many members have left: the leaves it already checked are not checked again at every start (about 1.5 s per group with 950 leaves before).
- A member of a private group whose connection once failed on some network (a VPN, a firewall) is reachable again after the app restarts on a network that works. Before, the other members' apps kept trying the fallback route that member no longer used, and showed it as unreachable for good, whichever app was restarted. Members on a version already released reach it again as soon as that member's app is updated.
- "Make admin" beside a member handed the group's only admin role over in one tap, with nothing asked, and read as adding an admin; now it says "Hand over admin" and asks first, naming the member and saying that only they can give the role back.
- Someone joining a community by its link is no longer told that another person is waiting to be let in when that person had just got in.
- Leaving a community says that its link brings you back, no longer that someone has to let you in again.
- Leaving a community while no member's app is there to take it says so as a wait, no longer in red: Leave comes back by itself once one is.
- In a private group of more than 16 people, when its only hub leaves, the members connect to each other within seconds. Before, nobody's messages reached anyone for about three and a half minutes.
- On a Mac, being removed from a large private group you were a hub of no longer leaves your other groups with fewer connections until the app restarts.

**Desktop**

- A picture or a file pasted into a chat on Desktop no longer stays in the app's memory after it was read: before, each pasted picture's PNG was kept until 64 later pastes or 256 MiB of them pushed it out, for as long as the app ran.

**Files**

- A file offered with a long name and no spaces no longer runs out of its bubble and off the screen: the "wants to send" line wraps, so its size and the Accept and Decline buttons stay in view.

**Devices**

- Moving a profile back to a device that still holds its files starts sooner: that device opened its old copy's database once for each file and read every copied file twice. It now opens it once and checks each file as it copies it.
- Taking a profile on another device ("Use here", "Move to") ends sooner when the profile has many files: the last step, while neither device can be used, wrote each file's record on its own. With 2,000 photos it took about 6 seconds in Chrome and now takes about half a second.

**Invites**

- On Desktop on Linux, a screenshot of an invite's QR code pasted into Join (Ctrl+V) is read, as the dialog says it is,
  instead of doing nothing.

**Self-hosting**

- The web image's `latest` tag (`ghcr.io/miguelmedeiros/ghostly-web:latest`, what `infra/docker-compose.yml` pulls) moves only once a release is published, and never back to an older version: a release that stayed a draft, or an old tag built again, no longer reaches self-hosters who pull. The image's `/version.json` names the tag's own commit.

### For developers

- A release's notes put their headings in one order, Security, For users, Fixed, For developers, whatever the names of the files in `docs/changelog/unreleased/`. Before, the heading of the first file in name order led, so the notes could open with "Fixed".
- CI runs on pull requests into `epic/*` branches and on pushes to them, so a large feature's slices are checked before its umbrella pull request reaches `dev`.
- The Desktop compatibility e2e runs on Linux distributions without `dpkg-deb` (Arch): the v1.1.5 package is unpacked with `tar` there, and the test skips with the reason where nothing can unpack it.
- The compatibility e2e also runs a real v1.1.5 beside the current app: a chat from either side's invite with texts delivered both ways, and a private group where a member on 1.1.5 back after its app was closed catches up from a current member, and the other way.
- The Desktop e2e chooses in a select only once the page that holds it is drawn: the language test opened Settings, which now loads when first opened, and failed with "Nothing to click at settings-language" on a machine where the page took longer than WebDriver's answer.
- The Trusted Web Activity wrapper for Android (`apps/android-twa`: the web app in a Chrome window) is removed, with the web app's `/.well-known/assetlinks.json` that only it used. No release ever carried a build of it. On an Android phone, Ghostly is the web app, installed from the browser ([On the web](docs/WEB.md#install-it)).

**Apps**

- The Chess end-to-end tests run a pinned copy of Chess (`e2e/fixtures/chess`) instead of building it on the fly. It is Chess 2.3.0, taken from the bundle its publisher signed in Chess's own repository: `node tools/scripts/refresh-chess-fixture.mjs --bundle <a file, or a URL pinned to a commit>` checks the publisher key and the hashes and writes it, and `--check` compares the fixture with that bundle again. The fixture is no longer built from `apps/mini/chess`, and CI no longer compares the two.
- The Chess end-to-end tests play the new board (a game starts with an invitation the contact accepts), check that the install screen asks for your name in the chat, and cover the update from Chess 1.0.2 to 2.3.0, which waits until the person agrees to that new permission.
- Mini-apps are built to WISP 1200: a signed `.ghostlyapp` bundle of up to 16 MiB with one HTML entry, a manifest that names its permissions (`chat`, `internet`, `name`) and where it shows (`view`: `chat`, the default, or `full`), signed store indexes and revocations, and the `paired-app` frame of `apps/1` in 1:1 chats, live only.
- The formats are forward compatible: Ghostly reads a manifest, a store index or a listing that carries a key it does not know yet, and the signature still covers every byte. `ghostly app publish`, `ghostly store sign` and a store's own check still refuse an unknown key. Every store listing carries a jsDelivr URL pinned to a commit, which Ghostly reads first.
- An app talks to Ghostly only through `window.ghostly`: its own storage per chat (keys of 256 bytes, values of 64 KiB, 5 MiB per app and chat), messages to the same app on the contact's side, its own files, and with `name` the name the profile shares in that chat. The API and limits are the same on the web app and on Desktop.
- The CLI's and the extension's engines offer no `apps/1` and refuse the app calls, as does Desktop on Windows.
- The official store is [github.com/MiguelMedeiros/ghostly-store](https://github.com/MiguelMedeiros/ghostly-store): a curated list of apps added by pull request, checked by CI with the Ghostly CLI and signed offline by the owner. Ghostly reads it from `raw.githubusercontent.com`, pinned to the store's public key, and only once the person opens the Apps page or has an app installed. Chess is listed, signed by a publisher key of its own. How it works and how to submit an app: docs/APPS.md.
- An end-to-end test plays Chess between two web apps: installed from a signed store and from the card, a full game, close and reopen on each side, the game back after a reload, and a tampered bundle, a lower sequence, a removed and a revoked version refused. On Desktop, a test installs an app from a store and opens it in a window of its own, which reaches the broker and nothing else.
- The compatibility e2e runs a real v1.1.4 beside the current app: an app card reaches it as its text with the bundle link, no `apps/1` is offered and the chat goes on. The accessibility test (axe) covers every Apps screen.
- Self-hosting: docs/WEB.md names the two apps runner pages (`/app-frame.html`, `/app-frame-net.html`) and the headers a web server other than the Docker image must send with them, or the client hides Apps. docs/RELEASING.md adds a manual check of apps on the macOS Desktop app before a release is published, since no e2e covers it there.
- `@ghostlytools/sdk/app`: the types a mini-app is written against. It has the `window.ghostly` API, the broker's messages, every refusal code (`MiniAppErrorCode`, read back from an error with `miniAppErrorCode`), the broker's limits and the manifest's type (`AppManifestSource` for `ghostly-app.json`). It imports nothing at run time, so an app's single-file bundle takes only the constants it uses. The SDK's declarations now also type check with `NodeNext` module resolution.
- WISP 1200 says what release 1.2 ships: its header names where phase 1 is built, it is listed as Available in the index and on the site's roadmap, and the phase 1 section says the official store starts with Chess. WISP 405 says the app card is built. No rule and no format changed.

**CI**

- In the security autorelease's `deps` mode, a manifest, version file or Dockerfile may change only versions: dependency ranges, the app's version, crate versions and base image tags. A branch that also changes a package.json's scripts, an extension's permissions, the updater's key, a Cargo build script, a Dockerfile's commands or a dependency's source, or that adds a manifest, now waits for a person.
- The security autorelease gate refuses a lock file that keeps a dependency's name but takes it from somewhere else: an npm alias to another package, a download from another registry or a git repository, a workspace link turned into a download, or a crate off crates.io. Before, only new names were refused.
- The security autorelease gate hands the release notes to the next jobs inside a block whose end marker is random per run, so a line in a branch's changelog can no longer end the notes early and set the version that gets tagged and released after the gate checked it.
- A green batch that the merge train lands on `dev` runs CI and the dependency scan at most twice, not once per pull request: pushes to `dev` share one concurrency group in both workflows, so the runs waiting behind one in progress give way to the newest. Before, each squash merge of a batch started the whole CI (about 18 jobs) at once, and a batch of five filled the runners for half an hour.
- Dependabot offers a new hyperdht in a pull request of its own at the root, never inside the weekly npm group: its four copies and the patch named by its version move together, by hand.
- A merge train lands pull requests on `dev` and on `epic/*` branches: a reviewed, green pull request gets the `queue` label, and the train merges up to five at a time in the order they were queued, after one CI run on the batch. A red batch is split until the pull request that breaks it is found, and every queued pull request has a comment with its place in line.
- When only one pull request is in line, the merge train merges that pull request itself instead of opening a batch for it: at once when it is up to date with its base and green, or after rebasing its branch onto the base and one more CI run. It then shows as merged, not closed.
- A pull request that the merge train lands alone on `dev` is merged with GitHub's squash merge, so its commit is signed by GitHub and shows as Verified again. The train warns in its log when a commit it landed this way is not verified. Commits that land on an `epic/*` branch are still unsigned.
- A green batch on `dev` lands the same way: the merge train merges each of its pull requests in order with GitHub's squash merge, so they show as merged with a Verified commit, and it checks after each one that `dev` holds exactly the files the batch tested. This needs the queue app on the bypass list of `dev`'s ruleset. Until then a batch lands by the rebase merge as before, with a warning, and its commits are unsigned.
- The merge train reads CI from the jobs of `ci.yml`'s own run on a commit, and takes the newest by id. A check run named "CI Success" that another workflow posted, with any start time, no longer makes it land a pull request or a batch whose CI is red. This needs "Actions: read" on the queue app; until it has it, the train reads GitHub Actions' check runs as before and warns in its log.
- Desktop builds other than `tauri build --debug` and `tauri dev` (so every release `tauri build`) and every browser extension build now stop when the e2e suite's build switch `VITE_APPS_TEST` is set, from the shell or a `.env` file, as the web image already did. The release workflow also empties it for both.
- A changelog entry can wait for a later release: `release: <major.minor>` in its front matter keeps it in `docs/changelog/unreleased/` through every older version's bump, so a patch never lists what it does not ship. The check refuses an unknown or repeated front matter key, and, until 1.2.0, an Apps entry that is not held. The version bump refuses a version older than the release a feature flag belongs to while that flag is on, and that release while the flag is still off (`RELEASE_GUARDS` in `tools/scripts/changes.mjs`); the release workflow checks the tag the same way. A bump keeps an empty `## Unreleased` above the new version.
- The merge train's workflow asks the queue app for "Actions: write", so the train can cancel a boarded pull request's own full CI run and the runners go to the batch. If the app has only "Actions: read" it falls back to that token (CI read from ci.yml's run, no cancelling, one line in the log), and without Actions at all to the check-runs token as before.
- The merge train no longer drops a pull request alone in line as `queue:conflict` when its conflict was already resolved by merging the base into it. The lone path rebases the branch, and a rebase skips that merge, so the conflict came back; such a pull request now goes the batch way, whose squash merge takes the branch as it is, and only a conflict there takes it out of the line. The train's conflict comment now says that merging the base in works as well as rebasing.
- The merge train's own pushes to `dev` or an epic no longer start a merge-queue run each: a batch landing as one squash merge per pull request started one per pull request, each taking a runner only to be cancelled or to find nothing to do. A person's push still wakes the train.
- The merge train takes up to 12 pull requests in a batch instead of 5, and a ready pull request boards once the draft's fast tier (CI Success (draft)) passed on its last commit, without waiting for its own full CI: the batch's full CI run is still what lets anything land, and a red batch is still split until the culprit is found. When a pull request boards, the train cancels its own full CI run still going, so the runners go to the batch; a token that may not cancel workflow runs skips that with one line in the log. A pull request alone in line still waits for its own CI Success.

**CLI**

- `ghostly app init <dir>` starts an app: a `ghostly-app.json`, an `index.html` that says hello to the contact, typed against `@ghostlytools/sdk/app`, and a README with the way to a store. `ghostly app publish <dir> --key <file>` signs the folder as it is. `--name` and `--title` set the app's name and title (by default from the folder's name), and nothing is written over a file that is there unless `--force`.
- `ghostly app publish` takes a folder where a file and a folder share a prefix, such as `lib-extra.js` beside `lib/`, or `img.txt` beside `img/`. Before, it refused the folder with `files-unsorted`.
- `ghostly app publish` never puts a private key in a bundle: a `--key` inside the app's folder is refused before the key is made, and so is a folder holding any private key file (a PEM private key block, or a Ghostly publisher or store key), named in `details.detail`. Before, a key kept in the folder was bundled and published with the app.
- `ghostly app publish`, `ghostly app verify`, `ghostly app revoke` and `ghostly store sign`, the publisher tools of WISP 1200 (Apps). `app publish <dir> --key <file>` bundles a folder into a signed `app.ghostlyapp` and raises its `sequence` by itself; `app verify` checks a bundle from a file or an https URL as the app will; `app revoke` adds a revocation signed by the app's own key to `ghostly-revoke.json`; `store sign` signs a store index into `ghostly-store.json` and `ghostly-store.sig`. Keys are files of their own, never a profile's, made owner-only and never printed. Apps run in Ghostly from this release.
- A headless call no longer gets later and later: when the daemon was busy for a moment (over 100 ms, as a journal write on a busy disk or a Pkarr publish can be), the call's sender restarted its clock, and what a program wrote meanwhile stayed queued for the rest of the call, so a bot or `call pipe` writing at real time was heard 140 ms, then 640 ms, then over a second late. Now the frames that were due go out right after a stall of up to a second, and the delay stays where it was.
- A daemon that crashed during a call no longer leaves the call's audio socket file behind for good: the files piled up in the profile's `calls` folder (or its folder in `/tmp`) with every crash. The daemon now clears that folder's sockets when it starts, since no call outlives it.
- A headless call no longer stays "connected" in silence for about half a minute when the contact's side dies mid-call (a crash, a closed laptop, a lost network): after 5 s without any audio from the contact a bot gets `call.stalled` (and `call.resumed` if it comes back), and the call ends as `failed` after 15 s.
- `ghostly file save --dir` saves a file whose name is over 255 bytes (86 Chinese characters or 64 emoji are enough, and the contact picks the name) under a shortened name that keeps its extension; before, it failed every time with `engine` and Node's `ENAMETOOLONG`. A `--path` that long is a `bad_request` saying so.
- `ghostly file send` of a file you may not read answers `refused` with its path ("Not allowed to write or read …"), as `file save` does for a folder it may not write; before, it was `engine` with "The blob could not be read" and no path.
- `ghostly --pretty` or `ghostly -p bot` with no command shows the help, as `ghostly` alone does; before, it was "Unknown command: --pretty" (exit 2). `ghostly help` lists `version` (also `--version`), and `ghostly help version` answers it instead of "Unknown command: version".
- `ghostly help profile backup` shows the option as `--no-passphrase`, the only form the command takes; before, it listed a `--passphrase` that the command refuses. A long option such as `--passphrase-file <value>` no longer runs into its text in `help profile backup` and `help profile restore`.
- `invite create` on a daemon answers at once when the relays' request budget holds the new invite back (a few invites
  in a minute), with `"published": false` and `retryInMs`, instead of waiting 20 s and returning a link that was not out
  yet without a word. A published invite says `"published": true`.
- `ghostly group create`, `group rename` and `lightning rename` without a name, `profile picture` and `group picture` without a JPEG or `--clear`, and `forward` without a message or `--to` answer `usage` (exit 2) with what is missing ("Missing <name>: ghostly group create <name...> [--mesh]"), before the profile opens, as the other commands do; before, they opened the profile and answered `bad_request` (exit 1) with "name is required" or "path is required".
- `ghostly profile use|list|show|set|backup|restore`, `daemon` (and `daemon status|stop|restart`), `settings get` and `engine --list` refuse words past their usage with `Too many arguments` (exit 2), as every other command does; before, they dropped them, so `ghostly profile use my bot` selected the profile `my`.
- `ghostly listen --webhook` no longer follows a redirect: a loopback bridge that answers 307 or 308 counts as not taking the event (retried, then said on stderr), instead of the event, message text included, being posted again to the address the redirect named, off this machine too.
- A long chat no longer makes every send slower in the `ghostly` CLI: its history is read by the chat's own key range, not through an index that looked each message up again. At about 3,000 messages a send went from about 1 s to under 0.5 s of the daemon's time.

**Dependencies**

- HyperDHT moves from 6.34.0 to 6.34.1 in every copy at once: the packages, the Desktop's sidecar and the relay for browsers, with `tools/patches/hyperdht+6.34.1.patch` renamed to match. 6.34.1 is one fix: a server clears a relayed handshake when its relay aborts. A test now holds the four copies, their lockfiles and the patch's name to one version.

**Website**

- The WISP pages on ghostly.tools load a WISP's page only when you point at, focus or touch its link, not every WISP link on the screen as the page opens: `/wisps` loaded 50 other pages (738 KB, 61% of what it loaded) and a WISP page 36. A click still opens the page at once. The map's tiles, the reader's side list and a WISP's related links use the new `IntentLink`; the main nav keeps Next's default.

**WISPs**

- The apps and stores proposal is accepted for 1.2 as WISP 1200 (it was 12xx; old links forward). It now names the chat frame `paired-app` with a 32 KiB data cap, plays live only, puts Desktop in the first release and the extension later, and adds a test vector layout. WISP 405 gains an `app` card that a person's app can send.
- WISP 1200 gains a proposal for phase 2 of apps, not accepted yet: real-time games with messages that may be lost, the `realtime` permission, bundles up to 64 MiB, files a person brings for a game, and apps opened in groups. It records what a game can already do in the app frame (WebGL, WebAssembly, sound, a gamepad) and what it cannot yet (pointer lock, full screen), as measured.
- WISP 503 (Group Files) says what 1.2 ships: built and Available, with the tests that cover it, where it said Not built and Planned. WISPs 400, 900, 902 and 903 no longer say groups take no files.

## 1.1.7

Ghostly 1.1.7 is a security release: seven fixes in groups, wallets and new chats, on top of 1.1.6. Update when you can.

### Security

**Groups**

- Opening a group link can no longer remove a private group, or its history, from your device (GHSA-79gm-j485-mjg9).
- In a large private group, a member who left and was invited back could be taken out again by any other member resending the old leave; now only a leave made after the member came back counts.

**Wallets**

- A message with a Lightning invoice that your contact edits while you review it now starts a new card: the review you began is dropped, and only the invoice you paid is marked Paid (GHSA-wgj9-m8m3-83rx).
- A Lightning payment through the Cashu mints now pays only the invoice and amount you reviewed. A mint quote for another amount, another invoice or a higher fee is refused with nothing spent (GHSA-999w-x56g-vwpq).
- With a Bitcoin Core wallet, an on-chain request now shows as paid only when bitcoin arrives on the address it gave. A transaction your contact names no longer counts (GHSA-m7x9-79g6-pvrp).
- A Cashu payment your contact refused, whose ecash could not be taken back yet, now keeps its request from being paid a second time until the ecash is back (GHSA-vc58-rcp4-xfcv).

**Chat**

- When two devices opened the same new 1:1 invite at about the same time, the inviter's new chat could stop with "Saved contact key mismatch" until the app restarted. It now goes on with the contact that got there first (GHSA-67w2-23j7-94jr).

## 1.1.6

Ghostly 1.1.6 says what went wrong in a few words of your language, with the technical part behind an ⓘ, everywhere in the app. Groups no longer drop a member who comes back to a busy chat, Linux Desktops and DHT-only chats go live sooner, and a bot can show how much of its quota is left.

### For users

**Everywhere**

- Connection errors in a chat and in a group's member list are short now: a few words saying what happened and what happens next ("Waiting for the relays", "Retrying in 52 s"), in your language. The technical text (relay addresses, error names) is behind an ⓘ, with a Copy button for bug reports.
- When the app retries by itself (the relays' request budget, a dropped connection), the line is grey, not red.
- Device and profile errors are short now, with what to do under them: "The devices couldn't connect / Keep both online and make a new code.", "The move stopped / Nothing changed; copied files are kept.", and the unencrypted backup warning "Not encrypted / Anyone with the file gets your keys, chats and money."
- The rest of the app's errors say what happened in a few words of your language too: identities, Nostr, shared apps, network settings, the pairing retry and the connection timeline. A shared app's refusal keeps its technical reason behind an ⓘ, and the public DID warning is a short line with the details behind an ⓘ.
- A refused or failed identity check says why again, in your language: "This signature was made by another key", "No Ghostly TXT record in the domain's DNS", "The proof file was not found", or that the account doesn't list the key that signed. The record, address or key it names is behind an ⓘ. The relay settings say "Enter at least one relay address" again. An error the app doesn't know keeps its own words after "Something went wrong".

**Chat**

- File, voice and call errors are short now: "No access to the mic or camera / Allow them in your browser or system settings.", "Too large for your contact's app / Max 64 MB until they update Ghostly.", and a send or a file that failed says why in a few words of your language instead of the engine's English.
- A bot can say how much of its quota is left: a small meter on its chat's row and in the chat's header (amber when low, red when nearly out), with when it resets and which account behind a tap. Bots report it with `ghostly usage send`.

**Groups**

- Group errors and waiting notes are short now, in your language: "Nobody is online to become admin" with what to do under it, "Group changes are paused" with the technical part (member, epoch) behind an ⓘ, and a shorter line while you wait to be let in.

**Wallets**

- Payment and wallet errors are short now: what happened, then what to do or what is safe ("Couldn't create the Spark wallet", "Nothing was saved. Try again."), in your language. A provider's own technical reply is behind an ⓘ instead of inside the sentence.

### Fixed

**Chat**

- A bot's task or routine card sent while your contact was away no longer stays plain text on their side: once the chat is live again the card goes by itself and replaces the text, with no edit mark.
- Desktop puts a new record on the Mainline DHT about a second sooner: it no longer waits two seconds for DHT nodes that never answer before storing it. Two Desktops that find each other on the DHT alone go live sooner after an invite.
- A chat that moves to HyperDHT right after your contact's app restarted no longer waits about 28 seconds. The first HyperDHT connection a newly started app makes sometimes opened and then carried nothing; the Desktop app and the CLI now dial again after 2 seconds, and the chat is live in about 2 seconds.
- A contact on Ghostly 1.1.4 or older no longer sees "kept on" a connection, or a "transport change timed out" error, when either of you picks the chat's connection twice within a few seconds. Their app read the dropped move as a connection that failed. With such a contact the chat now makes the first move, then the second.
- Two apps with no WebRTC between them (Linux Desktops) go live sooner after an invite: the app that made it dials the joiner's native transport as soon as the joiner's record says how, instead of first waiting 2.5 seconds for a WebRTC offer that cannot come.

**Groups**

- A member back in a busy group or community no longer loses its connection to the member catching it up ("Session receive limit exceeded"), on older apps too: what it missed comes a few messages at a time, each batch once the last is in.
- A group member's connection no longer drops with "Session receive limit exceeded" when another member catches it up with many messages at once (a phone back in a busy group). A connection that still gets more than it can take ends without blocking the chat, and is dialled again.
- The group connection panel says why a member is not reachable in a few words of your language ("Can't reach the relays, retrying…", "Connection dropped, trying again…"), instead of the engine's English with relay addresses and error names.
- A web app no longer says "Could not publish discovery" for a group member or a chat while one relay is down and the others only wait for their request budget: that is a wait, and the packet goes as soon as a relay frees a request.

**Everywhere**

- Ghostly Desktop no longer says "Could not publish discovery" while one relay is down and the others are only waiting out their rate limit. That is a wait, and the packet goes as soon as a relay takes requests again (as the web app now does).
- On Linux with WebKitGTK older than 2.52 (Ubuntu 22.04, for example), Ghostly Desktop no longer freezes for seconds when a sound plays after a quiet moment, as at a new chat's first contact. The web app in GNOME Web and other WebKitGTK browsers before 2.52 no longer does either.

## 1.1.5

Ghostly 1.1.5 gets chats live sooner: two Desktop apps that only find each other on the DHT go live even when Iroh's relay is blocked, a chat is live again in about a second after the app was in the background, and joining a community no longer stalls while your relays are busy.

### Fixed

**Chat**

- The app icon's badge no longer blinks 1 for each message that comes into the chat you are reading. It was counted for a moment before the chat marked it read.
- Two apps that can only reach each other on the DHT and a native transport go live seconds sooner: a contact's record that does not yet say how to dial it is read again after 1, 2 and 4 seconds, not after 5 and 15.
- Desktop: a contact on the DHT alone now goes live even when Iroh's relay is unreachable. A newer record written right after an older one was refused by the DHT while the older one was still being written, so the contact could not learn how to reach the app until something made it write the record again.
- Desktop: a Pkarr relay that takes more than 10 seconds to confirm a write is no longer treated as down and skipped for minutes, which made New slow right after a start. A DHT write in the first seconds after a start, before the app knows other DHT nodes, is tried again instead of failing.
- Choosing a connection (WebRTC, Iroh, HyperDHT) right after choosing WebRTC no longer moves the chat twice. A move back to WebRTC waits a few seconds for the old WebRTC connection to close; a choice made in that wait now replaces it, where before the chat went to WebRTC first and then moved again.
- Your contact keeps seeing that you are typing when the chat moves to another connection (WebRTC, Iroh, HyperDHT) or reconnects. Before, the indicator went off at the move and came back only with your next keystroke, and a bot's one-shot `ghostly typing` never came back.
- Coming back to the app after it was in the background (a phone that put it to sleep) puts the chat live again in about a second, as after a restart. Before, it waited for the contact to look again, up to 30 s or more when the contact's chat was not on its screen.

**Groups**

- Joining a community while your relays are busy (for example while you keep the door of another community) no longer stalls. If the relays turned down your request to join, it is sent again within seconds at full priority. Before, it went again only every 10 s as a low-priority request, and it could wait for minutes.
- Joining a community while your relays are busy gets your request to the door sooner. When the relays turned your request down, it is sent again without first reading the door's list once more, so it no longer waits behind that read.
- When a community's only hub leaves (most often the admin), every member is back in the group within seconds. Before, a member whose request to the next hub crossed another member's could wait 20 seconds more.
- A group member, or a chat, whose live connection failed to come up tries again as soon as its wait between attempts ends. Before, it also waited for its next look at the contact, up to 30 s more. A connection attempt made while the relays were down no longer makes the next one wait once they answer again.
- A chat or group member whose WebRTC connection fails just as it starts (a rare race in the CLI's WebRTC library) tries again at once. Before, it waited about 40 s, and a member let in to a group could take over a minute to reach another member.

**Everywhere**

- The update banner no longer says "Ghostly 1.1.4 is available" on 1.1.4 after a redeploy: only a newer version number counts as an update.

### For users

**Calls**

- On an iPhone or iPad, a call in the Home Screen app says when the system paused your microphone (iOS does this while the screen is locked or another app is in front). The call stays on, and your microphone comes back when Ghostly is on screen again.

### For developers

**CLI**

- `GHOSTLY_IROH_RELAYS=https://…,…` pins the CLI's Iroh relays, as `GHOSTLY_PKARR_RELAYS` pins its Pkarr relays, and `GHOSTLY_STUN=0` leaves the apps' public STUN servers out of its WebRTC, so a private network reaches nothing public. The CLI's tests and the web e2e's headless bots now stay on this machine by default (local or dead relays, loopback HyperDHT, no public STUN); `GHOSTLY_TEST_PUBLIC_NET=1` lets a run reach the public networks.

## 1.1.4

Ghostly 1.1.4 makes adding your phone to your profile one screen, shows who is calling on the lock screen, and gets chats live sooner. Moving a profile between devices is steadier, and Ghostly Desktop opens its window at once on a slow network.

Known issues, for the next release: on iPhone the camera opens Safari, not the app on the Home Screen; moving a profile needs both devices online at the same time; adding a device can fail with "could not connect" when the direct connection between the two devices is blocked (for example a phone on mobile data).

### For users

**Everywhere**

- Adding your phone to your profile is one screen: scan the code on your computer with the phone's camera, or in Ghostly, and the phone shows "Add this phone to <your profile>" with one button. If the phone's profile is in use, Ghostly makes a new profile for it by itself and keeps yours as it is, without asking for your password again. The computer shows each step under the QR code (waiting, a device connecting, the digits to check, added) and the time left on the code.
- A new profile asks once what people should call you, with an empty field. Skip keeps the anonymous name contacts see today. A profile restored from a backup or added from another device is not asked.
- The home screen no longer says messages disappear: Ghostly has no disappearing messages. It now says what is true: your messages stay on your devices, with no central server.
- In Portuguese, Settings is "Ajustes" everywhere, the account bar and the Settings page included, as the phone's tab bar already said.
- "New chat" is in sentence case, and the Wallet page is titled "Wallets", as its place in the bars.

**Chat**

- Join reads a screenshot of an invite's QR code pasted or dropped on it, as Open image does.
- Search in a chat finds a voice message, a video or a picture by what it is, in your language and in English: "voz"
  finds a voice message in a Portuguese profile.

**Calls**

- A call that comes while Ghostly is locked now shows on the lock screen: who is calling, with Decline and Answer. Answer asks for your lock password, then answers at once. Nothing else of the chat is shown. This works also when Ghostly has been locked since it started.

### Fixed

**Everywhere**

- In Arabic, the words on wallet cards ("Ready", what a card holds), the line under a card in the payment sheet and the ID card's issuer line keep their letters joined. A monospace font, and in Safari wide letter spacing, drew them apart one by one.
- The chat list shows a call line ("Audio call ended", "Missed video call") as the chat's last message as soon as the chat has it. It lagged up to 3 seconds behind, until the list's next refresh.
- Ghostly Desktop opens its window at once on a slow network. Before, it could wait up to a minute for the DHT's starting points to resolve.
- Adding this device to a profile when the clipboard can't be read (Safari, Firefox, the Mac app): the field to paste into now asks for the code from your other device, and its button says Add this device. It said "Paste invite…" and "Join chat".
- Use here on a device while the active one is on a call now says "A call is on there. Try again after it." instead of a generic "can't hand over the profile now".
- Use here and Move to wait while the active device is on a call: they say "A call is on. Try again after it." Before, the move went ahead and cut the call, the contact saw "Reconnecting..." for half a minute, and the moved chat kept the call as still connected.
- Use here and Move to also wait while a call is ringing in on the active device: they say "A call is on there. Try again after it." and "A call is on. Try again after it." Before, the move went ahead, the ringing stopped, the caller rang on until "No answer" and the new device only showed a missed call.
- Moving your profile back to a device that had it before works again when a chat holds a photo or another file up to 16 MB. The move stopped with "The copy was damaged. Nothing changed." every time.
- Moving your profile between Ghostly Desktop on Linux and the web app no longer takes about 20 seconds longer on some moves. A page that reloads during a move gets a new address, and the other device first tried the old one until it timed out. It now goes to the new address as soon as it reads it.
- A device you removed while its screen was open now says "This device was removed" when you press Use here on it. Before, it tried for 40 seconds and then said your other device could not be reached.
- Use here right after your profile moved to a web browser works again when the two devices talk over Iroh (Ghostly Desktop on Linux and the web app). It could stop with "Can't reach … It must be on, with Ghostly open." because the device still held the connection to the page before it reloaded. That stale connection is now dropped and dialled again within about 20 seconds, instead of after 30.
- Use here on a device that moved your profile away a moment before no longer stops at "Checking". That device asked for the turn it had just given away, and the other device could not check its answer, so the profile never moved back.
- When the network comes back, a chat no longer keeps showing "Could not read DHT delivery: No Pkarr relay reachable" in red until its next check, which could be minutes away. The error from while you were offline goes at once and the chat checks again right away. If the relays really are down, the error shows again.
- A new profile starts in your browser's language when it is one of Ghostly's eight (Portuguese, Spanish, French, Italian, Chinese, Japanese, Arabic or English), and in English otherwise. It always started in English. Settings → Language still changes it, and a profile you already have keeps its language.
- After moving a profile to another device, the device it left no longer stays on "Moving to <device>. Waiting for it to finish." for good when the other device's last word was lost on the way. Use here is there in that state, and the screen clears on its own once Ghostly sees the other device has the profile.
- Sizes while a profile moves between devices (copied so far, left for later, what a push sends) are now written in the app's language, as other sizes are: "1,2 Go" in French, number first in Arabic.
- The line of capital letters along the bottom of an ID card keeps accented letters as plain ones, as a passport does: "João" reads JOAO, no longer JO<O.
- A proof its owner removes while you are chatting now ends as "Revoked" on your side, as the CLI's `identity recheck` already said. It stayed "No longer shared" for good, because a withdrawn proof was never looked up for its revocation.
- The steps to add Ghostly to an iPhone's Home Screen say where iOS 26 keeps Add to Home Screen: under More in the Share sheet.
- Setting a lock screen password no longer marks its fields as a new account password, which made Safari on an iPhone offer "Use Strong Password?": a generated password you would have to type on every unlock.
- A menu (a chat's or a group's ⋮, New ▾, Mute) gives the keyboard focus back to its button when it closes with Escape or a chosen row, and a dialog a row opened (the invite's QR code, for one) gives it back there too. It was lost to the top of the page.
- A message you write while this device is offline now says "You are offline" and that it sends by itself when you are back online. It used to say it was waiting for your contact to be online, which blamed your contact.
- A chat no longer stops preferring Iroh for an hour because this device was offline for a few minutes. Connection attempts made with no network no longer count as Iroh failures, and one still waiting when the network comes back is dropped so the chat connects again at once.
- A second tab of the web app says "Ghostly is already open in another tab" (and, opened for a share, that the share went to the other tab) in the profile's language, not always in English.
- On a phone, New and Join stay on the screen beside the logo in every language. In French on a 375px phone, Join went off the edge of the screen, and in Spanish and Italian on a 360px phone the buttons pressed against the logo. Their words now go wherever they do not fit, as on the narrowest phones.
- On a wide screen, the Settings index marks the section you pick or open by its address, Data & storage and About included. It marked Network or Data & storage instead, since the page cannot scroll its last sections to the top.
- On a wide screen, picking About or Data & storage in the Settings index right after opening Settings goes all the way there and marks it, even when the Network section above it appears a moment later.
- Turning the lock screen on in Settings puts the cursor in New password, and Change password puts it in Current password, so you can type at once (on a phone the keyboard comes up). The form opened with nothing focused.
- Settings → Audio & video opened by its address on a phone with no microphone or camera to choose says "No microphone or camera found", with why behind ⓘ. It showed an empty screen under its title.
- Settings has its search at every width. Between a phone held upright and a window wide enough for the index beside the page (a phone on its side, a tablet held upright, a narrow window), it was one long page with no way to search it.
- Picking "Password" in the Settings search opens the lock's password form, ready to type, so with no password set you can set one there. It opened Privacy & security, where nothing is called Password until one is set.
- Settings search finds an option by the words people look for it by, in all eight languages: "dark" or "theme" finds Mode, "colour" finds Color, "password" finds the lock screen, "mentions" finds the chat sounds. It matched the options' labels only, so "dark" and "theme" found nothing.
- On a phone, the Settings menu's Appearance line lists the mode and the language the way the app's language writes a list ("深色、中文" in Chinese, "داكن والعربية" in Arabic). It joined them with an English comma in every language.
- Sizes in Settings (storage used), in backups and in a chat's held messages are now written in the app's language: "1,5 Mo" in French, "1,46 MB" in Portuguese. In Arabic the size reads number first, where it showed "KB 144".
- On a phone on its side or a tablet with the keyboard up, the floating card that says why a password was refused no longer covers the field it is about or the error under it: where it would, it shows at the top instead. A card over the whole window also stands above the keyboard there, as it does on a phone held upright.

**Wallets**

- Restoring a backup that holds an Ark wallet works again. A wallet backup or profile backup made with this version was refused with "Unsupported Ark backup schema". Backups from earlier versions restore too, and the wallet brings its data up to date the first time it opens.
- Paying an invoice from a chat, the wallet's Pay invoice and paying a Lightning address no longer let you approve more than the card says it holds. The review says so and Pay stays off, instead of the node or the mint refusing afterwards. A card that does not say what it holds works as before.
- Paying a chat request over Lightning no longer lets you approve more than the card says it holds. The review says so and Approve stays off, instead of the node refusing afterwards. A card that does not say what it holds works as before.
- A payment request in a chat that turns Paid no longer keeps the red error of an earlier attempt that failed.
- Why a payment failed is said in the app's language: a Lightning node's or wallet's answer (no route, not enough outbound liquidity, the wallet refused it), an Ark, Bark, Spark, USDT, on-chain or Fedimint refusal, a Lightning address server's answer, and a chat payment refused or closed by the other side. A reason Ghostly does not know is still shown as it came.
- On a phone with the keyboard up, the payment review in a chat now scrolls so Approve is in view after Send, instead of sitting below the fold.
- A Cashu payment that comes back refused (a group request another member paid first) now says exactly how many sats came back and what the mint kept as its fee, instead of "The sats came back". The ⓘ says why the mint keeps a fee. These refusals are now also translated.
- In the light theme, the yellow "Test money" tag (Wallets tabs, New wallet, a wallet's panel, reviews and history) is a darker yellow that reads at 4.6:1 or more. It was about 2:1 on white. Cards and the dark theme keep the bright yellow.
- USDT no longer gives up on the first failed read from its Ethereum RPC. A read that fails once (a dropped request, a busy server, a block that moved on) is asked again a second later, so switching a Testnet USDT wallet to another network, restoring one, or making one with New works when the RPC hiccups once.
- A wallet card that has the keyboard focus shows its ring in the light theme too. The ring was white, and all but vanished on a light page.
- Why a wallet could not be made, why New does not offer a kind, and what an Ark, Bark, Spark, Bitcoin or Lightning card says while it connects or reads are said in the app's language. This includes the first-run setup's line on the Wallet page, which showed the engine's English, and a reason that lost its final period on the way (a Cashu mint that could not be reached).

**Chat**

- With no network (the web app opened from its cache, or the network gone mid-chat), a chat's and a group's header say Offline, as the banner does, instead of "Connection issue" in red with the relays' own errors in English.
- A new chat that cannot connect directly shows "on the DHT" again on the inviter's side, not "connecting": the joiner's first offer counts as an attempt, so it waits before offering again.
- Joining a chat goes live a little sooner: the app prepares its connection offer while it first looks for the person who invited you.
- A file whose name is over 200 characters keeps its extension when the name is shortened, so "….pdf" is still saved as a PDF. Before, the end of the name was cut, extension and all.
- A new chat goes live seconds sooner on networks where the STUN servers answer slowly or not at all: an offer waits for them 2 s at most, not 5 s.
- Coming back to a chat whose contact has it in the background is live in about a second: over a relay first, then on a direct connection a moment later, with no wait for the contact to look.
- A Desktop or headless app back after a while away is live with a contact whose chat is in the background in under a second over a direct transport, instead of about 8 seconds.
- A message that repeats one word many times (such as "word word word …") no longer asks "Send a wallet seed?". Real seeds, including the ones made mostly of one word like the "abandon … about" test seed, are still asked about.
- After your contact's app stopped without closing and came back on its own, choosing another transport in the chat moves it again. Before, every choice on either side waited and failed with "Your contact did not answer" until one of the apps restarted.
- Choosing WebRTC again a few seconds after moving a chat to Iroh or HyperDHT connects in about 3 seconds. It took about 30 seconds, because the new connection waited until the old one had closed and then for the next retry.
- On a phone, swiping the Tasks board to another column now selects that column's tab even when the page was opened before its cards had loaded. Before, the tab could stay on the column you left.
- Messages that come while Ghostly is hidden (the Desktop window closed to the Dock or minimised, or a background browser tab) stay unread even when their chat is the one open, so the app icon's badge counts them. They were marked read as they came.
- A reply to a voice message or a video, the reply bar while answering one, and the pinned bar of one say "Voice message" or "Video" in the app's language. Before, they showed it in English in every language.

**Accessibility**

- A chat's and a group's ⋮ open with Enter, Space or ↓ with the focus on their first row, and the arrow keys move between rows. Before, the focus stayed on ⋮.
- Closing a chat's search (Escape or ✕) gives the focus back to ⋮, or to the message field after Ctrl/Cmd+F there. A group's Members and Leave windows give it back to what opened them. It was lost to the top of the page.
- The chat list's search, the message field and a chat's search show a ring while they have the keyboard focus, 3:1 or more against the page in every colour theme, light and dark. Before, only the caret showed where the focus was. The ring on the Settings, Forward and emoji searches is darker in the classic light theme, where the green read at about 2.7:1.

**Groups**

- In a community, what someone wrote before they left or were removed still shows their name, instead of "Member" and a key. Their "joined" line names them too once the group has heard their name.
- A group member whose direct connection to another member fails reaches it over Iroh or HyperDHT within seconds. Before, the other member's app could wait about 30 s for its failed attempt to run out.
- Invited back into a private group you were removed from, the messages you kept name who wrote them while the invitation waits, instead of "Member" and a key. Once you accept, someone who left the group meanwhile is still named on what they wrote.
- Closing a group's link (after making the group, or from Share) keeps the keyboard focus in the group: on what had it, else on Share. It was lost to the top of the page.
- Closing New group with Cancel or Escape puts the keyboard focus back on New ▾. It was lost to the top of the page, so a keyboard or screen reader user had to start over from the first control.

**Identities**

- A contact's identity card that is no longer shared or was revoked no longer says "Check again looks for a revocation by its owner." on its back: such a card has no Check again button.

**Calls**

- The small call window keeps all its buttons round and inside it when Share screen is there too: in a narrow browser window, or after you pull the window in to its smallest, the five buttons were squeezed into ovals against both edges.

## 1.1.3

Ghostly 1.1.3 makes adding a phone or another browser to your profile work again. Since 1.1.0, a profile that had been open for a minute was judged "in use" because of the empty wallets every new profile makes by itself, so the new device was refused. Messages, files and payments sent in the first seconds after the app opens also no longer fail with "You are offline".

Known issues, for the next release: on iPhone the camera opens Safari, not the app on the Home Screen; moving a profile needs both devices online at the same time; adding a device can fail with "could not connect" when the direct connection between the two devices is blocked (for example a phone on mobile data).

### Fixed

**Everywhere**

- Adding a phone or another browser to your profile works again on a new profile. It no longer says "This profile is in use here" once the new profile has made its own empty Cashu and USDT wallets, which every new profile does by itself a moment after it opens.
- Adding a phone to your profile no longer stops at "This profile is in use here" when the phone reads the code inside a profile it already uses (one with a group, an identity or money but no chat). It now asks to add the device in a new profile, keeps the code, and goes on to the digits.

**Chat**

- A message, a file or voice message, a forward or a payment sent in the first seconds after the app opens no longer fails with "You are offline" while the chat is still being set up: it waits for the chat to start, then goes.

### For developers

**WISPs**

- Sixteen WISPs whose features already ship got their numbers: Spark 206, Fedimint 207, domain 304, OpenPGP 305, Bitcoin address 306, SSH 307, Nostr social 309, profile DID 310, DIDs 311, AT Protocol 312, store-and-forward 404, status cards 405, message buttons 406, group mesh 902, group community 903 and the headless runtime 1100. Old links and website addresses forward to the new ones.

## 1.1.2

Ghostly 1.1.2 makes Settings easier to find your way around on a phone, and fixes a lock password being refused right after the app opens. Settings now comes in sections: on a phone it opens as a menu with search, each section on its own screen.

Known issues, for the next release: on iPhone the camera opens Safari, not the app on the Home Screen; moving a profile needs both devices online at the same time.

### Fixed

**Everywhere**

- Setting, removing or turning off the lock password right after the app opens: a profile on one device is no longer held to the 8 character rule of a profile on several devices, or told it is on several, while the app is still starting. Settings now asks before judging the password.

### For users

**Everywhere**

- Settings comes in sections: Profile, Appearance, Notifications, Audio & video, Privacy & security, Network, Data & storage and About. On a phone it opens as a menu with a search field, and each section opens on its own screen with Back to the menu. On a wider screen the sections stay on one page, with an index and search beside them. Settings → Advanced is now Network, and old links to it still work.

## 1.1.1

Ghostly 1.1.1 makes adding your phone to a profile easy to find, and shows password errors where you are looking. In 1.1.0 a phone that already had a profile could not reach "Add this device to my profile"; it is now in the profile switcher, in Profile, Devices, and on a new profile's chat list, and scanning the Add a device QR code with the phone's camera opens Ghostly with the code filled in.

Known issues, for the next release: on iPhone the camera opens Safari, not the app on the Home Screen; moving a profile needs both devices online at the same time.

### Fixed

**Everywhere**

- A phone can be added to a profile again. "I already use Ghostly" now shows on a new profile's chat list, where a phone looks, and a phone or computer that already has a profile finds "Add this device to another profile" in the profile menu, the profile list and Profile, Devices. It makes a new profile for the device and leaves yours as they are.
- The Add a device QR code opens Ghostly when you scan it with your phone's camera, with the code filled in. On iPhone it opens Safari, which asks you to add Ghostly to the Home Screen first. The ghostly.tools page for such a code has Open in Ghostly.
- Changing, setting or removing the lock password, or typing it in Add a device: a wrong current password, one that is too short or two that differ is now said right under the field, which keeps the focus with its text selected, and in a floating card near the bottom of the screen. Before, it was a line at the top of Settings, out of view.

## 1.1.0

Ghostly 1.1.0 lets you use one profile on more than one device, makes groups much faster to join and recover, and keeps a file in its place among your messages while a contact is away. Add your desktop, laptop or browser to the same profile (up to 4 devices): one device is active at a time, Use here moves everything to the device in your hand, and a lost device can be taken over or removed. In a private group the fifth person in waits seconds instead of a minute, a member back after a restart is in again within seconds, and a message written while cut off reaches the members let in meanwhile. Communities recover much sooner when a hub or the admin leaves or crashes. A file sent while your contact is away shows in order among your texts. Your own TURN server now reaches Linux desktop calls, and the desktop uses your own Iroh relays.

Known issues, for the next release: moving a profile needs both devices online at the same time; an app from before 1.1 may show a group message twice when its author said it again after catching up; joining a group can still take a while when the public relays are slow.

### For users

**Everywhere**

- An Android app: Ghostly on the web in a Trusted Web Activity, with its own icon and no browser bar, built for every release once its signing key is set up. It has the web app's limits (no native Iroh, no direct HyperDHT).
- Ghostly Desktop uses the Iroh relays you set in Settings, Network, as the web app does. Before, it always used n0's public relays, so a desktop and a web app on a self-hosted relay had no relay in common.
- One profile on several devices: use the same chats, groups, identities and wallets on your computer and your phone
  (web, desktop and extension, up to 4 devices). One device is active at a time; on another, **Use here** moves
  everything to it. Add a device in Profile, Devices with a code and your lock password, take over from a device that
  is lost or broken, or remove it. Both devices must be online for a move, and Mainnet money keeps a profile where it
  is for now. See [Several devices](docs/DEVICES.md).
- A profile backup can be light: chats and every message, contacts, groups, identities, wallets and settings, without the files over 1 MB (voice messages up to 4 MB stay). Back up shows how much each choice holds before you make it. In the CLI, `ghostly profile backup --light`.
- After restoring a light backup, a file it left out says "Not in this backup".
- A file whose bytes are no longer on the device no longer offers Save until you tap it: it says it is no longer available.

**Chat**

- A file or voice note sent while your contact is away now shows in their chat right away, in its place among your texts, and its bytes follow once you are both live. Before, a short text written after it could arrive first.

**Calls**

- Your own TURN server (Settings, Network) now reaches calls on the Linux desktop too, which wait for its relay path before they ring. Backups leave its credential out: after a restore, Settings asks for it again.

### Fixed

- One profile on several devices (WISP 06): the active device now reads which device is active every 10 minutes while
  it runs, and at once when another device's link says it holds the turn. A device that another one took over from
  while it ran stops within minutes, instead of staying active beside it until it restarted.
- Removing a device while a check of the active device was still out no longer leaves that device unable to start.
- One profile on several devices (WISP 06): a group change (adding, removing, a new admin, a new key or link) and
  answering knocks at a community's door now need a recent check that this device is the active one. When the check
  is old, Ghostly checks again first; when it cannot, the group is not changed and the app says why, so two devices
  that both think they are active can never split a group.
- Adding this device to another profile (WISP 06) is refused while the profile running here holds or waits for money
  in the wallets every new profile gets: USDT tokens or gas, ecash set aside for a payment or a swap, a paid quote not
  claimed yet, or a payment. While those wallets have not loaded yet (the app is starting, or the USDT balance could not
  be read), it says so and asks to check the connection and try again.
- One profile on several devices (WISP 06): "It wasn't me" on a replaced device takes the turn above the one that
  replaced it even after that device's record expired, instead of writing inside that turn.
- A handoff that failed no longer leaves a list of Breez databases behind for the next handoff to delete.
- Ecash and swaps that move in a handoff are no longer marked as restored from a backup, so the new device does not
  check every proof with its mint again.
- The old copy of a profile that a handoff replaces now goes with its wallets' own databases, never one the profile
  still uses.
- One profile on several devices (WISP 06): a device that another one takes over from while it is open now shows
  "This device was replaced" with Use here at once. Before, it stopped but kept showing the chats until a reload.
- One profile on several devices (WISP 06): a backup made before the profile had other devices, restored while Ghostly
  could not check them, now opens offline (limited mode) instead of starting a second live copy. It checks every 30
  seconds and starts by itself when no other device runs the profile, or goes on standby when one does. A line above
  the chat list says why.
- One profile on several devices (WISP 06): a device that takes the profile back reconnects its chats on a transport
  it runs. It could wait on the other device's transport, which it lacks (HyperDHT on the Desktop on Linux).
- One profile on several devices (WISP 06): Use here on a move offered from the other device starts the copy even
  when the connection between the two devices was renewed at that moment. A move offered from the active device
  that takes over a minute is no longer stopped as "The connection dropped".
- One profile on several devices (WISP 06): after a move that stopped, Try again on the active device now reaches the
  other device, which asks "Move this profile here?". Before, it often did not, and the other device stayed on "The
  move stopped".
- One profile on several devices (WISP 06): a device that took the profile no longer waits for ever on "Checking which
  device is active". After 2 minutes it says it can't check, with Try again.
- One profile on several devices (WISP 06): a device that another one replaced now offers "Use here" to take the
  profile back, not only "It wasn't me". What only it held stays as "Only on this device" in Data and storage, until
  you discard it.

**Groups**

- When a community's admin leaves, the people only it was connecting wait a moment for another member's app to take them, instead of each becoming a connection point nobody reaches yet. They hear the group again sooner.
- A message written in a community while the writer's app was behind on who had joined now reaches the people let in meanwhile in every case, not only when the app's clocks agreed.
- Many people joining a community at once: each stays with the member's app that is connecting it, instead of giving up after 20 seconds and asking the next one, which did the same. Before, with a dozen people in a minute, some were in the group with "connecting…" for two minutes and more.
- When the app of a member that connects others in a community closes without leaving (it crashed, or was force quit), the people it connected find the rest of the group again sooner. The apps left behind no longer wait a minute for it, and their requests to be connected again go out while they are still trying to reach it.
- When a community's admin or another member's app that carries others leaves, the people it carried find the rest of the group again faster. The apps left behind no longer keep trying to reach the one that left, which used up their requests to the relays and kept them from seeing who was asking for them.
- Someone let in to a community a moment before the admin left no longer waits for the admin: they find the rest of the group as soon as another member's app writes the admin out.
- A message written in a community while your app was cut off, and others were let in meanwhile, now reaches them once your app catches up. Before, it was sealed for the group as your app last knew it, and the people let in while you were away never got it.
- A community message your app sends again after it catches up is never sealed where people let in after you wrote it could read it.
- A private group member whose app restarts more than once no longer waits about 40 seconds now and then to connect again. After the second restart, the app could answer an old connection offer that another member had already given up, and waited for that attempt to time out.
- A private group connects much faster. The members you already reach now pass on what two members need to connect to each other, so someone who joins by the link reaches everyone within a second of being let in, where each connection took 6 seconds or more and a group of five or more could wait a minute or longer for the relays. It also uses far fewer relay requests, which is what made larger groups stall.
- A private group member who comes back while only one other member is online connects again within seconds, also right after a burst of joins and restarts, where it could wait 40 seconds for the relays.
- A private group member who comes back while most of the others are away is connected again sooner. When several members left at once, the app of the one who stayed could spend its share of the relays watching for all of them and then read nothing for half a minute, so the first one back waited 25 to 45 seconds to be seen. It now waits about 5 seconds, under 20 at worst in our tests.
- A private group of more than 16 people works when a device's clock is a few minutes off. A hub whose clock was a minute and a half or more from the others' was a hub to nobody, so the members counted on one hub instead of two, and a member with such a clock found the hubs only once they told it themselves.
- A message written in a private group while your app was behind, with someone let in meanwhile, now reaches them once your app catches up. Before, it was sealed for the group as your app last knew it, and the person let in while you were away never got it. Someone let in after you wrote it still never gets it.

**Everywhere**

- Desktop: "Storage used" in Settings counts what the app really keeps, not only its small settings: the app's databases, the profile's files on disk and copies being saved. The parts are behind its ⓘ.
- The web app opens in the language you chose from its first frame again. Since the startup check for moved profiles, a reload showed the page in English, left to right, for a moment before switching to your language (most visible in Arabic).
- A device on a public address with no NAT no longer waits up to 5 s before each connection offer (10 s before a call) once the app may use the camera or the microphone.
- An app with many chats whose contacts are away does less network work while idle. When a Pkarr relay answered again after a rate limit or an outage, every chat looked for its contact at once, even the ones that had missed nothing: on a profile with 42 chats that was 42 lookups each time a busy relay came back. Now only the chats that missed a lookup, or that are looking for their contact right now, look at once; the others keep their pace.

**Devices**

- Adding a Linux Desktop from the web app works. The web page kept showing its code and the Desktop waited until it gave up, with no error on either side, because the two had no way to connect: the page now starts the connection the Desktop can use. When two devices still cannot connect, both now say so after two minutes.
- Moving a profile to a Desktop that runs in a space of its own (`GHOSTLY_PROFILE`) no longer ends with an empty profile there. The move finished, then the cleanup of the old copy deleted the list of profiles too, so the Desktop opened an empty profile and the other device showed it active but not connected. If the pointer to a moved profile is ever lost, the app now finds the profile again when it starts.
- Moving a profile to another device no longer sits on "Copying files" when the other device stops answering. After 2 minutes with nothing from it, both devices say the move stopped and offer Try again; the device that had the profile keeps it, and files already copied are not copied twice.
- A web page and a Linux Desktop on the same profile connect over HyperDHT as well as Iroh. The link between your devices offered HyperDHT only when the page's HyperDHT relay answered at the first try, never on a page on standby, and never after a relay set later; when the page's Iroh relay was out of the Desktop's reach the two could not connect at all. A connection that does not start is now tried again in a while.

**Calls**

- A call from or to a Linux Desktop could go out with no network address at all, and never connect: on a slow DNS lookup of the STUN server, its own addresses waited behind it. The STUN server is now looked up first, with its own time limit, and a call waits for at least one address before it goes out.

**Identities**

- When a browser blocks the homeserver's sign-in cookie during a Pubky Ring approval (Vanadium, Safari), the message now says why and points to Pubky Passport, Firefox or the desktop app, not Chrome.

**Wallets**

- Spark and the Breez Lightning source: each profile now keeps its own Breez wallet data on the device. A profile restored as a copy on the same device used to open the original's, so the two wallets could disagree about which coins were theirs; the copy now starts from its recovery phrase with its own. The profile that was already using the shared data keeps it. Removing the wallet or deleting the profile now deletes that data too.
- Bark: a wallet restored from a Bark backup or a profile backup looks once for on-chain coins its phrase received before, so they show in the balance again. The wallet page says it is looking while it does.

### For developers

- Fourth part of "one profile on several devices, one active at a time" (WISP 06): adding a device. On the active
  device, Profile, Devices, "Add a device" asks for a lock password of 8 characters or more (set, typed again, or made
  longer; a profile that never adds a device keeps its 4-character lock), then shows a code good for 10 minutes. The
  code is a new invite version (2), which the chat reader refuses as a device code and Ghostly 1.0.2 refuses as a
  newer version (test vectors included). On the new device, "I already use Ghostly" on a new profile reads the code.
  The two meet on a one-time paired session (`enroll/1`) signed with their device signing keys: the code admits one
  device only, the active device proves itself first, and only then both show the same six digits. Once the person
  confirms on the active device, the new device stores the device set as a standby and the active device publishes its
  turn record with it; a crash at any step leaves no device added or a complete one. The new device ends on the
  standby screen with a live link to the active device. In an iPhone or iPad browser tab it says to add Ghostly to the
  Home Screen first; elsewhere it asks the browser to keep its storage and warns when it does not.
- Fifth part of "one profile on several devices, one active at a time" (WISP 06): the handoff, which moves a profile
  from the active device to another one. On a standby, "Use here" asks for the profile's lock password, which the
  active device checks with a password proof (OPAQUE, through `opaque-ke` compiled to WebAssembly) without ever seeing
  it; five wrong tries in an hour lock that device out for an hour, and fifteen refuse it until the person lets it try
  again on the active device. On the active device, "Move to <device>" offers the profile to a device that is on, and
  the person says "Use here" there. Files are copied first while the active device stays in use, skipped when the
  other device already has them, and sealed piece by piece; on mobile data files over 16 MB can stay behind. Then the
  active device stops without a word to its contacts, sends the rest in the backup format of WISP 05, and goes on
  standby only once the other device checked everything. The new device writes all of it into a storage space of its
  own, points the profile at it in one step, takes the turn and waits about 30 seconds to be sure no other device took
  it at the same moment, and then reaches the contacts the way an app that restarted does. A crash at any step leaves
  the profile active on one of the two devices.
- One profile on several devices (WISP 06), fixes to the device links: a device on standby goes through the person's
  relays, Iroh relays and TURN servers and asks nothing of anyone with the network off (the active device keeps a
  copy of those settings beside the device state); a device signing key that does not sign is never kept, and one
  page never removes a key another page stored; the transports a device link publishes are signed with the device
  signing key, so another holder of the device-set secret cannot stall the link with transports of its own.
- Third part of "one profile on several devices, one active at a time" (WISP 06): device signing keys and the links
  between a person's devices. Each device makes its own Ed25519 signing key, non-extractable through WebCrypto where
  the engine keeps such a key (measured in Chromium, WebKit and the Desktop's WKWebView on a Mac) and a stored seed
  elsewhere, kept apart from the device record and in no backup. A paired session can sign through that key instead of
  a raw seed; chats sign exactly as before. The link between two devices is derived from the device-set secret and the
  two signing keys (test vectors included), pinned to the other device's key with trust on first use off, and run by
  device-link-only mode without opening the profile's database. It carries a ping and its echo for now. The turn
  keeper signs with the device's key. A profile on one device makes no key and starts no link.
- One profile on several devices (WISP 06): a removed device, or a contact deleted or muted while a computer hands out
  the phone's push address, can no longer wake the person's devices. Every device that stays makes a new push address
  after a removal, the phone is asked over the device link for a new one when the computer cannot make it, and a
  device on standby shows wake-ups only for the chats the active device still has. "Keep this computer awake" says it
  is on only once the computer really holds it.
- Ninth part of "one profile on several devices, one active at a time" (WISP 06): push and the phone. A phone's
  wake-ups keep working when the profile moves to a computer and back: the computer goes on giving contacts the
  phone's push address, and a new one the phone's browser makes reaches contacts through it. A device that is not the
  active one never rings and never shows a message: a quiet "New message. Active on <device>." or "Call for you.
  Active on <device>." opens its standby screen. Asking a phone that closed the app for the profile wakes it with a
  push, and it says "<device> wants to take over. Open Ghostly." On Desktop, "Keep this computer awake" in Profile,
  Devices keeps the computer from sleeping so the phone can take over while you are out, and a move in progress keeps
  it awake on its own. A device left waiting after the device that removed another was lost for good can now start a
  device set of its own with "My other device is lost or broken". Removing a device also forgets its push address and
  its wallets' home marks. A wallet that stays on another device can no longer be made the default for receiving here,
  and a Bitcoin Core source at home elsewhere is never changed from this device.
- Seventh part of "one profile on several devices, one active at a time" (WISP 06): removing a device. On the active
  device, Profile, Devices, Remove takes a device out of the profile: the devices move to a new device secret, which
  the removed device never gets, so it can no longer take the profile and reaches none of the others. The other
  devices get the new secret over their old connection the next time they are open together, even a device that was
  closed at the time, and show the new list of devices once, with "This is wrong" if it looks wrong. A device that was
  removed shows so when it opens, and can be added again. A device that was off while the person's devices changed in
  a way it cannot check asks to be added again. "New device secret" does the same with nobody removed: Ghostly makes
  one by itself when a device was being added and never finished, and offers one after a takeover. "Lost or stolen"
  lists what to do next: change the storage keys, move the money out of each wallet the lost device could spend from,
  and pair each chat again. A crash at any step of a removal picks up where it stopped. Going online as the active
  device now holds every action until it has checked that it is still the active one.
- Tenth part of "one profile on several devices, one active at a time" (WISP 06): the final screens. Profile, Devices
  lists each device with a mark for its kind and its state (This device · Active, Active, Standby, Not finished),
  "Move to <device>" on the row and Check and Remove in the row's menu, and the details behind ⓘ marks. The standby
  screen, the handoff progress, the takeover, the remove and the lost-or-stolen screens share one layout at phone and
  desktop widths, in both themes. The account switcher shows "Standby" for a profile this device is on standby for. A
  start that could not check which device is active asks first: "Try again" or "Start anyway". Settings says when the
  push address belongs to another device, and a phone that was never the active device shows its quiet notices in the
  app's language.
- First part of "one profile on several devices, one active at a time" (WISP 06). The app now reads a device state
  before it starts a profile: a profile used on one device only runs exactly as before; a device that is not the
  active one for a profile opens none of its data, starts no wallet and publishes nothing, and shows a standby screen
  instead.
- Sixth part of "one profile on several devices, one active at a time" (WISP 06): the forced takeover and the guard on
  restoring a backup. On a device on standby that holds a copy of the profile, "My other device is lost or broken"
  takes over when the active device cannot be reached: it asks for the profile's lock password (five wrong tries in an
  hour lock the device out for an hour, fifteen for good, and a wrong one changes nothing) and the name of the device
  that stops, waits about 30 seconds to be sure no other device took over at the same moment, and starts. A device
  that was replaced reads that before its engine starts when it comes back, stops without a word to its contacts, and
  offers "It wasn't me". A copy started from older state (a takeover, or any restored backup) sends above every number
  the copy it replaced may have used, so its first messages in a group or a community are no longer dropped by the
  other members as already seen; it signs no group change and takes no door duty until the person turns on "Manage
  groups from this device" in that group; a payment it finds signed but unfinished is never sent again; and the
  on-chain wallet scans again. A backup of a profile on several devices carries its device set in a newer backup
  format, and restoring one where the profile is active on another device does not start it: the app offers to add the
  device instead, to take over, or to cancel. After any restore, as after a takeover, the copy signs no group change
  and takes no community door duty until "Manage groups from this device" is turned on in that group.
- The turn record (WISP 06), after its second review: a device that settles a raised turn keeps in its device record
  when its put ended and which sources took it, so a reload cannot make it active on one lagging relay; signed junk
  above the last ordinary sequence closes the turn address only while it is there; on Desktop a DHT put that only
  times out no longer holds the relays back; the read before a raising put gives each source 5 seconds.
- Second part of "one profile on several devices, one active at a time" (WISP 06): the turn record, which says which
  of a person's devices is the active one. Its fixed binary format, with test vectors shared by TypeScript and the
  Desktop's Rust; its own read (every relay is asked, and on Desktop the DHT itself) and its own conditional put (a
  refusal is never sent again without its condition); the result of a read, clone detection included; what each device
  state does on each result; and limited mode in the engine (nothing published, dialled or settled in hold storage, no
  wallet opened, until the turn was read). A profile on one device makes no turn read or put.
- Eighth part of "one profile on several devices, one active at a time" (WISP 06): wallets in a move. A profile with
  money no longer has to be emptied before it moves. Testnet ecash, Spark, Lightning through NWC or Core Lightning,
  LND without a pinned certificate and the on-chain BDK wallet move with the profile and open on the new device once
  it is the active one; the ecash is checked with its mint there once. Ark, Bark, Fedimint, USDT, Bitcoin Core and LND
  with a pinned certificate stay on the device they were made on: the other device shows them as "On <device>" and
  never opens them, and they open again when the profile comes back. Ark and Bark coins that expire in under 3 days
  keep the profile from moving away from their device ("Renew your <wallet> coins first"). Mainnet money in a wallet
  that moves keeps the profile where it is for now: Testnet first. A payment still going through holds the move for up
  to 30 seconds. The old device deletes the Spark wallet's local database once it is on standby, and a wallet that
  only one device may write to opens only after a fresh check of which device is active. A copy that takes over checks
  its ecash with the mints before it counts.
- WISP 06 (one profile on several devices) now describes the enrollment digits (32 bits of the hash) and the handoff
  password proof (OPAQUE with Argon2id) as the app does them, with the reasons.

**Everywhere**

- Iroh is 1.3.0 everywhere: the Desktop's native transport and the browser build in `packages/iroh-web` that the web app, the extension and the CLI run (rebuilt with `node tools/scripts/build-iroh-web.mjs`). Apps still on Iroh 1.2.0 connect to it as before.

## 1.0.3

Ghostly 1.0.3 brings backups that handle large profiles, calls that survive a network change, and a round of fixes from the first days after launch. Backups hold files of any size, show their progress, can be cancelled, and can be made without a passphrase. A call comes back when your network changes. Messages, files and voice notes written around a reconnect stay in order, and devices whose clocks are a few minutes off now pair, call and join groups. A slow Pkarr relay no longer holds a pairing back.

Known issues, for the next release: after opening a profile with 1.0.3, going back to 1.0.2 is not possible and 1.0.2 does not say why; a restored copy used next to the original can lose its first messages in a group the original wrote in after the backup; joining a group can still take a minute when the public relays are slow.

### Fixed

- **A profile the app cannot open says so.** A profile last used by a newer Ghostly (a test build, or a newer version before a downgrade) could not be opened by an older one, and the older app still showed its chat list while it connected nobody, sent nothing and gave no error. It now shows one screen in place of the app: "This profile was last used by a newer version of Ghostly. Update the app to open it.", with the versions behind the ⓘ, a way to look for the update, and your other profiles one press away. When the data does not open for another reason (another window still holds it with an older version, no storage space, storage not allowed in a private window), the screen says which and what to try. Nothing is deleted, reset or downgraded. `ghostly` (the CLI) answers the same way: `engine` (exit 1) with a message that names both versions, from `ghostly status` too.

**Everywhere**

- A backup that runs out of room on the device now fails and says so ("This device has no room left for this backup"). Before, it could leave the file it was writing out, say the backup was made, and produce a file that no restore would open.
- A restore that runs out of room while it writes a large file says so too, instead of "File write out of order".
- The web app no longer keeps a check running twice a second after it has started, when it drew before the page finished loading.
- Web: a browser that cannot run Ghostly no longer shows a blank dark page. An older browser (for example an outdated Android System WebView, which some privacy browsers on Android use) now gets "Ghostly could not start", what to update, and a Copy details button for a report. A browser without site data, IndexedDB, Web Crypto or Web Locks is told which one is missing, where before the page stayed blank or the app opened and never connected.
- Web: Settings says when this browser cannot wake Ghostly while it is closed, instead of leaving the switch out.
- A slow Pkarr relay no longer holds a pairing back on the web, in the extension and in the headless CLI. When the relay asked has not answered within 1.5 s, the next relay is asked too and the first good answer wins; a relay found slow goes last for a minute, and one that keeps answering slowly is left alone like a failing one ("tripped (slow)" in the log).
- A restore stopped by a closed tab, a reload or a crash no longer leaves the half-restored profile's data on the device: the next start of the app removes it. Before, it stayed for good, unlisted, taking the room of its files.
- A backup of a profile a newer version of Ghostly has used is refused with "update to restore it", before anything is written. Before, it was restored as a profile this version could not open.
- A restore that fails or is cancelled while it is writing a large file no longer leaves that half-written file in the device's storage, where nothing would ever remove it.

**Calls**

- A call that could not reconnect in time now tells your contact it ended. Their side kept saying "Reconnecting..." until its own wait ran out.
- A call that is reconnecting no longer loses a try when the contact's reply to its first attempt arrives while the second is being prepared.
- A call no longer drops when your network changes (Wi-Fi to mobile data, a VPN going up). It says "Reconnecting..." and comes back on the new network within seconds, with your mute, camera, shared screen and the call's clock as they were. If no connection returns in 30 seconds, the call ends as before. Both apps need 1.0.2 or later; calls with the command line (voice bots) still end when the network changes.
- A call signal with a date far in the future no longer makes the app ignore that contact's later calls, and an answer the contact's app sends again after a reconnect is not taken for a new call.
- A call with a contact whose clock is off now rings and connects. Before, a call from a device two minutes off never rang, and a call to a device whose clock ran behind by more than the few seconds it took to answer kept ringing after it was answered, until it gave up.

**Headless**

- The CLI's stdout holds the command's JSON answer and nothing else. Before, a note from the engine (a relay that did not answer and was left alone for a minute, for one) was printed there before the answer, and a script reading it (`ghostly wallet list | jq`) failed. Those notes now go to stderr.

**CLI**

- `ghostly profile restore`: the restored profile's Cashu balance is what its mints still hold. The profile came back with the ecash of the day its backup was made, so what was spent afterwards stayed in the balance and payments failed with "Token already spent". The first time the restored profile starts, its wallet now asks each mint which ecash is still unspent, as the app's restore does, and a payment that was unfinished in the backup is never sent again by the copy.
- `ghostly profile restore` stopped while it runs (Ctrl-C, a kill) leaves no profile behind. Before, a half-written profile could stay under the new name, listed and usable, with a large file cut short.

**Chat**

- A contact whose clock runs behind yours can join your invite at once. Before, the person who joined stayed invisible until their clock caught up with yours (two minutes behind meant a two-minute wait, an hour meant an hour), and a group member whose clock was behind could not announce itself to the group.
- Two devices whose clocks are a few minutes apart now connect. A contact whose clock ran two minutes fast or slow had its connection signals, its capability record and its small texts over the DHT dropped without a word: a first pairing took half a minute or never completed, a group could not be joined, and texts sent while not connected did not arrive. What comes in is now ordered by the sender's own counters, and its age is counted on this device's clock from when it was first read.
- Messages held for a contact who is away are now picked up when the sender's clock runs ahead. Before, with a clock two minutes fast, nothing held was ever fetched, and the sender was told the items "could not be verified as yours, or were too large".
- A message from a contact whose clock runs behind yours now plays its sound and shows its notification. Before, with a contact's clock a minute or more behind, a reply to something you had just written was taken for an old message catching up, and so was everything the contact wrote in the first minutes after your app started: the message appeared and nothing rang.
- A new chat's pairing scene tells one story. Its steps only move forward, its clock no longer starts over at every step, nothing blinks out and back as the chat goes live, and the header icon says what the scene says. The scene ends as the chat goes live, folding away instead of jumping, and does not come back once the chat has moved on to the DHT.
- A pin from a contact or a group member whose clock runs between 5 and 10 minutes ahead is now taken. It was dropped, and never showed on your side.
- A chat is live again within seconds when both apps restart soon after connecting and one device's clock runs behind the other's. Before, the app with the clock ahead could refuse every new connection offer of its contact as "from before the last session" until the contact's clock caught up: two minutes behind meant up to two minutes without a live chat, nine minutes meant nine.
- Many messages sent while your contact's app dropped without closing (a crash, a lost network) reach them in the order you wrote them once the chat is back. Some of the later ones could arrive first.
- Messages written while a contact was away, or while the connection was coming back, now reach the contact in the order you wrote them. Since 1.0.2 a message is shown where it arrives, and around a reconnect the app could send a later message before an earlier one: the contact then read them out of order, for good, while your own chat showed them in order.
- Files and voice notes written while your contact was away reach them in their place among the messages you wrote then. They arrived before or after the texts around them.
- A file you receive is placed where it arrived, even when a message comes right behind it.

**Groups**

- A community works when a member's clock is a few minutes off. A device whose clock was a minute and a half or more from the others' joined, then never connected: nothing it wrote arrived and it received nothing, and with the admin's clock off it was the admin who was cut off from everyone else.
- What you write in a community right after joining, or right after opening the app, before it has connected, now reaches the members who were in the group at that moment. When the first member your app reached had joined after you wrote, the message reached nobody.
- When a community's admin (or any member other members connect through) leaves, the others no longer end up in parts that do not hear each other for minutes, and what was said in the meantime reaches everyone: some members never got it. Members that were connected through the one who left also ask another member at once, without waiting for it as for an app that restarts.
- A community's member list no longer says "Not reachable" for a member your app has no direct connection to while it is connected to another hub: it says "Through a hub", as for everyone else reached that way.
- A member removed from a community whose app was relaying for others at that moment gets back in when it opens the group's link right away. It stayed at "joining" for good: its app closed its own way in a moment after opening it.
- Back in a private group after a while away, you read what you missed in the order it was written. The messages came as all of one member's lines, then all of another's, so answers showed apart from their questions.
- A private group takes nothing over a connection to someone who is no longer a member, for the moment that connection is still open.
- When several people open a private group's link at about the same time, what each of them writes right after getting in is read by the others. A message written in the first seconds was sealed for the group as its author knew it, without whoever had been let in a moment later, and that person never saw it.
- "Joined", "is no longer a member", "is now the admin", rename and picture lines show where they happen when the admin's clock is off. With the admin's clock a couple of minutes ahead, each line stayed at the bottom of the group, under everything said in the next minutes; with it behind, the line went above what had just been said.
- A group's line about someone who left and never set a name ("Member 46ishssi is no longer a member") names them in the app's language, as their messages do. It kept the English word in every language.
- A member removed from a private group while their app was closed is told when they come back: the group says "You were removed from this group" and the composer closes. Before, someone who had joined by the link and was removed while away was never told: the group stayed active on their device and what they wrote went nowhere. The admin's app tells them when the two meet again, for up to a week.
- What is said in a private group goes to its current members only.
- A message that arrives in a group within a second of your leaving it shows as unread in the chat list. It showed nothing new until the next message came.

**Wallets**

- Bitcoin on-chain: a payment review that was never approved is never sent. A restored profile brings such a review back as cancelled, and a review of this kind already marked "Status unknown" now ends as failed with "This payment was never approved: nothing was sent". An approved payment that left the mempool is still sent again on its own, as before.
- Cashu: when ecash of a wallet was spent somewhere else (the same profile in use on another device, or its "Copy ecash" backup redeemed in another wallet), a payment that picks it now ends with "already spent somewhere else" instead of staying at "Status unknown". The wallet then asks the mint about the rest of its ecash there, so the balance shows what the mint still holds, nothing stays set aside, and the wallet can be removed. A Lightning payment that fails this way no longer shows a fee for it.
- Cashu: a redeem that could not reach the mint is sent again as soon as the mint answers.
- Cashu: every exchange of ecash with a mint (receiving a payment, redeeming a token, taking a payment back, sending, paying over Lightning, an invoice being paid) is now saved before the mint is asked. If the app closes or the connection drops before the mint's answer arrives, the wallet asks the mint again, at once and the next time it opens, and finishes from there: the ecash shows up with its history line and its payment, or the sats that were set aside are free again. Sats held for a payment the mint has not confirmed show under the balance as set aside, and removing a wallet names an exchange that is still open before you confirm. A contact is told the result once the mint has answered.
- A contact's request paid over Lightning through your Cashu mints no longer says "Lightning payment pending…" for good when the app was closed just as the payment started. On the next start the mint is asked about it: the request is marked paid, or it is open again with its Pay button.
- A request paid in ecash that you then took back (Take it back) can be paid again. Its review said "settled" although the sats had come back, and the request answered "This request already has a payment". The review now says the payment was taken back.
- A profile restored from a backup shows the Cashu balance its mints still hold. The backup's ecash that was spent after the backup was made used to stay in the balance, and payments failed with "Token already spent". The wallet now asks each mint once and drops what was spent.

### For users

**Everywhere**

- A profile backup now holds files of any size. Before, files over 16 MiB were left out.
- Backups are made and restored a piece at a time: a profile with hundreds of megabytes of files no longer has to fit in memory, and the app stays usable while it works.
- A backup and a restore show a progress bar (what is being done, which file, how many bytes) and can be cancelled. A cancelled backup leaves no file, and a cancelled or failed restore leaves no half-made profile.
- A backup can be made without a passphrase. It is a choice you make each time, after a warning: the file then holds your keys, chats and wallet secrets in the clear. A restore tells you when a file was not protected.
- A file the device can no longer read is left out of the backup and counted, instead of failing the whole backup.
- Backups made by earlier versions still restore.

**CLI**

- `ghostly profile backup` writes large profiles a piece at a time, and the file appears only once it is whole. `--no-passphrase` makes a backup that is not encrypted, only when asked for by name. `profile restore` needs no passphrase for such a file and says how the file was protected.

**Chat**

- When this device's clock is off by a minute or more, the chat's connection panel and Settings, Network now say so: "This device's clock seems to be off by about 2 minutes. Chats may be slow to connect." Behind the ⓘ: which way it is off, why it matters and how to fix it. The note needs several sources that agree (the relays' own time, several contacts), never one contact, and goes away when the clock is right again.
- Task cards on the Tasks board say more when a bot tells it: a Review column holds a task whose pull request is open, the pull request's chip shows whether its checks pass, fail or are still running, tags show as chips you can filter by, and the tasks that are parts of a bigger one are stacked under it with a summary such as "2 of 10 done".
- A Tasks board shows every task your bots posted, from all your chats and groups, in one place: columns for Queued, Running, Blocked, Done and Stopped (failed or cancelled), each with its count, and a line saying how many are active. A card shows the task's title, its bot, its chat, its pull request and how long ago it changed, and opens the chat on that card. Group the board by bot or by chat, filter it by text, and find routines on their own tab. On a phone the columns are tabs you can swipe between. The way in is a "Tasks" line above the chat list, shown only when a chat has a task card.

### For developers

**Headless CLI**

- `ghostly task send` and `task update` take `--pr-state draft|open|merged|closed`, `--pr-checks passing|failing|pending`, `--tag <label>` (up to 3, 24 characters each) and `--parent <task>` (a task of yours in the same chat). They are optional card fields that apps from before them ignore, showing the card as before; no status was added.

## 1.0.2

Ghostly 1.0.2 makes chats and groups connect in more places, and fixes what the first days of 1.0 turned up. Messages are placed in the order they arrive, whatever the contact's clock says. Chats connect through relays behind a VPN or a firewall, and a note says when the network is the reason. The web app on iPhone and Safari reaches contacts on the desktop app. Several people joining a group by the same link no longer wait on each other, and a message sent before a group's connections are up now reaches everyone. Pinned chats can be put in order, an invite in a chat has Copy and Show QR, a shared identity shows as its card, and the Linux desktop app no longer uses CPU while idle.

Known issues, for the next release: a call drops when your network changes (the fix is ready); a profile with hundreds of megabytes of files cannot be backed up yet (the fix is ready); a first pairing can fail when the two devices' clocks differ by more than a minute; joining a group can still take a minute when the public relays are slow.

### Fixed

**Everywhere**

- A profile you named with the same word as the built-in name of a language ("Pessoal", "Personnel") keeps that name when it is restored from a backup. It used to come back as the built-in name and change with the app's language ("Personal" in English). A backup now says whether its name is the built-in one; backups made before are read by the language they were made in.
- An app left open and untouched no longer keeps a processor busy. The ghost of the empty chat list moved forever, so a new profile's window was drawn 60 times a second: on Linux that cost about a fifth of a core for as long as the app was open, even with the window on another workspace. It now says boo three times and rests, as does the syncing mark on a chat's row.
- Motion that says something is under way rests when it has lasted: the pairing scene and its small glyph in the header become a still picture after a minute in the same stage (an invite nobody has opened yet), a "connecting" dot stops pulsing after half a minute, and a spinner stops after two minutes. They move again when their state changes.
- Every looping animation holds still while the window is hidden or behind other windows, and goes on when it is back.
- On the web, the phone app and the extension, Ghostly now asks the browser to keep its data, so the browser does not clear your chats and wallets when the device runs low on space. It asks once you have a chat or a wallet, and again after you install the app or allow notifications.
- Settings shows **Storage on this device**: Protected or Not protected, with what to do behind the ⓘ, and how much space is used. Where it is not protected, the wallet's backup reminder says so.

**Chat**

- On a network that blocks direct connections (a VPN, a firewall), a saved chat took 20 to 50 seconds to come back, and minutes in apps whose WebRTC never reports a failure, before it went through a relay. It now takes about 7 to 10 seconds: an answered WebRTC attempt that has not connected after 6 seconds is raced by the relayed transport, and an app whose WebRTC cannot even start dials the relayed transport itself at once.
- A file waiting in a chat set to DHT only no longer says it waits for your contact to be online. Its clock now says it waits for a live connection, and whose choice DHT only was: yours, with where to change it, or your contact's.
- Picking up what a contact held for you while you were away no longer stops for good when the storage does not answer: a request that hangs is given up after 20 seconds plus the time its size needs, and the next try picks everything up. Before, one hung request stopped the pickup in every chat until the app restarted.
- **Iroh relays under one spelling.** Iroh compares relay addresses as text, and the desktop app names n0's relays with the trailing dot of a full domain name (`relay.n0.iroh.link.`) while the web app lists them without it. A browser and a desktop app on the same relay each took the other's for a second relay, and a dial opened a second connection to the server it was already on. Safari and the iPhone app open no address that ends in a dot, so there the web app could not open a desktop contact's relay at all. Every relay address now goes to Iroh in one spelling, without the dot in a browser, whichever way it is written in Settings or in a contact's record.
- A conversation reads in the order things happened on your device, whatever your contact's clock says. A contact whose clock runs ahead or behind no longer puts your replies above the messages they answer: a received message is placed where it arrived, in chats, private groups and communities, in the app and in `ghostly chat history` and `group history`. The bubble still shows the time the sender says, but never a time that has not come yet, and the message's details show both that time and when it was received.
- A member whose clock runs ahead no longer keeps a group unread or at the top of the list.
- For bots and scripts: a received message's `timestamp` is when it arrived here, which is what histories are ordered by; `sentAt` is the time its sender says.
- An app with no WebRTC (the Linux Desktop, a CLI bot) talking to more than eight contacts at once: the chat you open, or a text arrives in, goes live again. It takes the native connection of a chat that has been quiet for two minutes, never one with a call or a file going. Before, it stayed "On DHT · retrying live" for as long as the other eight stayed live.
- On a network that blocks UDP (a VPN, a firewall), chats and groups took longer to connect with every saved chat: each chat's Iroh listener, the one that still works there through a relay, waited about 6 seconds per chat ahead of it for a HyperDHT listener that could not reach its network. Each transport's listeners now start in their own line, so Iroh is ready for every chat at once. This also shortens the start of an app with many chats on any network.

**CLI**

- `ghostly chat wait <chat> --until live` returns only once a live session exists in this run of the daemon: the chat's link is open and the session authenticated on a transport, the rule the app's connection line follows. A chat that was live before a restart does not count until its contact answers again. The `live` field of `chat show` and `chat list`, the `live` count of `status`, `service peer` and the `chat.connection` event follow the same rule.
- `ghostly group send` says what a bot can do about a message that did not go: `--reply` to a message the group does not have is `not_found` (exit 3), as `group react`, `group edit` and `pin` answer; a group this profile is out of (removed, left, a forked history) is `refused`; only what may go on a later try stays `unavailable`. All of them were `unavailable` before.
- `ghostly group edit` with the text the message already has answers `sent: false, unchanged: true`: no edit was made. It answered `sent: true` before.

**Groups**

- An app that starts while the relays are busy or the network is down no longer takes a community for one with nobody online. Before, it made itself a hub and answered the people knocking at the same time as the member already letting them in, so they got in through neither; it also hid the other hubs from everyone for up to half a minute.
- A community's connection icon says "Connected to the group" once your app is linked to a hub. Before, it counted one link per member, so a working community of twelve read "1 of 11 reachable" with a warning dot, and the members panel called everyone behind a hub "not reachable". The panel now says "Through a hub" for them.
- Joining a community through its link while others are joining too: the waiting card says how many more are waiting. After two minutes it says the group lets people in a few at a time, instead of suggesting that the link was replaced.
- A member removed from a community while their app was closed is told when they come back: the group says they were removed and the composer closes. Before, the group looked alive and their messages went nowhere.
- Opening a community's link again lets a removed member back in, with their history kept. Before, they had to delete the group first.
- CLI: `group send` answers `sent: true` only once an edge took the message, and `group send` and `group react` are `refused` for a profile that is no longer a member.
- In a community, hubs exchange the group's messages only with current members.
- A community shared right after it was made: one member's app answers each person who opens the link. Before, in the group's first minute, the creator's app and the first person let in could both answer the next one. One of the two then spent its share of relay requests for a minute and a half on a connection that never came up, and where the two got in each other's way the join waited for it.
- A new group takes the same names a rename does: up to 64 characters on one line, a new line read as a space. A longer name is refused with the reason (`ghostly group create` answers `bad_request`) instead of being cut at 48 without a word, sometimes through an emoji.
- A member of a private group behind a VPN or a firewall that blocks direct connections could not be reached by the others, for as long as that network lasted: group links between two apps with WebRTC used nothing else. A link whose WebRTC cannot connect now goes on over Iroh through its relay, as links with a Linux Desktop already do. Joining through a group link from such a network is not covered yet.
- What a group says when something is refused or over now reads in the app's language, in all eight: why you are out of it ("You were removed from this group", a forked history, a lost admission) in its notice, under its name and in the chat list; why a message or an edit did not go; and what the members panel, leaving, inviting and a group's link answer. They used to show in English whatever the language. A group you are out of with no reason given now names its status in the notice instead of leaving it empty. In a community, the "joined", "is now the admin", rename and picture lines about a member who has left since read in the app's language too.
- A picture pasted or a file dropped into a group says "Files are not part of groups yet". It used to do nothing and say nothing.
- In a private group, a message written right after joining, before the connection to the other members was up, now reaches them as soon as it is. Before, when someone else joined at the same moment, it stayed on the sender's device until one of the apps reconnected. The same goes for what a member writes while they have not yet heard of a membership change.
- A member back after a while reads "joined", "is no longer a member", "is now the admin", the rename and the picture lines where they happened, among the messages of that moment. They used to be stamped when they arrived, so they all came after everything the member had missed: a newcomer's "joined" under the messages that newcomer had already sent. Private groups and communities.
- Two people who open a private group's link at the same moment are both let in within seconds. One of them used to wait about six seconds more, because their requests to join shared one record and the later one replaced the earlier.
- Waiting to be let in while the admin's app is closed no longer uses up the relays' request allowance, so the group connects right away once the admin is back.
- Joining a private group by its link no longer takes an extra round through the relays half the time: the admin's app now always makes the first move, as it already did for communities.
- A message of yours in a group shows one tick, "Sent", and its line says a group has no receipts. Every one showed two blue ticks and "Delivered: your contact's app received it", even one sent while nobody in the group could be reached.
- A group stays marked unread (and keeps its "@") after the app starts again when the message that made it so was written before you last looked but reached you later, caught up from another member. The mark used to go on the next start.

**Desktop**

- The desktop app saves a profile backup, and a wallet's backup file, through the system's save dialog. Before, pressing Download there wrote no file at all and still said "Downloaded".
- On a network that lets no DHT traffic through (some VPNs and firewalls block it), Desktop published through the relays but read nothing back, so no chat or group connected and none said why. When no DHT node answers at all, Desktop now reads through the Pkarr relays, as with "Also use Pkarr relays" on, and goes back to the DHT by itself once it answers again.

### For users

**Chat**

- On a network that blocks direct connections (a VPN, a firewall), the chat's connection panel and Settings, Network now say so: "Direct connections are blocked on this network (a VPN or firewall?). Chats still work through relays, but connect more slowly." The note comes from this device's own failed connection attempts, never from one failed dial, and goes away when a direct connection works or the network changes.
- An invite or a group link shared in a chat now has Copy and Show QR on its card, beside Join, so you can open it on another device by scanning it. Nothing is copied or shown until you tap.
- A chat's options menu shows the invite's QR again while you wait for your contact, and a community group's members see the group link's QR in the members panel.
- Put your pinned chats in the order you want: drag a pinned chat in the list (on a phone, hold it first), or use Move up and Move down in the chat's menu. A newly pinned chat goes to the top. The other chats stay below, the latest first.

**Identities**

- An identity shared in a chat shows in the timeline as its ID card, the one from the picker, on both sides: the provider, the handle and the state of the share, with who shared it and when under it. With a mouse the card lifts and catches the light as the pointer passes over it; a click, a tap or Enter opens the identity's details.
- A share that is later stopped, or whose proof is found revoked, says so on its card ("No longer shared", "Revoked") in both chats. Before, the card kept its Verified check after the share had stopped.

### For developers

- The repository root holds only workspace configs and project documents. Scripts, patches and the shared Vitest settings moved to `tools/` (`tools/scripts/`, `tools/patches/`, `tools/vitest.shared.ts`); the relays and the web app's compose file to `infra/` (`infra/services/`, `infra/docker-compose.yml`, run with `docker compose -f infra/docker-compose.yml up --build -d`); these changelog entries to `docs/changelog/unreleased/`; `CONTRIBUTING.md` and `SECURITY.md` to `.github/`; and the SDK's example adapter to `packages/sdk/examples/adapter/`.

## 1.0.1

Ghostly 1.0.1 is a quality release: about 300 fixes and small additions since 1.0.0, found in two days of bug hunting across the web app, the extension, the Desktop apps and the command line. Bots can ask with buttons. Chats come back by themselves after both apps restart, after DHT only, or with many chats open. Ghostly Desktop on Linux joins groups. Errors, wallet words, dates and amounts follow the app's language in all 8 languages. Wallets say what they still hold before a mint or a wallet goes, and a reviewed payment can't get stuck. A second call rings with End and answer and never ends the first by itself. The Mac app gets a Dock badge and keeps running after Cmd+W. Clear all data erases everything of the profile but its wallets. The command-line daemon's memory no longer grows.

Known issues, for 1.0.2: a call drops when your network changes instead of reconnecting; after a community's admin leaves, members can be unreachable for about 1 to 2 minutes (their messages arrive when they reconnect); on the Linux Desktop and the command line, a ninth chat can stay on DHT while eight others are live; idle CPU on the Linux Desktop is being measured.

### Fixed

- `ghostly file save --dir` and `ghostly profile backup --out` into a folder that does not exist now fail with `not_found` (exit 3) and the path, as a missing input file does, rather than `engine` (exit 1) with Node's `ENOENT` text. A path it may not write is `refused`, and a folder named where a file goes is `bad_request`.
- `ghostly daemon --detach` on a profile another process holds now answers `busy` with that process's pid, instead of a generic "The daemon did not start".

**Identities**

- On a phone, Add an identity now opens as a sheet from the bottom edge, as New wallet does. Its last lines used to sit over the tab bar.
- The Ghostly ID card on Identities reads whole in Portuguese, Spanish, French and Italian: its "What contacts see by default" line was cut to an ellipsis ("Ce que les contacts voient par d…").
- Check again on a contact's identity card no longer ignores a click made while the card is still turning over. Its buttons wait for the turn to end, as the payment card's do.
- In a chat's identity picker, Share, Stop sharing and Copy key wait until the chosen ID card has finished turning over, then fade in. A click while the card was still turning could do nothing. With reduced motion there is no wait.

**Wallets**

- Amount fields read thousands the way the app's language writes them: "1.000" is a thousand in Portuguese, Spanish, French and Italian (it was read as 1), and "1,000" in English. A mark that could be either ("1.5" in Portuguese, "1,5" in English, a fraction of a sat) is refused with a short hint, never guessed, and the field shows what was typed.
- Amounts follow the app's language, not the device's: in Portuguese a wallet shows "10.000 sats de teste", not "10,000". This covers the wallet cards and panels, the payment sheet, payment and invoice bubbles, the chat list's previews and USDT amounts, in all eight languages, with Latin digits in Arabic.
- Approving a payment for a request your contact closed meanwhile (for example by removing the wallet it was paid to) now says the request is no longer awaiting payment, instead of "Cashu is off in this chat".
- Ark: coins that expired before they were renewed now say they are waiting for the Ark server to sweep their batch, and Recover appears only once it has. Recover used to show at once and fail ("No recoverable VTXOs found" or a failed batch, after which the server refused the coins for a while), so the wallet showed a balance it could neither spend nor recover.
- Ark: expired sats too few to recover on their own (under the Ark server's minimum coin size) are shown apart, recovered with the next coins that expire, instead of a Recover that answered "No recoverable VTXOs found".
- The Cashu wallet's list of reviewed payments says each one's state in the app's language ("pendente", "pago"), as the other wallets do. It showed the engine's English word.
- A Cashu payment approved while its mint could not be reached no longer stays "unknown" with its sats locked. Once the mint is back and says nothing was spent and nothing was signed, the payment is marked failed, the sats come back to the wallet, and the request can be paid again.
- A Testnet Cashu wallet says "test sats" wherever an amount shows: its mints' balances, its invoice, its amount field, what came in, what was redeemed and Pay. They read plain "sats" below a balance in test sats, and the amount field said "sats" in English in every language.
- A chat whose last message is a payment or a request reads in the chat list as its bubble does, in the app's language: "You requested 1,234 test sats". The list used to show the English line the wallet keeps with the message, which called a contact's Testnet request and a Testnet payment you sent plain "sats", with the device's number format.
- Decimal amounts take a comma in languages that write one. In Portuguese, Spanish, French or Italian, the decimal key of a phone's keyboard types a comma, and the USDT amount, the gas limit and the fee fields dropped it, so "1,5" became 15. Now "1,5" is 1.5, and "1.000,5" is 1000.5.
- Deleting a profile now also deletes its Bark wallets' databases and its Fedimint federations' files. They used to stay on the device after the profile was gone.
- Deleting a profile now lists every wallet it holds (Ark, USDT, Bark, Spark, Fedimint, Lightning and Bitcoin) before you confirm. It used to name no Ark or USDT wallet made since wallets got their own network, and never named the others.
- In the Desktop app and the extension, Open in wallet on a Lightning invoice, a BOLT12 offer or a Bitcoin payment link in a message now opens the wallet app. It did nothing before.
- More wallet errors are said in the app's language: a mint of the other network, a mint that still holds sats or is the wallet's last, a server that could not be reached or did not answer in time, no mint shared with the contact, an expired invoice, a Lightning address's amount limits, and USDT's and Fedimint's usual refusals. A Lightning card's recent rows, its source line, a payment's error in the chat, a review's error and the USDT and Fedimint status lines now say known errors in the app's language too.
- A Lightning payment from the Cashu wallet that fails after the wallet split its ecash (a mint refusing it, "Invoice already paid") now shows the fee the mint kept for that split in the wallet's history, and the error says it: "The sats are back in your wallet, less 1 sat the mint kept as its fee." It used to vanish from the balance with no line anywhere.
- Wallets: when the first setup could make neither wallet, a wallet made with New now shows its card. Before, the page stayed on "Create your first wallet" with the old errors until it was opened again.
- A request closed because you removed its Lightning card now reads "you removed the Testnet Lightning card “Home” it was paid to", not "the … card “Home” wallet it was paid to".
- Paying a Lightning address or an LNURL from a Testnet wallet says "test sats" wherever an amount shows: the limits it takes, the amount field, the review and the receipt. They said plain "sats", and the amount field said it in English in every language.
- Adding a mint to a Cashu wallet no longer files it into the other network's wallet. A test mint added from the Mainnet Cashu wallet, or a real mint added from the Testnet one, used to vanish from the list and quietly create a Cashu wallet on the other tab. Now the wallet says which network that mint belongs to and adds nothing.
- A mistyped or unreachable mint address added from a Testnet Cashu wallet is named as unreachable again, instead of being called a mint that holds real sats. The wallet contacts the address first, and says a mint belongs in a Mainnet wallet only once it answered as a mint.
- New wallet: a kind that could not be made says why on its own card ("Could not reach testnut.cashu.space."). On a phone the full message sat below the list, out of sight, and the card only said Try again.
- A request you already paid, whose payment is still on its way or not confirmed, shows that payment with its state and "Check existing payment" in the chat, also after you leave the chat and come back. Before, the bubble offered "Review payment" again, which was then refused.
- In a chat's payment sheet, a Lightning card on its own node (LND, Core Lightning, NWC, Breez) checks the amount against that node's balance. It used to check the Cashu one and say "More than the 0 test sats on this card". A card that has not read its balance yet no longer claims a number.
- In a chat's payment sheet, Request and Send wait until the chosen card has finished turning over, then fade in. A click while the card was still turning could do nothing, and you had to click again. With reduced motion there is no wait.
- The line a payment message keeps for the command line and older apps says "test sats" for test sats. A contact's Testnet request, Testnet ecash you sent, a reviewed Testnet Cashu payment and a Testnet request to a group used to read plain "sats".
- Payments say their state and their way of paying in words, in the app's language. A wallet's list of payments and a Lightning card's recent invoices showed the engine's own words ("pending", "settled", "open") in English, a review read "cashu · cashu-test · BTC" and a payment in the chat "Cashu · cashu-test". They read "Cashu", "Ark · Regtest" or "Bitcoin on-chain · Signet" now, and a Lightning card's recent rows say test sats on Testnet.
- On Testnet, the fees in a request's bubble ("Maximum fee", the Lightning fee line), a test mint's fee per proof, the Bitcoin card's fee field and the wallet icon's "new sats" say test sats, in the app's language.
- A payment's review and its outcome no longer show in English: "The fee exceeds your limit", "Cashu fee exceeds your limit", "Unknown payment intent" and the other refusals and outcomes of an approval are said in the app's language.
- A screen reader announces a payment or a request that comes into the open chat as the chat list says it, in the app's language, test sats as test sats.
- A contact's request you reviewed but did not approve yet can be paid after you leave the chat or restart the app. Its review comes back on the request, with Approve and Cancel. Before, the review was gone and Review payment only said "This request already has a payment. Reconcile it before trying again.", with nothing in the chat to reconcile. Approving right after a restart now waits for the chat to be live again, instead of saying Cashu is off in this chat.
- Removing a mint from a Cashu wallet asks first. A mint that still waits for money (an invoice not paid yet, paid ecash not claimed) lists it and goes only once you agree, and the wallet refuses it otherwise, not only when the mint holds sats. The last mint of a wallet opens the wallet's own Remove, which says the wallet and its Lightning card go with it; it used to remove the whole Cashu wallet without a word.
- The Remove wallet dialog writes what the wallet holds and still waits for in the app's language. In Portuguese it said "Ela tem 10,000 test sats" and listed "An invoice for 2,500 test sats, not paid yet", in the dialog where a person agrees to lose that money. Amounts, the open invoices and requests, and the ecash not taken yet now read in all eight languages.
- A payment request to a contact who made their first wallet since you were last live no longer fails with "Cashu and Lightning are off in this chat". It waits and goes once the chat is live. When the contact really took neither last time, it says so and to try again once the chat is live.
- The mint picker on a contact's payment request names each mint by its own name, or by its host when it has none. It showed the mint's full URL.
- In a chat's payment sheet, "More than the ... on this card" shows only when you can Send from that card. A Request spends nothing, so a Lightning card (which can only Request in a chat) no longer warns about its balance when you ask for more than it holds.
- A contact's payment request in the chat is titled "Pediu a você" in Portuguese, "Te pidió" in Spanish, "Ti ha chiesto" in Italian and "طلب منك" in Arabic. It read as a bare verb ("Pede"), like an order to the reader.
- A profile restored from a backup on the device it was made on no longer opens the original profile's Bark wallet database. Each restored Bark wallet starts its own and recovers from its phrase, as restoring a Bark wallet backup does.
- A request paid some other way (or closed) while its review waited for Approve no longer shows "Paid" with Approve and Cancel under it: the review goes, and the app cancels it, as Cancel does.
- A review never approved is cancelled once it expires (a direct send reviewed and left, say), and the Cashu wallet's list of reviewed payments no longer keeps settled or cancelled ones; the history keeps every movement. A payment approved, on its way or of unknown outcome is never touched.
- A Testnet USDT wallet moved to another test chain shows that chain at once, not the one it left, while its first balance is read.
- A Cashu payment reviewed before its sats went to another payment fails when you approve it, says so, and leaves the request payable again. It used to read "Outcome unknown. Check the existing payment; do not send another." for good, though nothing was sent, and the request could not be paid from the chat any more.
- A second USDT payment from the same wallet no longer fails with "This payment was already submitted" while the first one is still confirming. It goes at once, and a payment is still never sent twice.
- Wallet dates follow the app's language, not the device's: the Cashu history, a Lightning card's recent payments, Spark's history, the time of an on-chain balance and a review's expiry. With Portuguese chosen on an English device, the history read "Sep 30, 03:15 PM" and "Test coins from the test mint"; it now reads "30 de set., 15:15" and "Moedas de teste do mint de teste".
- An invoice you just made with Receive is now listed at once when you remove the wallet. Before, the dialog could leave it out until something else in the wallet changed.
- Removing a wallet no longer lists the invoice of a chat request that was already paid in ecash as money still to come, and no longer asks you to accept losing it.
- A wallet that could not be made because a service did not answer says so ("ethereum-sepolia-rpc.publicnode.com did not answer in time", "Could not reach …"), not the browser's own words ("Fetch is aborted", "signal timed out").

**Everywhere**

- Message times, the chat list's dates and the message field's placeholder follow the app's language instead of the browser's. With Arabic chosen on an English browser, a message used to read "AM 11:00" and the field "Message…".
- A backup of the first profile, never renamed, keeps its built-in name: restored, the copy is called by the app's language ("Pessoal", "Personal") and follows it when it changes. A backup made in Portuguese used to carry "Pessoal", and the copy kept it in every language. Backups made that way are read as the built-in name too.
- The chat list's short times ("now", "5m", "3h", "2d") are now in the app's language: "agora", "5 min", "3時間" and so on.
- Clear all data now erases everything of the profile but its wallets: identity proofs, the profile's DID, Nostr data, your name and picture, network settings, the S3 storage and wake-up settings, as well as chats, groups and files. Before erasing, Ghostly deletes the items it held for contacts, publishes the end of the DID, revokes shared identity proofs and ends the push subscription. Its confirmation lists what goes and what stays.
- Text reads at WCAG AA contrast in the default Cyan theme: a deeper accent in light mode (links, section titles, pills and the words on accent buttons), lighter secondary text in dark mode, a darker red for warnings in light mode, and a contact's key and unnamed contacts no longer faded below it.
- In dark themes, white words and icons on danger's red (Delete profile, hang up, decline a call) sit on a deeper red that reads at WCAG AA contrast. Light themes are unchanged.
- The arrows beside a deck of cards (wallets, identities, the payment sheet) are named in the app's language for screen readers, not "Previous card" and "Next card" in every language.
- The first profile, until you rename it, is called by the app's language ("Pessoal", "Personnel", "個人"...) in the profile list, the switcher and the lock screen. It used to read "Personal" in every language.
- Desktop: a file saved from a chat reaches the chosen folder whole or not at all. A copy that fails partway, such as on a full disk or a removed drive, no longer leaves a half file under that name or cuts short a file that was already there.
- Ghostly Desktop on Linux opened a second time on the same profile brings the running window forward instead of starting a second copy with the same keys, which left chats stuck. Another profile still runs side by side.
- Desktop: the window's title bar now follows the Light or Dark mode chosen in Settings instead of the system's appearance, so a dark app no longer sits under a light title bar. Auto follows the system as before.
- Linux Desktop on a Wayland desktop (GNOME, KDE, Hyprland, Sway and others): Join → Paste from clipboard reads an invite copied in another app, and pasting a copied picture or file into a chat sends it. The app read only the X11 clipboard, so anything copied in a Wayland app looked empty.
- With the keyboard, Tab now stays inside an open dialog: New wallet, Add an identity, the chat's hold and shared apps dialogs, the camera, the attachment sheet, Publish to Nostr and Delete profile. It used to walk out to the chat list behind the dialog. With one dialog open over another, Escape now closes only the top one.
- Error messages read in the app's language. About ninety of them always showed in English, whatever language you chose. They include the extension's "The Ghostly peer did not start", "Ghostly needs your permission to reach that local address", wallet and payment errors ("Not enough sats in your wallet", "Cashu is off in this chat") and profile and picture errors. So do the line under a chat that counts what is held for an away contact, and the note when a group's link does not work. An error Ghostly does not know yet still shows as it came.
- In the Chrome extension, a click on a message notification brings the Ghostly tab to the front with the chat open. It used to open the chat in a tab you could not see, so the click seemed to do nothing.
- The Chrome extension opens Ghostly in a tab right after you install it. Before, nothing happened until you found its button in the toolbar.
- In the browser extension, a second tab open on a chat now shows new messages as they come in, as the first tab does. It used to show only what was there when it opened.
- In the Chrome extension, the Ghostly button in the toolbar brings back the Ghostly tab that is already open. It used to open one more Ghostly tab on every click.
- With a hardware keyboard on an iPad, or on an iPhone on its side, iOS's shortcut bar no longer covers the message field: the app now makes room for it as it does for the on-screen keyboard, also after the device turns.
- The chat list works with the keys alone: every chat and group is a Tab stop that Enter or Space opens, and the first Tab offers Skip to content.
- A ringing call is announced to screen readers as a dialog named for the caller and takes the focus without answering; the call's state is said as it changes.
- A phone on its side no longer puts the chat list, the chat header or the message box under the notch or Dynamic Island.
- On a phone, the lock screen's password field and Unlock button stay above the keyboard. They were centred on the whole screen, and the keyboard covered Unlock (and on a small iPhone the field too).
- When you decline notifications, Settings says how to allow them where you are. In the browser extension you turn the switch on again and Chrome asks once more; the Desktop app on Linux points to the system's settings. Both used to say to allow them in the device or browser settings.
- On an iPhone, a dialog or a sheet with the keyboard up (New group, Forward, a wallet's sheet) now stands above the keyboard and clear of the notch: its fields and buttons no longer sit under the keyboard.
- On a phone, a field low on a page (Settings, Network, a profile's details) is brought into view when the keyboard comes up, instead of staying under it while you type.
- On a phone, the tab bar goes behind the keyboard while you type (a chat search, a setting) instead of standing on it in the middle of the screen.
- Picking an empty file to restore a profile now says the file is empty. Restore used to stay off with nothing said.
- The backup offered before deleting a profile keeps the profile's name in the file name in any script ("仕事.ghostly-backup"). A name in Japanese, Arabic or another non-Latin script used to become "-.ghostly-backup", and accented letters were lost.
- Deleting a profile that another window is running says it is open in another window. It used to say to switch to another profile first.
- The Profile page (its backups and deleting a profile), the Services page, every page's Back button, Join on the home screen and the chat list's "No results found" are in the app's language. They were English in the seven other languages.
- The web app opened from an iPhone home screen (iOS 26) fills the whole screen again: the tab bar and the message box no longer float above an empty band at the bottom. With the keyboard up on Android and in the installed app, the message box also sits right on the keyboard.
- With Reduce motion on, in the app or in the system, Show pairing progress, a jump to a quoted message and the jump to the latest message move at once instead of gliding.
- A chat or group edge reads its contact's packet from the relays in turn, one after the other, so a relay that missed the contact's latest packet (an offer after a restart) is read at most once in a row. Before, one link could keep reading the same relay while the others' reads went to the other one, and a restarted member was reached 12 to 60 s late.
- The relay requests kept free for a chat that waits for its contact go back to the groups as soon as the chat is live. Before, they were kept for a minute, and a group member back after a restart could wait about 45 s more for one of its groups.
- An app back after a restart no longer answers a contact's old offer that one relay still served, and dials the contact instead. Before, a chat or a group's edge could wait about half a minute on that dead offer before its own went out. A relay that missed a packet because it was busy now gets it when it frees up.
- An app coming back after a restart sends what can wait (each chat's capability record and mailbox envelope, the spare invite's warm-up) a few seconds later, once its native connections are up, and mostly only once. Before, with two chats and two groups, those took most of a relay's requests for the minute before the chats' and groups' answers could be read.
- A profile restore that fails part way, for example because the device is out of room, now removes everything it had written and says the device has no room left. It used to leave an unlisted copy of the profile's data behind, which nothing would delete, and show the browser's raw error.
- A restored profile's name says "restored" in the app's language ("Work (restaurado)", "Work (restauré)"), and follows the language when it changes. It used to say "(restored)" in English in every language.
- A restore that runs out of room on the device says so in the app's language.
- A restored profile's name field holds its name alone, with a small "Restored" tag beside it in the app's language. Renaming it keeps the tag and no longer writes "(restaurado)" or another language's word into the name, where it stayed in every language and showed twice after another backup and restore. The tag's x takes it off. Deleting a restored profile asks for its name alone, and its backup file is named after it.
- Settings on Ghostly Desktop for Linux no longer jumps just after it opens. Audio & video showed a "Device names" row with an Allow button until the list of microphones and cameras arrived, then removed it, moving every row below it up. A click on a row lower down, such as Advanced, could land on the row under it. Desktop names its devices itself, so the row is no longer shown there.
- Settings no longer jumps just after it opens on a computer with speakers. The Speaker row under Audio & video only appeared once the list of speakers arrived, pushing every row below it down: a click on a row lower down, such as Advanced, could miss it. The Speaker row is now there from the start, on "System default" until the list arrives.
- The app lets go of the speaker a few seconds after its last sound, instead of keeping an audio output open all the time once you had clicked anywhere. On Ghostly Desktop for Linux that was about 4% of a laptop's CPU with nothing playing.
- The installed iPhone app fills the screen from its first frame, and behind the lock screen too. Until the app had started, iOS laid it out at the screen less the status bar.
- A second tab of the web app that takes over after the first one switched profile now shows the profile it really runs. It used to show the other profile's name and "In use" over its own chats, could not switch to that profile, and with wake-ups on could replace that profile's push subscription.
- On a small phone (320 px wide), the tab bar's names show whole in every language. Portuguese, Spanish, French and Italian names such as "Configurações" and "Identidades" used to end in "…". Settings is now "Ajustes", "Réglages" or "Opzioni" there, and below 360 px the names are 10 px, as in iOS.
- On an iPad, or a phone on its side, the message field stays above the on-screen keyboard, and an iPhone no longer zooms into it. Safari scrolled the whole page to reach the field and left a blank band once the keyboard went; in Safari on an iPad the tab bar is no longer cut off at the bottom.
- On a phone, a tap on the dimmed area around a dialog or a menu (the chat, group and New menus) only closes it. It used to press what was under it too, such as New Chat, a tab or the chat's Back button.
- Desktop on Windows: message notifications show once they are turned on. Tauri's check always read them as off, so none appeared; Tauri 2.12 fixes it. The Desktop app now needs Windows 10 or later.
- `ghostly send` and `ghostly group send` refuse a text over 16 KiB with the code `bad_request` (and the size in `details`), before anything is sent. It used to come back as `unavailable`, which a bot reads as "try again later".
- With two panes on a touch screen (an installed iPad, a phone on its side), the message field and the account bar end above the home indicator. They used to sit partly under it.
- On a touch screen with two panes (an Android phone on its side, a tablet), pulling a list down at its top no longer pulls the page with it, which could reload the app.
- A direct connection that came up very fast is no longer dropped the moment it opens. When the other side's answer and the connection arrived almost together, the app closed the connection it had just made and dialled again 20 seconds later. A join through a group's link could then wait on "Joining through a link" for 20 seconds or more, and a new member could stay on "connecting…" for half a minute.
- On a phone, or with reduced motion, the website's opening copy and its two buttons no longer drop out of sight and rise a second time once the page has loaded.

**Chat**

- In a chat with one contact, the name over their messages is the one the header and the chat list show. A bot called Botty read "~Botty" over its messages and "Botty" everywhere else, and a contact you had named kept their own name over their messages. In groups a member's own name still reads "~Name".
- A bot can no longer send buttons that a typed answer could not tell apart: two labels that differ only in case or spaces, or a label that is another button's id. `ghostly send --button` exits 2 naming the duplicate, and the engine refuses such buttons from any sender. An app that receives them anyway takes the first match, as before.
- A reply that names one button but says another answer no longer counts as a press of that button, and shows as a plain reply. Before, a group could read "No" while the bot took "Yes".
- A bot no longer sees an edit of its own question when the app sends the question's buttons again once the chat is live. Its own updates to the question are still reported.
- A bot's question sent while your app was closed now shows its buttons once the chat is live again. The question arrives first as text over the DHT or a held message, which carry no buttons, and the bot's app then sends the buttons once, with no "edited" mark. Before, you only ever saw the text.
- Answering a bot's question by replying "yes" in words now marks Yes on its buttons, as the bot takes it. Before, the buttons stayed open, and a tap after it showed as chosen though the bot ignored it.
- A file you were receiving and cancel (or the sender cancels) after the app restarted no longer leaves the part that had arrived in the app's storage. Before, only a cancel in the same run of the app removed it.
- A bot's last card update (often "done" or "failed") no longer disappears when its daemon stops within 2.5 seconds of sending it: the update still waiting for its turn goes before the daemon ends, and `task update` no longer answers `confirmed: true` for an update that has not gone yet.
- A bot's task card in Japanese and Chinese says when it started and was updated as a label and a time ("開始：今", "更新：3分钟前"). "Just now" read as "今に開始" and "开始于现在".
- A chat at its last message stays there when a phone is turned on its side or a window is resized. It could stay up in the history with the ↓ button, and a video playing near the bottom stopped.
- A contact with no name reads whole in the chat's header on a narrow phone: it says "Contact", with the start of their key on the line under it. On a 320 px screen it was cut to "Contac…". The chat list still says "Contact · " and the start of their key.
- On a phone, Join no longer tells you to press Ctrl+V or ⌘V when the clipboard cannot be read or is empty: it says to touch and hold the invite field and paste.
- Deleting a chat now also removes its "Still notify me when I'm mentioned" setting, and, with the last chat with that contact, the payment card and network the payment sheet remembered for them.
- A chat whose contact leaves DHT only goes live again even when the contact's news arrives in two parts a moment apart. It used to stay on "On DHT · retrying live" for up to 45 seconds.
- A chat that leaves DHT only soon after it was paired goes live in seconds. Its offer or answer used to wait up to 45 seconds for the relays' request budget, and the chat stayed on "On DHT · retrying live".
- When the browser finds no network path for a chat's live connection, Ghostly now tries a new connection within seconds instead of waiting up to 90 seconds on one that cannot connect.
- A chat scrolled up a little keeps the messages at the bottom of the view in place when a phone is turned on its side or a window is resized. It could jump to the top of the history, and a video or voice message playing there stopped.
- A transport chosen while another change of transport was still connecting is tried as soon as that change fails. Before, the chat said "waiting" with no failures and never tried it until the transport was chosen again; with Fallback off it was not live meanwhile.
- A chat with a transport chosen (HyperDHT, for instance) is live again within seconds when both apps restart together. The chosen transport is dialled first; when the contact's endpoint was still starting, it failed once and was not tried again until the WebRTC offer timed out, 30 to 110 seconds later. Now it races the unanswered offer once more after 8 seconds.
- `ghostly typing --for` keeps the contact's "typing" or "thinking" line on steadily: on a busy machine it could blink off and on.
- Japanese, Chinese and Korean input: the Enter that confirms a candidate no longer sends a half-written message. This holds in the message field of 1:1 chats and groups, while editing or replying, and in the caption, search and name fields.
- Each Enter sends its own message. Typing a few short messages quickly while the first is still on its way no longer joins them into one. The field clears at once and they go one after the other, in order. If one cannot go, its words come back to the field with the ones typed after it.
- After you send a message in a chat, the cursor stays in the message field, so you can type the next one straight away. In a browser it used to leave the field, and what you typed next went nowhere until you clicked back in.
- In a 1:1 chat the message field stays open while a message is on its way. Before, it closed until the send finished, which takes a few seconds when the chat is not live, so a next message typed quickly, and its Enter, were lost. Now it goes right after the first.
- Pressing Enter twice, or double-clicking Send, sends a message once. In a group it used to go twice. A message typed and sent while the one before is still going now goes after it, and words typed meanwhile stay in the field instead of being cleared.
- The message box goes back to one line when you finish or cancel editing a long message, instead of staying tall and empty.
- A chat you delete in a browser stops answering at once. A chat deleted in its first 15 seconds used to keep receiving your contact's messages for a moment and send them receipts, so they saw two ticks for a chat that was gone.
- Desktop: a save that never finished (its dialog never answered before the app closed) no longer leaves a `save-…` copy of the file in the app's data folder. The app removes such copies when it starts.
- With the keyboard, Tab now stays inside a message's details panel. It used to walk out to the chat behind it.
- Two Desktop apps paired on the DHT now go live on Iroh or HyperDHT. With relay reads off (the Desktop default), an app could read an old copy of its contact's capability record and never read it again, so the chat stayed on "On DHT · retrying live".
- When your contact chose DHT only, a message of yours that had to wait its turn no longer stays stuck on its clock. It used to wait for a live connection that DHT only never makes; it now goes over the DHT like the others.
- On Ghostly Desktop for Linux, a chat set to DHT only can go back to a live connection: its Connection menu offers Automatic, Iroh and HyperDHT again. It offered only DHT only, said Iroh and HyperDHT needed Ghostly Desktop, and the chat could no longer send files or take calls.
- + → Document lets you pick several files at once, as Photos & videos and a drop already did; each goes as its own message.
- An empty file (0 bytes) arrives. On the Desktop, the web app, the extension and the CLI it ended "arrived damaged and was deleted" on both sides, because nothing was ever written for it and the check found no file.
- A chosen transport that did not connect, when the chat moved to another one instead (from Iroh to WebRTC, for instance), is tried again and said as not reached. Before, the chat showed "waiting" with no failures and never tried it again until it was chosen again.
- A file or voice message you send gets two ticks once your contact's app has stored it, both in the chat and in the chat list. Files sent over a live connection used to stay on one tick, even though your contact had them.
- In the chat list, a voice message or a video as the last message now reads in the app's language, not always in English.
- Right after the app starts, a file still on its way no longer looks finished (its size alone, no controls) for the few seconds before its transfer is back: it says Loading until then.
- A file still arriving when the app restarts no longer shows a Save button while it arrives. It used to offer the part received so far, as if it were the whole file.
- A file sent to a contact with no name says "Paused by your contact" and "Waiting for your contact to accept", in lower case mid-sentence, not "Your contact".
- Forward lists the chats to pick on an iPhone, and a contact's picture or key pattern stays in its circle instead of covering the whole dialog.
- A chat that goes live while your app is still picking up held messages no longer freezes until the pickup ends. Messages, edits and the checks that keep the chat connected came in only after every held item was fetched from the contact's storage, so a slow storage could hold them back or drop the chat.
- A browser on a HyperDHT relay reaches a contact again after the first time. Every later dial to the same contact through the same relay, including after a reload, used to hang until it timed out, so a chat without WebRTC stayed on the DHT.
- Joining with an invite someone else already used now says so, about five minutes in: "Someone else joined with this invite first. Ask your contact for a new one." It used to show "On DHT · retrying live" forever, and every text you sent showed as sent while nobody could read it; those texts are now refused.
- An invite link copied from the end of a sentence joins. A trailing ".", ",", ")" or "!" used to make it read as a typo.
- A new chat's "joined the chat" lines name the contact as the chat does, and yours says "You joined the chat". Both used to show a short key, yours too, so it looked like two strangers had joined. The chat list says it the same way, in the app's language, instead of "👋 Name joined" in English.
- On the Linux Desktop, a chat joined from an invite goes live even when you go back to the chat list right away. It waited 90 seconds or more, until you opened it again, because its direct connections only started while the chat was on screen.
- A chat shown beside the chat list in a narrow space (a phone on its side, a small window) uses its whole width: messages were squeezed to a third of it, and a video into a tall black box. A video narrower than its usual size keeps its shape.
- A chat back from "Disconnect for a while" (`chat disconnect --hold`) is live again in seconds, not 30 to 60 s later. If the contact had sent a message during the hold, its app still read yours as DHT only, so it held back your offer and closed your Iroh or HyperDHT dial ("The peer closed this connection") until its next mailbox read. It now reads your mailbox again as soon as you dial, and keeps the dial open meanwhile.
- Desktop on Linux: a large video you send plays while it is still going, instead of stopping after a few seconds with "This device can't play this video".
- A long chat no longer jumps to the top of the list and shows "now" after the app restarts.
- A chat with thousands of messages no longer fills the app's storage. Such a chat could stop showing new messages, above all in the Desktop app. It now keeps only its last messages there and reads the rest from its history, so it opens faster too.
- A chat with thousands of messages opens at once and scrolls smoothly. It keeps a few hundred messages on screen and loads older ones as you scroll up, without the view jumping. A quote, a search result or the pinned message still takes you to a message far up the history.
- On an iPhone, a long press on a message opens its quick bar alone. Safari also selected a word and put its own Copy, Look Up and Translate menu over the bar. The bar now has Copy for the message's text.
- A video or audio file you tapped while it was still being sent now shows its play button as soon as it has gone, instead of "It plays once it has been sent" until the chat was reopened.
- In the Chrome extension and the macOS app, playing a voice message no longer logs two warnings in the console about the media controls' picture, which those apps do not have.
- On Desktop, a video or audio file whose stream the player refuses now plays from its bytes without also saying it can't be played.
- Right after the app starts, a video or audio file still arriving is no longer offered to play or save before its transfer is back, and Download in a message's menu waits for it too, so a partial file is never handed out.
- A message's details (double-click, long-press or its menu) now read in the app's language, with sizes, durations and times written the way that language writes them. Ids, cipher names and engine states stay as they are, and "Copy all as JSON" stays in English.
- Messages read in their own direction, whatever the app's language: an English message in the Arabic app reads left to right (its full stop no longer jumps before its first word), and an Arabic one in the English app right to left. The chat list's last line too.
- A chat whose contact does not answer keeps the wait between its attempts to connect when its native listener starts again or the contact's record lists its connection again. Before, each of those started the wait over and dialled at once, which kept Ghostly Desktop busy while idle.
- A chat between the Linux Desktop and the web app is live again sooner when the web app restarts first: the Desktop's first connection after its own restart could open and then carry nothing, and it waited 30 s for that connection to time out before dialling again (about 35 s in all). It now gives up such a connection after 15 s, as the web app already did, and dials again at once, or at once when the web app's record shows a newer address for it.
- On an app with WebRTC (web, macOS Desktop, the extension), chats with a contact that has none (Ghostly Desktop on Linux, a CLI with WebRTC off) get the app's native connections first when it starts: those contacts can reach it no other way. Chats with contacts that have WebRTC take what is left, most recent first, as before.
- A chat that was live when the app last quit, and whose contact never came back, no longer tries to resume that connection at every start. After a minute of a run without it going live, the app treats that connection as over.
- On a phone or a tablet, opening a chat or a group no longer brings the keyboard up: it comes when you tap the message box. The same for opening the reactions and after a payment. With a mouse or trackpad the message box takes the caret as before.
- Tapping Send keeps the keyboard up on a phone, ready for the next message: the message box keeps the focus.
- A chat or group left open while messages keep coming (a bot posting all day) no longer uses more memory with every message. Each new message's entry animation used to stay in effect for as long as the message was on the page, and past a few hundred messages the oldest now leave the page, coming back when you scroll up to them.
- A new chat's pairing says "Your contact opened the invite. Connecting…" as soon as the contact has joined. On an invite shared more than two minutes before, it said the contact had not opened the invite yet, next to the contact's first message.
- A new chat's pairing scene no longer steps back when it opens. It could show "Waiting for your contact to open the invite" for a moment, then "Putting your invite on the network", then waiting again. It now starts at putting the invite on the network and only moves forward.
- On a busy computer, the web app could take a chat you just made for one you joined: its pairing scene said "Looking up the invite on the network" instead of waiting for your contact. The chat you made now always shows the invite's side.
- A payment you send in a chat gets two ticks once your contact's app answers for it. It used to stay on one tick, even after the contact had taken it.
- On a phone, a chat's header keeps at least eight characters of the contact's name beside the connection, call, video, Tasks and ⋮ buttons. It had come down to a letter or two on a 375px phone.
- On a phone, searching emoji or GIFs with the keyboard up shows the results: the panel grows to fill what the keyboard leaves, instead of keeping half of it and showing one strip of results.
- On an iPhone, a long press on a message while typing puts the keyboard down, so the whole quick bar shows. The keyboard used to stay up over its bottom rows, and what you typed went into the message field behind it.
- The chat list's "reacted to" line follows an edit of the message it quotes, in chats and groups. Before, it kept the old text until the app was reopened.
- A file arriving right after another no longer flashes "No longer available" in red before it shows its progress.
- A chat you were just live in is live again after both apps restart, even with more than eight chats between them. The eight native connections an app keeps went to the chats stored first, so the chat in use could get none on one side and stay on "On DHT · retrying live" for minutes when the other app has no WebRTC (Ghostly Desktop on Linux). The chats used or live most recently now get them first; the chat on screen takes one as soon as one is free; and a contact no longer keeps dialling a connection that is not there.
- A chat whose contact's app crashed and started again is live again sooner when this side never heard its connection drop (the headless CLI's WebRTC): an unanswered ping now reads the contact's new offer at once, instead of waiting until the connection gave up about 27 s later.
- On a phone, a tap on the dimmed area around the emoji and GIF sheet, the payment cards or the identity cards only closes them. It used to reach what was under it too, such as the chat's Back button.
- The chat list search finds names without their accents ("jose" finds "José"), and no longer says "No results found" under a group that matches.
- The Tasks panel keeps its header in view with a bot's routines open. Going to a row far down the list could scroll the header out of sight and leave a blank under the list.
- In the app installed on an iPhone, a long Tasks list opens below the status bar. Its header used to sit under the clock and the Dynamic Island.
- The chat's Tech Info, its connection panel, the transport lines' details and the connection history now write times in the app's language, as message times do. They used the browser's language.
- A message sent in the second before a new chat goes live shows on the other side at once, instead of up to 5 minutes later.
- A connection you chose for a chat (HyperDHT, Iroh or WebRTC in its Connection menu) still counts after the app restarts. When both apps restarted and the contact's reached you over another transport first, the chat stayed there and waited for nothing; now it moves to your choice once that connects, as it does for a choice made while the chat was not live.
- Turning a phone on its side (or back) while typing keeps the open chat as it was: the message field keeps its text cursor and the keyboard. The chat used to load again and the field lost the focus.
- Typing in a long chat is quicker in Chrome and the Chromium browsers: a keystroke no longer paints every message of the chat again.
- A contact's message that reaches you late, after a reply you wrote since, now counts as unread. It used to come in with no unread mark, below your own reply in the chat list.
- The chat list's unread count no longer counts your own message forwarded to several chats at once, nor the "joined the chat" line your contact's app adds by itself. The app's badge and the other profiles' counts follow.
- A video playing in a chat goes on when it leaves the view for a moment (a glance up at an earlier message, a phone turned on its side) and while the iPhone plays it full screen. Scrolled away for good, it still stops.
- A voice message no longer starts playing after you left the chat while it was loading, or alongside another one you tapped before it loaded.
- Tapping play twice on a paused recording's preview no longer leaves a second player you cannot stop, and pressing Send while the preview gets ready no longer plays it after sending.
- A hands-free voice recording is no longer thrown away when you start editing or replying to a message, and your contact stops seeing "recording audio" when a recording ends because you left the chat.
- In a group, a voice message ending no longer starts the next member's voice message, and a group event or a payment in between ends the run.
- Right after the app starts, a voice message is no longer offered to play before its transfer is back, as a video or audio file already waits, so one that had stopped arriving says so instead of trying to play a part of it.
- A file sent while your contact was away, and still waiting for them, keeps waiting when the app restarts. It used to say "Transfer interrupted" (and `ghostly file wait` failed at once) while it was still going to go, and did, once the chat was live.

**Groups**

- `ghostly listen` now reports `button.pressed` for a group press that first arrived through another member without its reply, once the author's full copy fills it in. Before, the bot never heard of that press.
- Someone who opens a new community's link right after it is made is let in within seconds, not a minute later. On an app that had just let people into other communities, the new group's door waited for the relays' budget to list it as a hub before it answered any knock.
- A community member whose app restarts is back in the group within seconds, with what was said while it was away. It used to take one to three minutes: the member it served dropped it for another hub at once, and the app, starting again, closed edges it was about to get back. Now a member waits 20 seconds for a hub that went away (up to a minute once it is back), a restarted app keeps the edges of its last run for a minute, and an edge that was live when the app quit is dialled at once. A hub that really quit now costs its members those 20 seconds.
- Removing a member from a group now asks first ("Remove Ana?"). Remove used to act on the first tap, right next to Make admin.
- A community join through its link that nobody has answered yet can be declined, as the invitation it shows as. `ghostly group decline` used to answer "No invitation to decline" and the join kept knocking.
- Accepting a group invitation while the inviter's chat is not live yet (just after the app opens) now says so and asks you to try again in a moment. Before, the button did nothing and said nothing.
- In a private group, the messages of someone who was removed (and maybe invited again since) keep their name. They read "Member" and the start of a key in the app, and had no name in `ghostly group history`.
- On a phone, the line under a group's name (members, how it is reached) is cut short before the header's buttons instead of running under the connection icon.
- A group you left and then joined again (by a community's link, or a new invitation to a private group) shows only what came after you were back. Before, its old history showed again under the new messages until the page was reloaded.
- In a group past 16 members, the connection icon counts members reached through a hub as reachable, as the header line does, and offers no Reconnect for them.
- Someone who joins a group that was renamed or given a picture before them no longer sees a line saying the admin just renamed it or changed its picture, and a new admin taking over no longer leaves a "renamed the group" line for a name that did not change.
- Leaving a group forgets its mute along with its history, so rejoining it later by link does not bring it back muted.
- When an admin leaves a group past 16 members, the Leave dialog names the member who really takes over, not one reached only through a hub.
- In a private group, the lines about a member who has since left (joined, became the admin, renamed the group, changed its picture) are shown in the app's language, not in English.
- A group member with no name shows its key once in the members list. On a phone the key was also shown again beside the name, cut to a single character.
- On a phone, the group admin's members list shows each member's name next to Make admin and Remove. It used to show only a fragment of their key, so it wasn't clear who Remove would remove.
- Joining through a group's link that nobody answers for two minutes now says the link may have been replaced, and to ask for the new one. Before, an old link waited forever with no hint.
- Your own message in a group (a forward to several chats, for one) no longer marks the group unread, and a member joining no longer makes a group unread after the app restarts.
- On a phone, a new group's ready dialog keeps "Go to the group" in view: it sat below the fold, under the QR code, the link and its notes. The QR code is a little smaller on short screens.
- Removing a member while the group's link works now says they can still join again with it, and that a new link keeps them out. It used to say only that they would not get new messages.
- A group member whose app restarts while the hub's relay budget is spent (by another restart a minute before) is back sooner. The edge used to wait for the hub's 90 s attempt: the member's answer, read late, was never made again, or the hub held on to a first answer that could no longer connect. The member now answers the standing offer again, and the hub dials again as soon as it reads a newer answer.
- A join through a community's link no longer stays "invited" after the joiner's app restarts. The joiner took the door's old packet for a member answering and stopped knocking for up to 10 minutes; it now knocks again, looks fast for the answer, and a lone door answers at once.
- A group message that reaches you late, after you last looked at the group, now marks the group unread. It came from a member you were cut off from, handed on by another member a minute later, and sorted in among what you had read with no unread mark or "@".
- `ghostly listen` now reports a group mention that arrives after the message itself, as `group.mentioned` (and an agent turn with `--turns`). This happens when the message first came through another member without its mentions. Before, the bot never heard it was mentioned. It is reported once, also across restarts.
- On a phone, an admin's members list shows each member's whole name: Make admin and Remove go under it instead of cutting it to a few letters.
- A member of a private group whose app was killed (or crashed) is back in the group about as soon as the others notice it went, not a minute or two later. Its edges' looks for an answer spent the relays' requests before the answers came: a restarted daemon with a chat and an edge to each of two members was reachable again 75 to 110 s after it started.
- A member removed from a private group and invited back no longer shows up twice in the reactions they made before. Their app said those reactions again under its new member key, so everyone saw two of the same emoji from one person.
- An app back after a restart sends each chat's and group's offer in its first packet, instead of a packet saying it is back and then the offer. With two groups and two chats that is 8 relay requests at start instead of 14, and more of the relays' minute is left to read the answers: back after a restart the others noticed 30 s later, it was live after 35 s instead of 43 to 93 s.

**Calls**

- A call that rings while Ghostly is in the background shows a system notification, when notifications are on. Before, only the ring said so, and a tab whose sound had not been started by a click stayed silent.
- In a desktop window 320 to 360 px wide, the call's five buttons (Share screen too) are a little smaller and keep clear of the window's edges, as a phone's four do. They used to touch both edges.
- In a narrow browser window, a call's buttons stay round when Share screen is among them. They used to be squeezed into ovals pressed against both edges of the screen.
- On a small phone (320 px wide), a video call's four buttons stay round and off the edges of the screen. They used to be squeezed into ovals.
- A call on an installed iPhone app: the button that shrinks the call to a small window sat under the status bar, beside the clock, and under the Dynamic Island with the phone on its side. It now stays clear of both.
- A call that can't connect now says so in the chat on both sides ("Audio call couldn't connect"), instead of the call window closing without a word.
- In a call, the microphone you pick last is the one your contact hears, even when an earlier pick opens after it. And a camera you turn on stays on when you open the screen share picker and close it while the camera is still starting.
- A call ends with its "call ended" line and its length in the chat when the contact's app goes away mid-call (a closed tab, a reload, a lost network). Before, the call closed with no line.
- Closing Ghostly (or its tab) mid-call hangs up: the contact's call ends at once instead of about 30 s later when its connection gives up, and the chat that closed keeps the call's end line instead of "call connected" forever.
- When you and your contact call each other at the same moment, the chat now shows one call, as your contact's does. The side whose call gave way used to keep a "call started" line that never ended.
- When you and your contact call each other at the same moment, one of you now gets the ringing call and can answer it. Before, both apps kept showing "Calling..." and neither rang.
- A call that was still ringing when the app reopened shows one "Incoming call" line in the chat, not two.
- A call's length in the chat is written in the app's language ("1 分 5 秒" in Japanese), and a call over an hour says its hours. It was "1m 5s" in every language.
- The lines of a call you were on no longer count as unread messages in the chat list and on the app's icon; a missed call still counts, once.
- A call with the microphone or camera blocked now says so and how to allow it, instead of doing nothing. Answering with it blocked ends the call for the caller at once, instead of leaving it ringing for a minute.
- A call no longer stays on "Connecting..." for good. When the browser finds no network path for a call, Ghostly tries a new connection, and a call that still cannot connect ends after 45 seconds on both sides.
- A call that rings out with nobody answering leaves a "No answer" line in the caller's chat, as the other side keeps "Missed call".
- A call you place that is declined, or that you cancel before an answer, says so in your chat ("Video call declined", "Video call cancelled"), instead of only "Video call started".
- `ghostly call pipe` fed a clip that ends (`ffmpeg -t 3 … | ghostly call pipe > heard.raw`) now plays it and keeps writing what the contact says until the call ends. The end of stdin used to close the call's audio socket, so the pipe quit at once and recorded nothing.
- A call nobody answers stops ringing after a minute. The caller sees "No answer", and the person who was called gets a "Missed call" line in the chat, also when the caller hangs up first.
- A video call on a phone turned on its side keeps your own picture in its corner, clear of the notch. It kept its distance from the left edge instead, and ended up in the middle of the screen, over the contact.
- Your contact's voice plays once in a call. The call window played it from two places at the same time, which could sound doubled or echo, and the chosen speaker had to be set on both.
- A call plays on the speaker you chose even when the browser has given that speaker a new id. It used to fall back to the default speaker and say yours was disconnected.
- A call placed from the headless CLI whose connection fails right after the contact's answer goes in (the same libdatachannel race as a refused answer, ending the other way) now offers again on a new connection. Before, the CLI ended it 3 s later as a hang-up by the contact, and the contact was not told.
- A CLI call that connected after offering again now ends as a hang-up when the contact hangs up, not as `failed`.
- A call placed from the headless CLI no longer fails when libdatachannel refuses its answer twice in a row (seen on Linux arm64): the CLI offers again up to four times, with a short wait before each, and the call connects on the same audio socket.
- The headless CLI and an app that call each other at the same moment no longer both keep calling: the earlier call rings on the other side, as between two apps. The CLI's own call ends with the reason `crossed`.
- The CLI daemon no longer throws "The daemon is stopping" as an unhandled error when a contact's call arrives while it stops: a stopping daemon takes no new call.
- The CLI reports a call as `failed`, not `rejected`, when the contact's app hangs up because it could not connect (for example, its microphone was blocked), as the apps say "Call couldn't connect".
- In the Chrome extension, a call that comes in while no Ghostly tab is open rings as soon as you open Ghostly, and you can answer it. It used to show nothing while the caller kept ringing.
- On a small phone (320 px wide), an incoming video call's Decline, Accept and Accept with video buttons stay round. They used to be squeezed into ovals.
- On Linux, a video call keeps showing the other person's name and picture until their video actually arrives. Before, a call answered with voice only, or with a camera that sent nothing, showed a black screen with no name.
- On Linux, your own camera preview in a video call plays from the start. Before, it stayed frozen on a blank picture for the whole call, even though the other person saw your video.
- On Linux, video calls show your picture on laptops whose camera works only through libcamera, like recent Intel ones. With no camera chosen, the app now uses the camera PipeWire or libcamera lists first. Before, it opened the raw video device, got no picture, and the other side saw black.
- After a call, the chat list's last line says it in the app's language ("Chamada de vídeo perdida"), as the chat does. It showed the English the history keeps ("Missed video call") in every language.
- A second call that rings while you are on a call no longer ends the call you are on. It used to hang up on your contact the moment it rang, or once you declined it and left the chat.
- Picking another camera in a call and then quickly turning the camera off keeps it off, instead of the new camera coming on once it opened. Picking two cameras quickly shows the one picked last.

**CLI**

- `examples/call-echo.mjs` works beside `ghostly call auto on`, as the CLI's README shows it. The daemon answered the call first, the example's own answer was refused ("That call is not ringing here"), and the caller heard only silence: no greeting and no echo. The example now takes a call the daemon answered once it connects.
- `ghostly task send` without `--title`, and `ghostly routine send` without `--name` or `--schedule`, fail as a usage error (exit 2) that names the missing flag, instead of exit 1 with "Status card: title is text".
- `ghostly chat`, `ghostly wallet` and the other groups' first words alone, or with a word they do not take, list the group's commands (as `ghostly help chat` does) instead of only "Unknown command: chat". `ghostly help listen` shows `--print`.
- A CLI daemon no longer grows in memory for as long as it runs. It kept every storage transaction it had ever made, about 100 KB per message, and a 2 hour soak saw it grow 60 to 90 MB an hour.
- `ghostly daemon status` names the daemon's socket (`socket`), as the socket examples said it did. The echo, payment and call bots now ask it when `GHOSTLY_SOCKET` is not set, instead of guessing a path that was wrong for another profile, another `GHOSTLY_HOME`, or a socket moved to `/tmp` because its path was too long.
- The echo bot in the CLI's README, docs/CLI.md, `examples/echo-bot.sh` and the site's CLI page works on Debian and Ubuntu. `listen --exec` runs its script with `/bin/sh`, which is dash there, and the example used bash's `<<<`: every message failed with "Syntax error: redirection unexpected".
- `ghostly edit` and `ghostly group edit` with a message id that is not in the chat or group fail as not found (exit 3), naming the id to give, instead of "Only your own text messages can be edited" (exit 1).
- The npm package `@ghostlytools/cli` holds the examples its README and SKILL.md point to (`examples/echo-bot.sh`, `echo-bot.mjs`, `payment-bot.mjs`, `call-echo.mjs`, `claude-code-agent.sh`). Installed from npm, they were missing, and SKILL.md said "the package's `examples/payment-bot.mjs`".
- The CLI's README says that a `task update` with `--item` replaces the card's items, so an update gives all of them.
- `ghostly task send --item queued:Publishing` is refused with the item states it takes (pending, running, done, failed, skipped), instead of making an item that reads "queued:Publishing". Text without a state, like `Step 2: build`, is still a pending item.
- A task marked done, failed or cancelled no longer says "Now: …" in the text older apps show.
- An agent turn from a 1:1 chat names the contact: `untrusted.name` is the name they gave, as the docs show, instead of always null. A contact's `message.received` event and `chat history` carry it as `message.nick` too.

**Desktop**

- Ghostly for Linux (AppImage) updates itself again. The 1.0.0 AppImage was changed after it was signed, so the app refused the update. A release now signs the AppImage it publishes and checks every platform's update signature before it goes out. Apps on 1.0.0 need nothing: they take 1.0.1 as usual.
- Voice messages record in Ghostly for Linux. Pressing the microphone said "Ghostly can't use the microphone" on every machine, with nowhere to allow it: the app now gives its own window the microphone when you record. A camera or a screen is still never handed to the page.

### For developers

- The AI agents page (ghostly.tools/developers/agents) shows message buttons: in its chat the bot asks to merge with two buttons, you tap Merge, and it closes the question. What your agent can show and What works list `send --button`, `--style`, `--once`, the `button.pressed` event and `button update`.
- The agent skill (`packages/cli/SKILL.md`), the prompt to paste and the AI agents page now teach task and routine cards (statuses, item states, the pull request, one update every 2.5 s), "thinking" while an agent works, group mentions and calls. A test checks that every command and flag they show exists in `ghostly help`.
- The AI agents page (ghostly.tools/developers/agents) shows a bot at work: a chat where it thinks, posts a task card that runs to done and a routine card, then three steps to connect your own agent.
- CI reads whether a pull request is a draft from GitHub when a run starts, not from the event that started it. Pushing and then leaving draft a second later no longer leaves a red CI Success that only a manual rerun could clear: whichever of the two runs survives plans and checks the pull request as it is now.
- The CLI is tested on Linux arm64 (Graviton, Ampere, Hetzner ARM, Raspberry Pi) as well as x64: every pull request installs the npm package there, starts a daemon with WebRTC and calls, and runs the CLI's tests, a voice call between two bots included.
- The full E2E run pulls only the images it cannot build: `docker compose pull` stopped at the two it builds itself (the HyperDHT relay and the AT Protocol server), so every nightly since 2026-09-27 failed before a test ran.
- The engine's known errors have stable codes: `ENGINE_ERRORS` in `@ghostly/core` (`engineError(code, values)`, `parseEngineError(text)`). Their English text is unchanged, so the CLI prints the same words; an `EngineError` carries its code as `engineCode`.
- The three apps live under `apps/`: the web app in `apps/web/`, Ghostly Browser in `apps/extension/` and the Desktop (Tauri) app in `apps/desktop/` (it was `src-tauri/`). Builds land in `apps/web/dist` and `apps/extension/dist`; `docker compose up --build` from the repository root builds the web image as before.
- `native-transports/` is split by what runs where: the Desktop's Iroh and HyperDHT code (and the Iroh wasm crate) in `native/transports/`, the HyperDHT relay for browsers in `services/hyperdht-relay/` and the reference push relay in `services/push-relay/`.
- The shared UI moved to `apps/ui/`: `src/` is now `apps/ui/src/` (strings in `apps/ui/src/locales/<language>/<area>.json`), with its `index.html`, `public/` and Vite and Vitest configs beside it. `npm run dev` and `npm run build` work as before; the Desktop's build lands in `apps/ui/dist`. The repository root keeps only the workspace configs and the project documents.
- The website moved from `website/` to `apps/website/`, beside the other apps. Its commands are unchanged; run them in `apps/website/` (`npm run dev`, `npm run sync:references`, `docker compose up -d --build`).
- The older Rust `ghostly-cli`, the client for v0.4 chats that the release stopped shipping at 1.0, is removed from the repository: `ghostly` (`@ghostlytools/cli`) is the CLI. Its v0.4 record format stays documented in WISP 402. `tsconfig.tsbuildinfo` is no longer tracked, and the hero banner moved to `docs/assets/`.
- A release's `latest.json` is written only when every bundle's signature was made for the tagged version. Tauri 2.12 records the version in the signature, and the updater refuses an update whose manifest announces another one.

**Tests**

- The Linux Desktop's device test (`e2e/desktop/call-devices.spec.ts`) always runs on a PulseAudio of its own. It used the machine's running server when there was one: it switched the person's default microphone and speaker for the run, and on a PipeWire desktop it failed at once (no null source there).
- The D-Bus session bus each Linux Desktop end-to-end app gets starts only xdg-desktop-portal and its permission store, which WebKitGTK needs to show a call's picture. It read the system's session configuration, so on a Linux desktop the app's first call into the portal started a whole set of portals and backends on the person's live Wayland session, one set per test, and on Hyprland xdg-desktop-portal-hyprland crashed as each bus went away (a crash notice per test).
- Each Linux Desktop end-to-end app runs on a D-Bus session bus of its own: on a Linux desktop its WebDriver session opens in about 2.5 s instead of 30 s, and nothing it does reaches the person's own session bus.
- A Desktop end-to-end test that closes an app and opens it again no longer runs two apps on the same profile: `stop()` waits for the processes the app's driver started, by their own PIDs, to end (SIGTERM, then SIGKILL) instead of leaving one running with its window open.
- The regtest suites no longer time out waiting for LND to sync on a shared stack nobody mined on for a while: `ensureMiner` mines one block when the chain's tip is over an hour old.

**Calls**

- A call that ends writes why in the diagnostic log (the Desktop's log file, or the console with link traces on): a hang-up here or from the contact, a failed connection with its ICE and connection states, the app leaving, or its chat unloaded mid-call.
- On Linux, the app's log says when the other side's sound and video first arrive and first decode, which path the call took, and how much RTP went each way when it ends. `native_call_stats` carries the same counts as `rtp`, and every call pipeline logs its errors.

**Bots**

- `ghostly button press <chat> <message> <button>` presses a button of someone else's question from the CLI, as a tap in the app does. A test bot or a person in a terminal no longer needs `engine pressButton`.
- `button.pressed` now carries `untrusted.name`, the name the person gave themselves. `name` stays the chat's name here (the label you gave it), and the README and SKILL.md now say so; before, they called `name` the contact's own name.
- `GHOSTLY_PKARR_RELAYS=http://…,…` keeps a CLI profile on your own Pkarr relays from its very first run, as on the Desktop, and leaves the public Mainline DHT out unless `GHOSTLY_DHT_BOOTSTRAP` is set. The README now says to set the relays before the first `daemon` on a private network.
- The echo bot example keeps its cursor in the Ghostly folder in use (`GHOSTLY_HOME`) instead of always `~/.ghostly`, and the README documents `ECHO_CURSOR`.
- The README and `ghostly help send` say that everything after `--` is message text, options like `--wait sent` included.

**Groups**

- A CLI test runs a community between this build and an older release (`GHOSTLY_OLD_CLI`), or this build acting as one from before native group links, in both directions.

**Everywhere**

- Opening an invite link, a web+ghostly: link or a group's link no longer logs a "No routes matched location" warning in the console. Nothing changes in what the app does or shows.
- Buttons for bots: `ghostly send <chat> "…" --button yes:Yes --button no:No` (and `group send`), `button.pressed` in `ghostly listen`, and `ghostly button update --chosen yes --close` to mark the answer.
- Bots can send a task as a small card with its progress, the step it is on and its pull request, and keep it current: `ghostly task send` and `ghostly task update`, in chats and groups. Apps without cards show a short text instead.
- The website's development server (`next dev`) allows `eval()` in its script policy, which React's development build needs for its debugging tools; the built site still never allows it.

### For users

**Chat**

- Screen readers now announce a message that comes into the open chat or group: who sent it and how it starts, or how many came when several arrive at once. The chat's history and your own messages are not read out.
- A tap on a picture in a chat opens it large, whole and in its own shape. A long press on it still opens the reactions.
- Bots can ask with buttons under their message, like Yes and No. Tap one to answer, and once the bot takes it, the buttons show the answer. Apps without buttons show the question as text, and a tap reads there as a reply.
- A bot's routine shows as a card with its schedule, how its last run went and when the next one is; tap it for the recent runs. Bots send them with `ghostly routine send` and `routine update --run ok`.
- A bot's task and routine cards have a cleaner look: they take the theme's message colour with a thin border, and a long title ends in "…" instead of running into the time or the next run. A routine is one line on a wide screen and two on a phone, and shows its full name, schedule and last change when opened.
- The Tasks panel shows each bot's picture (or its initial in its colour) beside its name, so you can tell bots apart at a glance.
- A bot's task and routine cards now stand on their own in the chat, as cards rather than message bubbles, with no "edited" mark: they say when they were last updated instead.
- A task card says how long it has been running, blocked or queued, or how long it took once finished, in the chat and in the Tasks panel.
- A bot's task shows as a small card with a progress bar, its status and its pull request's size; tap it for the steps and links. A Tasks button in the chat's header lists the tasks, the ones still going first.
- The Tasks panel reads well with many bots: each bot's tasks first, its routines folded into one line, finished tasks folded at the end. It scrolls inside the window and is a sheet on a phone. In the chat a routine card is one line, and a bot's routines in a row fold into one row that opens on a tap.

**Wallets**

- The first time a Mainnet wallet receives real money, the Wallet page asks once to back it up, with a dot on the wallet icon. Its button goes straight to the recovery phrase, or for Cashu to a profile backup. Later puts it off until the next receive or three days. Test coins never ask.
- A new profile is ready to receive: on its first start Ghostly makes a Mainnet Cashu wallet (Lightning) and a Mainnet USDT wallet in the background. Nothing is spent, and a wallet you remove stays removed. One that could not be made says why on the Wallet page, with Try again, and Ghostly tries again at the next start. "Start on Mainnet" makes the same wallets.

**Everywhere**

- Desktop on a Mac: closing the window (its red button or Cmd+W) no longer quits Ghostly. The window hides and the app keeps running, so messages, calls and notifications go on; click the Dock icon or a notification to bring it back, and quit with Cmd+Q. On Linux and Windows, closing the window still quits.
- Desktop: File → New Chat (Cmd+N) starts a chat and Ghostly → Settings… (Cmd+,) opens Settings on a Mac. On Linux and Windows, Ctrl+N and Ctrl+, do the same.
- Desktop: the Dock icon on macOS shows how many messages you have not read, the same count the installed web app shows on its icon, with muted chats left out unless a mention gets through. It clears when you have read them. Linux desktops that show launcher badges get it too.
- Ghostly Browser's description on chrome://extensions and in the Chrome Web Store now reads in the browser's language, in the app's 8 languages.
- The chat list's line for a pasted invoice, address or ecash is in your language, and a contact who does not accept payments reads "Not accepted" on the payment cards in every language.
- The chat, its connection panel, the connection history, call lines, voice, audio, video and file bubbles, and the composer now speak your language: they were left in English in Portuguese, Spanish, French, Italian, Japanese, Chinese and Arabic.
- Payments in a group are translated: the note saying who paid whom and how it stands, and the picker to pay a member or ask the whole group.
- Groups and identities speak your language: a group's header, join steps, membership lines, members panel, link, connection and leave dialogs, the Identities page, ID cards, the identity picker, a contact's identities and the Nostr section are now translated in all 8 languages, with Arabic read right to left.
- The wallet screens are translated: the first wallet setup, each wallet's panel, New, Remove, test coins and the payment sheet now speak your language, and Arabic reads right to left there too.
- The web app shows where to install it: Install app in the account menu, Install at the top of Settings, and a small hint above the chat list once you have used it a little (Not now hides it for good). On Safari it shows the steps: Share, then Add to Home Screen on iPhone and iPad; File, then Add to Dock on a Mac.
- Restoring a backup of a profile that is still on this device now warns first: the copy would act as the same person to your contacts. Choose Replace the original (the copy is restored, then the original's removal opens with its usual checks), Restore as a copy anyway, or Cancel.
- When Settings says it could not check for updates, its ⓘ now says why (offline, the update server out of reach or too slow, no update for this system yet, a signature that did not check out), with the updater's own message under it.

**Calls**

- A call that rings while you are on another call now offers End and answer or Decline, like a phone. End and answer hangs up the call you are on, then answers. You are never on two calls at once.

**Groups**

- Each member of a group has a colour of their own: their name above their messages, a quote of theirs, a mention of them and the typing line all take it, so you can tell who wrote what at a glance. The colour comes from the member's key, so it stays the same on every device.
- A member's picture sits beside the last message of each run of theirs (their initial or pattern when they have none). A tap on it or on their name opens the members list with them marked. In a very narrow chat only the colours stay.
- In a group, a member's name shows once over each run of their messages, as in WhatsApp. A new run starts after another member's message, a group notice, a pause of more than five minutes or a new day.
- Members' colours are given out over the group's member list, so in a group of up to 12 no two members share a colour (and in a small group their colours are far apart), and every member sees the same colours. A colour can change when someone joins or leaves.
- Ghostly Desktop on Linux takes part in groups: make a private group or a community, join one by its link, and chat with members on the web app, the extension, the Mac app and the CLI. Its app has no WebRTC, so its group links go over Iroh or HyperDHT, as its 1:1 chats do. Members whose apps are older still reach it only over WebRTC, so they need an update to reach a Linux member.

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
