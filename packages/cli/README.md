# ghostly: Ghostly for bots and terminals

`ghostly` runs **the Ghostly app's own engine** without a screen: the same chats, groups and protocol as the web app,
the extension and the Desktop, on Node. A bot keeps a profile online with `ghostly daemon`, reads what happens with
`ghostly listen` (JSON lines), and acts with the other commands (JSON answers). The contract behind it, and why it
is built this way, is [WISP 11xx](../../docs/wisps/11xx-headless.md). A guided tour: [docs/CLI.md](../../docs/CLI.md).

> Status: phases 1 to 5 (profiles, pictures and backups, invites, one chat, private and community groups with their
> admin tools and hubs, the event stream, hooks and agent turns, wallets and payments, files and voice notes, identity
> proofs, shared web apps, voice calls, typing, replies, edits, reactions and forwards, Pkarr over the Mainline DHT;
> the npm package `@ghostlytools/cli`, published from 1.0); every engine call is already
> reachable through `ghostly engine <method>`. The older Rust `ghostly-cli` (the `cli/` folder) stays as the
> compatibility client for v0.4 chats; it is not this package, and from 1.0 the release no longer ships it.

## Install

From 1.0: `npm install -g @ghostlytools/cli`. Until then, from this repository:
<!-- release-1.0: "From 1.0:" becomes "Install:", and "Until then, from this repository" becomes "Or from this repository". -->

```bash
npm install
npm run build -w @ghostlytools/cli
npm pack -w @ghostlytools/cli              # ghostlytools-cli-<version>.tgz: the bundle, its WebAssembly, README and SKILL.md
npm install -g ./ghostlytools-cli-*.tgz    # the `ghostly` command, with its dependencies from npm
ghostly --version
```

Node 22.12 or newer. WebRTC comes from `node-datachannel` (a native
module with prebuilt binaries for Linux, macOS and Windows); without it the CLI still runs, over HyperDHT, Iroh and
the DHT, and groups are unavailable.

The bundle holds the app's engine (`@ghostly/browser`, `@ghostly/core`, Iroh's and Breez's WebAssembly); every other
package it imports is a dependency in package.json, which `test/packageDeps.test.ts` keeps true.

## Five minutes

```bash
ghostly profile set --name "Echo bot"        # the name contacts see
ghostly daemon --detach                        # keep the profile online
ghostly invite create --label alice            # {"chat":"…","invite":"ghostly1…","link":"https://ghostly.tools/#ghostly1…"}
ghostly chat wait alice --until live           # once Alice joined (in the app, or another ghostly)
ghostly send alice "hello"                     # {"chat":"…","messageId":"me_…","delivery":"sending"}
ghostly listen                                 # one JSON event per line, until stopped
```

