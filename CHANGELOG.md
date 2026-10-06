# Changelog

## Unreleased

<!-- Notes for the next release. A new entry goes in docs/changelog/unreleased/ (one file per change, see docs/changelog/unreleased/README.md), not here: tools/scripts/bump-version.mjs adds those files below at release and turns this heading into the version. Editing a line already here is fine. -->

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