An echo bot ([examples/echo-bot.sh](examples/echo-bot.sh); the event arrives on the command's stdin, never in its
arguments, so a contact's text cannot reach the shell):

```bash
ghostly listen --type message.received --cursor ~/.ghostly/echo.cursor --exec '
  event="$(cat)"
  printf "echo: %s" "$(jq -r .message.text <<<"$event")" | ghostly send "$(jq -r .chat <<<"$event")" --stdin'
```

The same bot on the socket, without jq: [examples/echo-bot.mjs](examples/echo-bot.mjs). A payment bot that takes
requests, tips and "balance" in a chat, with test coins: [examples/payment-bot.mjs](examples/payment-bot.mjs).
A Claude Code agent on `listen --turns` with an allowlist (it will not start without one), "thinking" while it works
and `send --reply` for its answer: [examples/claude-code-agent.sh](examples/claude-code-agent.sh).

## Profiles

Each profile is a folder, `~/.ghostly/profiles/<name>/` (0700; files 0600), with its own chats, keys and wallets.
`--profile <name>` (or `GHOSTLY_PROFILE`) picks one; `ghostly profile use <name>` sets the current one;
`--home <dir>` (or `GHOSTLY_HOME`) moves the whole folder. The `default` profile is made on first use, others with
`ghostly profile create <name>`.

Only one process opens a profile at a time. When a daemon runs it, every command goes through the daemon's socket.
When none does, a command runs the profile itself for as long as it needs (a **one-shot**) and leaves: `send` then
waits until the message went out. Bots should run the daemon: a one-shot is offline between commands.

## Commands

Every command prints one JSON object on stdout. A failure prints `{"error":{"code","message"}}` and exits with:
`1` failed (the engine or the network refused), `2` usage, `3` not found, `4` timed out, `5` needs a confirmation
(`--force`, `--yes`, `--confirm-real`). A `<chat>` is its id, a unique prefix of it, or its name; a `<group>` too.

The rows are in alphabetical order of their first command, and every command of `ghostly help` has one
(`test/readme.test.ts` checks both).

| Command | What it does |
|---|---|
| `call auto [on\|off] [--from <chat>]… [--rate n]` | Answer calls by themselves, from anyone or the chats named (kept in the profile) |
| `call hangup [<chat\|call>]`, `call list`, `call flush [<chat\|call>]` | Hang up (or decline); calls on now; drop the audio queued and not played yet |
| `call pipe [<chat\|call>]` | A call's audio on stdin and stdout, for shell pipelines (sox, ffmpeg) |
| `call start <chat> [--rate 48000]`, `call answer [<chat\|call>] [--rate n]` | Voice calls (daemon): the result names the call's audio socket ([Calls](#calls)) |
| `chat accept <chat> <method> [--off] [--networks mainnet,testnet]` | Which ways of paying the chat takes |
| `chat connect <chat>`, `chat disconnect <chat> [--hold <minutes>]` | Reconnect now (ends a hold); close the live session, or with `--hold` stay off the direct link that long ([Staying off the direct link](#staying-off-the-direct-link)) |
| `chat history <chat> [--limit n] [--before x] [--after x]` | Messages, oldest first; `x` is a message id or a time in ms |
| `chat list`, `chat show <chat>` | Chats, and one chat's connection: transports, last attempt, comparison code |
| `chat pay <chat> <sats> [--memo t] [--network n] [--confirm-real]` | Ecash to a contact |
| `chat rename <chat> <name>`, `chat remove <chat> --yes` | Name it here; delete it (keys and history) here |
| `chat request <chat> <sats> [--memo t] [--method m] [--rail r]`, `chat pay-request <chat> <payment>` | Ask a contact to pay; pay the contact's request |
| `chat transport <chat> <auto\|dht\|webrtc\|iroh\|hyperdht>` | What carries the chat |
| `chat verify <chat> --code <code>` | Mark the contact verified after comparing the codes out of band |
| `chat wait <chat> [--until live\|text\|paired] [--timeout s]` | Wait for a chat to go live, carry text, or see its contact |
| `daemon [--detach]`, `daemon status`, `daemon stop`, `daemon restart` | Keep the profile online; `restart` stops it and starts this release's code in the background ([After an upgrade](#after-an-upgrade)). Ctrl-C, SIGTERM and the terminal closing (SIGHUP) stop it cleanly |
| `edit <chat> <message> [text… \| --text <text> \| --stdin] [--force] [--wait none\|confirmed] [--timeout s]` | Replace the text of a message you sent (1:1 chats, `group edit` for a group; `<message>` is the `messageId` `send` gave, or its wire id). The contact sees it in place, marked edited; `--wait confirmed` waits for its app to confirm (the default without a daemon). At most 100 edits a message, no time limit; an older contact app gets it once it shows edits |
| `engine <method> [json \| -] [--confirm-real] [--show-secret]`, `engine --list` | Any call of the app's engine |
| `events [--since seq]` | What the event journal holds, without following |
| `file list <chat>`, `file accept\|decline\|pause\|resume\|cancel [<chat>] <file>` | Transfers; a file over 25 MiB waits for `file accept` (files/3). A file's id names its chat, so `<chat>` may be left out |
| `file resend [<chat>] <file>`, `file request [<chat>] <file>` | A file that stopped moving: sent again from here, or asked for again from the contact; either goes on from the bytes the receiver holds (files/3) |
| `file save [<chat>] <file> [--dir d \| --path p] [--force] [--wait [--timeout s]]` | Write a received file to disk (never over one without `--force`; an unfinished one says how many bytes are here; `--wait` waits for it first) |
| `file send <chat> <path> [--name n] [--mime t] [--voice [ms] [--peaks …]] [--reply <message>]` | A file, or a voice note (its length and waveform measured from the file unless given); `--reply` quotes a message, as `send --reply` does |
| `file wait [<chat>] <file> [--timeout s]` | Wait until a transfer ends: exit `0` when the file is all here, `1` with the transfer's error when it failed (`details.retry`: `file resend` can go on), `4` on timeout (default 300 s) |
| `forward <chat\|group> <message>… --to <chat\|group>… [--force] [--wait none\|sent] [--timeout s]` | Forward messages to up to 5 chats and groups (`--to` again for each; `group:<id>` names a group when a chat has the same name; an id that starts with a dash is taken as it is, `--to -Ab…` or `--to=-Ab…`). Each is a new message of yours that says it was forwarded (`forwarded`, the hop count) and nothing of who wrote it. Files go from the bytes this profile holds, never fetched again; a group takes texts only. A text that looks like a seed, a key or ecash needs `--force`. Answers `{from, results: [{to, kind, messageIds, error}]}`; any refusal fails the command (exit 1) with the results in `details`. `--wait sent`: each text on its way (a group's taken by an edge), each file's transfer done |
| `group create <name> [--mesh]`, `group join <link>` | A community (a link anyone can open), or a private mesh |
| `group edit <group> <message> [text… \| --text <text> \| --stdin] [--mention <member>]… [--force]` | Replace the text of a message you sent to the group (`<message>` is the `messageId` `group send` gave). Every member sees it in place, marked edited; mentions whose `@name` is still in the text stay, `--mention` adds more. Answers `{group, messageId, edits, sent, edges}`; `--wait sent` and `--timeout` as for `group send`. A private group's members whose edge is down get it when it opens, a community's with the catch-up; a member on an older app keeps the old text |
| `group hub <group> <member> [--pin \| --exclude \| --auto]` | Past 16 members: pin a member as a hub, keep one from being a hub, or leave it to their app (a daemon offers itself) |
| `group invite <group> <chat>`, `group remove <group> <member>`, `group admin <group> <member>` | Membership, for the admin (each prints the group; `--show-secret` for its link) |
| `group leave <group>`, `group forget <group> --yes`, `group accept\|decline <group>` | Membership |
| `group list [--show-secret]`, `group show <group> [--show-secret]`, `group history <group>` | Groups, members, history; a message names its author (`member` key, `nick` from the roster). The entry link prints as `<hidden>` without `--show-secret` |
| `group react <group> <message> <emoji> [--remove]` | React to a group's message |
| `group rename <group> <name>` | A new name, for the admin (1 to 64 characters on one line); the picture stays. Members see it once it reaches them; until then, and on apps from before names, the group keeps the name it had when they got in |
| `group rotate <group>`, `group link <group> [--off] [--reset]`, `group picture <group> <jpeg> \| --clear` | A fresh secret; the link (printed: asking for it is asking for the secret); the picture |
| `group send <group> [text…] [--mention <member>]… [--reply <message>] [--wait none\|sent] [--timeout s]` | Send; each mentioned member is written as `@name` in the text. Answers `{group, messageId, sent, edges}`: the id `--reply`, `group react` and `group edit` take, and how many edges took it so far. A group has no receipts: `--wait sent` waits until at least one edge took it (a member's in a private group, one of your hubs' in a community), and exits 4 after `--timeout` (default 30 s) if none did; the message still goes when an edge opens, while the profile is online. Use it for a one-shot send with no daemon |
| `group typing <group> [--kind typing\|recording\|thinking] [--status "<text>"] [--for s] [--stop]` | `typing` in a private group: the members whose edge is open see "Ana is typing…" (or recording, thinking, or your status line), with the same rules, 6 s hold and `--for`. Answers `{group, typing, kind, status, reached, sendTyping}` (`reached`: members with an open edge). A community does not carry typing yet (exit 1, `unavailable`) |
| `identity add <provider> [subject] [--signer id] [--field name=value]… [--days n]` | A proof: an in-app signer (NIP-46 and the like) finishes here; a tool or a published record answers with the statement |
| `identity complete <draft> [--evidence-file f \| --stdin]`, `identity cancel <draft>` | Finish it with the tool's output (or nothing, for a published record); needs the daemon that began it. Cancel drops one not finished |
| `identity providers`, `identity list` | Kinds of proof and their signers; this profile's proofs |
| `identity share\|withdraw <chat> <id>`, `identity contact <chat>`, `identity recheck <chat> <id>`, `identity remove <id>` | Show a proof to a contact; what a contact showed, as checked here |
| `invite create [--label <name>]` | A new chat's `ghostly1…` invite and its link |
| `invite join <invite-or-link> [--label <name>]` | Join a chat (your own invite is refused) |
| `lightning default <card>`, `lightning rename <card> <name>` | Lightning cards: which receives by default |
| `listen [--since seq] [--cursor file] [--type t]… [--turns] [--from <chat\|key>]… [--group <group>]… [--exec cmd] [--webhook url] [--print]` | The event stream; `--from` and `--group` an allowlist, `--turns` one `agent.turn` per message to answer ([Events](#events)) |
| `message retry\|delete\|details <chat> <message>` | One message |
| `pay <invoice\|address\|lnurl> [--amount sats] [--network n] [--max-fee sats] [--confirm-real]` | Pay over Lightning (Testnet unless `--network mainnet`) |
| `payment list [--chat c]`, `payment check <chat> <payment>`, `payment reclaim <payment>` | Payments and requests |
| `pin <chat\|group> <message> [--remove]` | Pin a message at the top of a chat or group, for everyone in it: one per chat, a new pin replaces it, `--remove` unpins. In a community only the admin pins. A 1:1 pin reaches the contact on the next live session; the other side hears `chat.pinned` or `group.pinned` |
| `profile backup --out <file>`, `profile restore <file> <new profile>` | An encrypted backup (WISP 05 envelope); the passphrase from `--passphrase-file` or `GHOSTLY_BACKUP_PASSPHRASE` |
| `profile create <name> [--use] [--name <shown>]`, `profile list`, `profile use <name>` | Profiles |
| `profile picture <jpeg> \| --clear` | The picture contacts see (a JPEG within 512 px; 128 px is what the app sends) |
| `profile show`, `profile set [--name <name>] [--share-profile \| --no-share-profile]` | The name contacts see |
| `react <chat> <message> <emoji> [--remove]` | React to a message with one emoji; a new one replaces yours, `--remove` takes it back |
| `send <chat> [text…] [--reply <message>] [--stdin] [--force] [--wait none\|sent\|delivered] [--timeout s]` | Send text (arguments, or stdin); `--reply` quotes a message of the chat |
| `service add <name> <http://127.0.0.1:port>`, `service share <service> <chat> [--off]`, `service list`, `service remove\|enable` | Share a web app on this machine, per contact |
| `service peer <chat>`, `service open <chat> <service> [--port p]`, `service close <chat> <service>` | A contact's app on a loopback port here (daemon) |
| `settings get [--show-secret]`, `settings set <key> <json>` | Relays, Iroh relays, the HyperDHT relay, ICE servers, `sendTyping` (false: contacts are never told you type), … |
| `status` | The profile, its chats, whether WebRTC and calls run, the last event seq |
| `typing <chat> [--kind typing\|recording\|thinking] [--status "<text>"] [--for s] [--stop]` | Show the contact you are writing, recording or thinking, or a short status line in its place ("Transcribing your audio…", 40 characters, no links): live chats only, it holds 6 s there; `--for s` keeps it on that long (up to 600 s; a one-shot stays that long); a new kind or status shows at once; a message to the chat or `--stop` ends it |
| `wallet create <type> [--network testnet] [--provider id] [--value name=value]… [--stdin] [--invite code] [--api-key key]` | A wallet: `cashu`, `lightning` (a card: its source's form in `--value`), `arkade`, `spark` (on Mainnet, `--api-key` is your Breez API key), `bitcoin` (BDK), `fedimint` (`--invite` is the federation's invite code), `usdt`. With `--stdin`, secret fields come as `name=value` lines on stdin (`api-key=…` too), out of `ps` and the shell's history |
| `wallet faucet <type>`, `wallet add-mint <url> [--primary]` | Test coins; another Cashu mint |
| `wallet list [--network n]` | Wallets and balances, and what `wallet create` can make on each network |
| `wallet receive <sats>`, `wallet address <type>`, `wallet redeem [<token>]`, `wallet history` | Receive, and what came and went. `wallet redeem` reads the token from stdin when none is given, which keeps it out of `ps` and the shell's history |
| `wallet remove <type> [--network n] [--card id] [--accept-loss]` | Refused while it holds money or waits for some, unless `--accept-loss` |

Help: `ghostly help` lists every command; `ghostly help file` (or `ghostly file --help`) a group; `ghostly help file
save` (or `ghostly file save --help`) one command, with its options. `-h` works too, except after `--`.

Arguments: an option's value is taken as is, even when it starts with `-`. So is an id in a positional that takes
one (`<chat>`, `<group>`, `<message>`, `<file>`, `<payment>`, `<draft>`, `<id>`, …): drafts, payments and groups
are base64url, which starts with `-` one time in 64. Any other positional that starts with `-` is refused (a
mistyped flag must not reach a contact as text): put `--` before a message that starts with a dash.

### Voice notes

`file send <chat> <path> --voice` sends an audio file as a voice note. Its length (`--voice <ms>`) and its 64
waveform bars (`--peaks 0,40,…`, 0-255) may be given; whatever is not given is measured from the file with the
app's own meter (`voicePeaksOf` in packages/core `voice.ts`: a reading every 50 ms, the loudest per bar), so the
bars look like the app's recordings. WAV, Opus in WebM or Ogg and MP3 are decoded in the CLI (wasm, no native code);
AAC in MP4/M4A and other kinds need `ffmpeg` on the PATH (`GHOSTLY_FFMPEG` names another). When the sound cannot be
read, a note with a given length goes out flat with a warning on stderr (the socket API answers `warning`), and one
without is refused (`bad_request`). `--voice` takes the next word only when it is a number.

### Files a bot receives

`message.received` carries the file: `message.file` is `{id, name, size, mime, voice?}`, and a voice note's `voice`
is `{duration, peaks?}` (milliseconds, and the 0-255 bars; releases before this one said only `voice: true`). The
`file.*` events name the file's message and chat (`messageId`, `chat`). So a bot answers a voice note without polling:

```bash
ghostly listen --type message.received --exec '
  file="$(jq -r ".message.file.id // empty")"
  [ -n "$file" ] && ghostly file save "$file" --dir ./inbox --wait --timeout 120'
```

`file wait <file>` alone does the waiting: exit `0` when done, `1` with the error when it failed, `4` on timeout.

### Staying off the direct link

`chat disconnect <chat>` closes the live session, but the contact's app dials again within seconds.
`chat disconnect <chat> --hold <minutes>` (up to a week) keeps the chat off its direct link for that long: it is the
chat's own "DHT only" choice (WISP 400: either side choosing it keeps both off the live link), taken back when the
time is up. Meanwhile text still goes over the DHT (up to 256 bytes a message; longer ones wait), files, calls and
typing wait, and the contact's app shows the chat as DHT only. `chat connect`, or `--hold 0`, ends it early. The
hold is kept in the profile folder: a daemon that restarts takes it back when its time is up, and a DHT only the chat
had chosen itself (`chat transport dht`) is never undone by it. `chat show` answers `heldUntil` (a time in ms, or
null; `hold` there is the store-and-forward state, something else), and the stream says `chat.held` and
`chat.released` (`reason`: expired, connect or lifted).

`settings set online false` is different: the whole profile goes offline, every chat, DHT included, and nothing
arrives until it is back online.

### After an upgrade

A daemon keeps running the code it started with. After upgrading the CLI, every command that goes through an older
(or newer) daemon still answers, and says on stderr `ghostly: the daemon runs <version> and this command is
<version>`. `ghostly daemon restart` stops the running daemon (if one runs) and starts this release's in the
background, as `daemon --detach` does. A daemon kept by a service manager (systemd, launchd) is restarted with the
service manager instead.

### The secret guard

`send` and `group send` refuse text that looks like a recovery phrase, a private key (nsec, WIF, xprv, 64 hex
characters named as a key) or a Cashu token (money anyone who reads it can take), with exit `5`, unless `--force`.
It is the app's own detector.

### Real money

A spend on Mainnet needs the engine's `confirmedReal` (the app asks the person). The CLI sets it only with
`--confirm-real`, and refuses a `confirmedReal` it was not given that flag for. Test networks need nothing.

### Identities on Node

SSH (`ssh-keygen`), OpenPGP (`gpg`) and Bitcoin (a wallet's "sign message") proofs are made with the tool: `identity
add` prints the statement and the command, `identity complete` takes its output. A domain or a DID publishes a record,
then `identity complete` asks the engine to look it up. In-app signers (a Nostr signer over NIP-46, Pubky, AT
Protocol) run in one `identity add`, with their fields in `--field`, and print what they wait on (a link, a code) to
stderr. OpenID Connect needs a browser window: make that proof in the app.

### Wallets on Node

Cashu (and Lightning through the mints), Lightning cards (NWC, LND, Core Lightning, Breez, Fedimint; a Lightning address or LNURL is paid with `pay`), Arkade,
Spark, BDK, Fedimint and USDT run as in the app. One does not yet: **Bark** (its SDK ships a browser build only);
`wallet list` offers it as unavailable, with the reason. A Fedimint wallet joins a federation by its invite
(`wallet create fedimint --invite fed1…`); its Lightning card is `wallet create lightning --provider fedimint --value
federation=<id>` (`engine fedimintPreview '{"invite":"fed1…"}'` shows the id first). Its client runs in a worker
thread, with one database file per federation in the profile's `fedimint/` folder. No wallet is made by itself: a bot has exactly the wallets it created. A Cashu test mint's invoice (from
`wallet receive`) is credited once its payer vouches for it in a chat, as in the app (a test mint says every invoice
is paid); on a real mint, the mint's answer decides.

### Secrets

Nothing prints a seed, a key, a wallet phrase or ecash unless asked with `--show-secret`: `settings get` masks
credentials, and engine calls that answer with secrets (`exportLinks`, `walletExport`, the wallets' backups) are
refused without it. A group's entry link lets anyone who reads it join: `group show`, `group list`, the admin
commands, `group.created` events and `engine getState` print it as `<hidden>`; `--show-secret`, `group create` and
`group link` print it.

## Events

`ghostly listen` prints one event per line:

```json
{"seq":6,"id":"message.received:f3gg…:peer_jY7N…","type":"message.received","at":1790450767762,"chat":"f3gg…","message":{"id":"peer_jY7N…","chat":"f3gg…","from":"peer","text":"hello bob","timestamp":1790450767735,"delivery":null,"deliveryError":null,"via":"datalink","nick":null}}
```

- `seq` grows by one per event in the profile, across restarts; `id` is the same whenever the same fact is reported.
  Dedupe by `id`; resume with `--since <seq>`, or let `--cursor <file>` remember the last event handled.
- Types: `daemon.started`, `chat.created`, `chat.removed`, `chat.renamed`, `chat.pairing` (`stage`: publishing,
  waiting, resolving, on-dht, live, …), `chat.connection` (`live`, `transport`), `typing.started` (with `kind` and, when given, `status`; again when either changes) and `typing.stopped` (the contact is writing, or stopped: a message, a stop, or 6 s of silence), `chat.joined` (the contact's app
  announced itself; not a message), `chat.announced`, `message.received`, `message.sent`, `message.delivery`
  (`delivery`: sending, queued, waiting, held, sent, delivered, failed), `message.edited` (a text changed in place, the
  contact's or mine: once per edit number, with `edits` and the message as it is now; `group.message.edited` in a group), `message.deleted`, `group.created`,
  `group.status`, `group.members` (`joined`, `left`), `group.typing.started` (`member`, `kind`, and `status` when given; again when either changes) and `group.typing.stopped` (`member`: a member of a private group is writing, or stopped), `group.message` (`message.member` is the author's key,
  `message.nick` their name from the roster; `message.mentioned` when it names this profile), `group.sent`, `group.event`, `file.offered` (a file over 25 MiB waits for `file accept`),
  `file.stage`, `file.done`, `file.failed` (each with `chat`, `file`, `messageId`), `chat.held` and
  `chat.released` (`chat disconnect --hold`), `identity.received` and `identity.status` (what a contact
  showed, as checked here), `identity.approval` and `identity.progress` (a signer waits on a link or a code), `group.deleted`, `group.removed`, `payment.created` and
  `payment.updated` (`payment`: id, chat, kind request|payment, direction in|out, amount, memo, state pending|
  settled|failed, network, method), `call.incoming`, `call.outgoing`, `call.connected` and `call.ended` (voice
  calls: see [Calls](#calls)), `events.gap` (the journal no longer holds what `--since` asked for).
- A message that answers another carries `replyTo`: `{id, snippet, from, member?, found}`. `id` is the original's
  message id in this chat when it is here (`found: true`, and `snippet` and `from` come from that copy), else the id
  the reply named; `from` is `me`, `peer` or null (only the id came, over the DHT). Answer one with
  `ghostly send <chat> --reply <message id> "…"` (`group send` too): the id from history or from the event.
- Reactions (WISP 400 § Reactions): `message.reaction` (a chat) and `group.reaction` (a group) say each change once:
  `{messageId, by, emoji, removed, mine}`, with `by` `me`, `peer` or a member key, `emoji` "" when taken back, `mine`
  when the message is this profile's. `chat history` lists each message's `reactions`: `[{by, emoji, at}]`.
- Pins (WISP 400 § Pinned message): `chat.pinned` (with `chat`) and `group.pinned` (with `group`) when someone else pins
  or unpins: `{messageId, ref, by, removed}`, with `messageId` the message's id here (null when it is not here, or
  unpinned), `ref` the id both sides know it by, and `by` `peer` or a member key.
- `--type message.received` keeps one type; `--type message.` (or `message.*`) a family.
- `--from <chat|key>` and `--group <group>` (again for more): an allowlist. Only the chats (id, prefix, name, or the
  contact's `peer` key, which also matches a chat made later) and groups named get through; any other chat's or
  group's event stops before `--exec`, `--webhook` and stdout (the message stays in the chat; the cursor moves past
  it). The profile's own events (`daemon.started`, `events.gap`, `identity.approval`) pass. Names become ids once,
  at the start. A flag, not profile state: each listener (each agent) has its own ([docs/CLI.md](../../docs/CLI.md#allowlist)).
- `--turns`: one `agent.turn` event per `message.received`, and per `group.message` that mentions this profile:
  `{seq, id: "agent.turn:<source id>", type, at, source, chat | group + member, messageId, timestamp, untrusted:
  {text, name, replyTo?: {id, snippet}, file?: {id, name, size, mime, voice}}}`. `seq` is the source's (cursors
  work), `id` stable per message. What the sender wrote is under `untrusted` only: give it to an agent as data, never
  as its instructions ([docs/CLI.md](../../docs/CLI.md#agent-turns)). Takes the place of `--type`.
- `--exec <cmd>` runs the command through the shell once per event, in order, with the event on stdin and
  `GHOSTLY_EVENT_TYPE`, `GHOSTLY_EVENT_ID`, `GHOSTLY_EVENT_SEQ` in its environment.
- `--webhook <url>` POSTs each event (JSON) to a local bridge: `127.0.0.1`, `localhost` or `[::1]` only.
- With no daemon running, `listen` becomes the daemon (socket included), so a hook can answer with `ghostly send`.

As the app's chat screen does, the side that joined a chat says `👋 <name> joined` once it first goes live, and the
side that invited answers once.

## The socket API

The daemon listens on a Unix socket in the profile's folder (`daemon.sock`, 0600; in `/tmp/ghostly-<hash>/`, a
folder of the user's alone, when the folder's path is too long for a socket). One JSON object per line each way:

```json
{"id":1,"method":"chat.send","params":{"chat":"alice","text":"hi","wait":"sent"}}
{"id":1,"result":{"chat":"f3gg…","messageId":"me_…","delivery":"sent"}}
{"id":2,"method":"events.subscribe","params":{"since":40}}
{"event":{"seq":41,"type":"message.received",…}}
```

Methods: `status`, `profile.get|set`, `settings.get|set`, `invite.create|join`, `chat.list|get|history|send|retry|
delete|details|rename|remove|transport|connect|disconnect|verify|wait|pay|request|payRequest|accept|edit|react|pin|forward|typing`,
`group.create|join|list|get|history|send|edit|react|leave|forget|accept|decline`, `wallet.list|create|remove|faucet|history|
receive|address|redeem`, `wallet.mint.add`, `lightning.default|rename`, `pay`, `payment.list|check|reclaim`,
`file.send|list|action|wait|save`, `group.invite|remove|admin|rotate|link|picture|hub`, `profile.picture|backup`,
`identity.providers|list|add|complete|cancel|remove|share|withdraw|contact|recheck`, `service.list|add|remove|enable|share|peer|open|close`,
`call.start|answer|hangup|list|get|flush|auto`,
`events.replay`, `events.subscribe`, `daemon.stop`, and `engine.call` with
`{"method":"<engine call>","params":{…},"confirmReal":false}` for anything else the app does. Parameters are the
commands' (see `src/api.ts`). Errors: `{"id":…,"error":{"code","message","details"?}}` with the codes above.

## Calls

A bot or an agent can take part in a voice call with the apps (calls/1, WISP 601): the CLI runs the call's media and
hands its audio to a program of yours, over a Unix socket per call. Speech-to-text, a model or text-to-speech are the
program's business, not Ghostly's. Audio only: a video call is answered as a voice call (the contact's camera is not
shown, and nothing is sent on its video lane). Calls need the daemon.

```sh
ghostly daemon --detach
ghostly call auto on --from alice          # or answer each one: ghostly call answer alice
ghostly listen --type call.                # call.incoming … call.connected {"audio":{"socket":…}}
node examples/call-echo.mjs greeting.wav   # a program that answers, greets, then echoes after 1 s
```

**The audio.** The socket is `<profile>/calls/<call>.sock` (0600), or `/tmp/ghostly-calls-<hash>/<call>.sock` (in a
folder of yours alone, 0700) when that path is too long; `call start`, `call answer`, `call list` and the
`call.connected` event name it. It carries raw PCM,
with no framing:

- s16le, mono, at the call's rate: 48000 by default, or 24000, 16000, 12000, 8000 with `--rate`. Opus runs at that
  rate itself, so nothing is resampled.
- From the call: the contact's audio in 20 ms frames (1920 bytes at 48 kHz, 640 at 16 kHz), as they are decoded.
- To the call: any amount, at any time. Writing faster than real time is fine: the CLI queues it (up to 5 minutes),
  sends a 20 ms frame per tick at real time, and silence when the queue is empty. A partial frame waits 60 ms for the
  rest of it, then plays padded.
- Barge-in: `ghostly call flush` (or `call.flush` on the socket API) drops everything queued, at once. Stop writing
  before you flush.
- The socket exists from `call start`/`call answer`, so the program may connect before the media is up. One program
  at a time: a new connection replaces the old one. When the call ends, the program reads EOF and the socket is
  removed.
- Added latency inside the CLI: at most one 20 ms frame going out; coming in, a frame as soon as its packet is
  decoded (up to 40 ms more when a packet is late; a lost one becomes 20 ms of silence).

**Events.** `call.incoming` `{call, chat, name, video, auto}`, `call.outgoing` `{call, chat, name, audio}`,
`call.connected` `{call, chat, direction, audio: {socket, rate, channels, format, frameMs}}`, and `call.ended`
`{call, chat, direction, reason, duration?}` with `reason`:

| `reason` | |
|---|---|
| `hangup` | This side hung up, or declined a call that rang |
| `remote-hangup` | The contact hung up a connected call |
| `missed` | An incoming call stopped ringing unanswered (the contact gave up, or its offer went stale after 120 s) |
| `rejected` | The contact declined this side's call |
| `unanswered` | This side's call rang 60 s with no answer |
| `failed` | The media did not connect within 30 s, or dropped |
| `stopped` | The daemon stopped (its calls are hung up first) |

**Rules**, as in the apps: one call per chat, several chats may each have one; a call needs the chat live (the call
buttons of the contact's app say why when not); an offer that is older than 120 s does not ring. `call auto` is
kept in the profile's `calls.json`. The media is libdatachannel (node-datachannel, as for chats) and libopus built to
WebAssembly (`opusscript`); `status` says `calls: false` and `call list` says why where they cannot run.
`GHOSTLY_CALL_BIND=127.0.0.1` binds the call's media to one address (the tests use loopback).

**When a call does not connect** (it stays `connecting`, then ends `failed`): the daemon's log has a line per call for
the candidates each side offered, every ICE state, and the pair it connected over; `call list` shows the ICE state
and the pair as `stats.ice`. The macOS app and Safari hide their addresses behind mDNS names (`<uuid>.local`) that
often resolve nowhere, so such a call connects only when the app's own checks reach the CLI. A VPN that is the
default route (seen with NordVPN on the same Mac as the CLI) makes the app send from the tunnel's address, which
nothing on that machine can answer: allow local network traffic in the VPN, or pause it.

**A TURN relay.** Calls use the apps' STUN servers, then the profile's own ICE servers:
`ghostly settings set iceServers '[{"urls":"turn:turn.example.org:3478","username":"…","credential":"…"}]'` (the
same setting chats use). A relay connects the calls no direct path can: a VPN that takes every packet through its
tunnel, a NAT that maps each destination apart. The media stays encrypted end to end; the relay sees both
addresses and when and how much is sent.

## Transports

The engine picks as the app does: WebRTC (libdatachannel), HyperDHT (native, in process), Iroh (the wasm build,
relay only, as in the web app), and the DHT floor through the Pkarr relays in the settings and the Mainline DHT
directly (every packet to both; reads from the DHT when every relay fails). Tests and private networks:
`GHOSTLY_DHT=0` leaves the Mainline DHT out, `GHOSTLY_DHT_BOOTSTRAP=host:port,…` replaces its bootstrap routers,
`GHOSTLY_HYPERDHT_BOOTSTRAP=host:port,…` replaces HyperDHT's bootstrap nodes, `settings set relays
'["http://…"]'` the Pkarr relays, `settings set irohRelays '["https://…"]'` the Iroh relays. `GHOSTLY_WEBRTC=0`
turns WebRTC off. A daemon offers to be a hub of the private groups past 16 members it is in, since it stays online;
`GHOSTLY_HUB=0` keeps it a plain member (the admin can still pin it).

## Not yet

- **Bark** wallets (see above), **OpenID Connect** proofs (a browser window), and video in calls
  (calls are voice only).
- **A single binary**: the CLI needs Node.
- Link previews made by the sender, and holding messages for an away contact.

## Tests

`npm test -w @ghostlytools/cli` builds the CLI and runs the unit tests and a two-bot end-to-end test on loopback (a Pkarr
relay in the test process and a HyperDHT testnet), a voice call between them included.
`e2e/web/headless-chat.spec.ts` puts a bot and the web app in one chat; `e2e/web/headless-call.spec.ts` has them
call each other, with a tone each way.
