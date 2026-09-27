# ghostly: Ghostly for bots and terminals

`ghostly` runs **the Ghostly app's own engine** without a screen: the same chats, groups and protocol as the web app,
the extension and the Desktop, on Node. A bot keeps a profile online with `ghostly daemon`, reads what happens with
`ghostly listen` (JSON lines), and acts with the other commands (JSON answers). The contract behind it, and why it
is built this way, is [WISP 11xx](../../docs/wisps/11xx-headless.md). A guided tour: [docs/CLI.md](../../docs/CLI.md).

> Status: phases 1 to 4 (profiles, pictures and backups, invites, one chat, groups with their admin tools, the
> event stream and hooks, wallets and payments, files and voice notes, identity proofs, shared web apps; an npm
> package, not yet published); every engine call is already
> reachable through `ghostly engine <method>`. The older Rust `ghostly-cli` (the `cli/` folder) stays as the
> compatibility client for v0.4 chats.

## Install

The package is ready for npm but not published (that is the maintainer's; `"private": true` in package.json keeps it
from going out by accident). From this repository:

```bash
npm install
npm run build -w @ghostly/cli
npm pack -w @ghostly/cli              # ghostly-cli-<version>.tgz: the bundle, its WebAssembly, README and SKILL.md
npm install -g ./ghostly-cli-*.tgz    # the `ghostly` command, with its dependencies from npm
ghostly --version
```

Once published: `npm install -g @ghostly/cli`. Node 22.12 or newer. WebRTC comes from `node-datachannel` (a native
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

| Command | What it does |
|---|---|
| `status` | The profile, its chats, whether WebRTC and calls run, the last event seq |
| `profile create <name> [--use] [--name <shown>]`, `profile list`, `profile use <name>` | Profiles |
| `profile show`, `profile set [--name <name>] [--share-profile \| --no-share-profile]` | The name contacts see |
| `daemon [--detach]`, `daemon status`, `daemon stop`, `daemon restart` | Keep the profile online; `restart` stops it and starts this release's code in the background ([After an upgrade](#after-an-upgrade)) |
| `invite create [--label <name>]` | A new chat's `ghostly1…` invite and its link |
| `invite join <invite-or-link> [--label <name>]` | Join a chat (your own invite is refused) |
| `chat list`, `chat show <chat>` | Chats, and one chat's connection: transports, last attempt, comparison code |
| `chat history <chat> [--limit n] [--before x] [--after x]` | Messages, oldest first; `x` is a message id or a time in ms |
| `send <chat> [text…] [--reply <message>] [--stdin] [--force] [--wait none\|sent\|delivered] [--timeout s]` | Send text (arguments, or stdin); `--reply` quotes a message of the chat |
| `typing <chat> [--for s] [--stop]` | Show the contact you are writing: live chats only, it holds 6 s there; `--for s` keeps it on that long (up to 600 s; a one-shot stays that long); a message to the chat or `--stop` ends it |
| `chat wait <chat> [--until live\|text\|paired] [--timeout s]` | Wait for a chat to go live, carry text, or see its contact |
| `chat transport <chat> <auto\|dht\|webrtc\|iroh\|hyperdht>` | What carries the chat |
| `chat connect <chat>`, `chat disconnect <chat> [--hold <minutes>]` | Reconnect now (ends a hold); close the live session, or with `--hold` stay off the direct link that long ([Staying off the direct link](#staying-off-the-direct-link)) |
| `chat rename <chat> <name>`, `chat remove <chat> --yes` | Name it here; delete it (keys and history) here |
| `chat verify <chat> --code <code>` | Mark the contact verified after comparing the codes out of band |
| `message retry\|delete\|details <chat> <message>` | One message |
| `group create <name> [--mesh]`, `group join <link>` | A community (a link anyone can open), or a private mesh |
| `group list`, `group show <group>`, `group history <group>` | Groups, members, history |
| `group send <group> [text…] [--mention <member>]… [--reply <message>]` | Send; each mentioned member is written as `@name` in the text |
| `group leave <group>`, `group forget <group> --yes`, `group accept\|decline <group>` | Membership |
| `listen [--since seq] [--cursor file] [--type t]… [--exec cmd] [--webhook url] [--print]` | The event stream |
| `events [--since seq]` | What the event journal holds, without following |
| `profile picture <jpeg> \| --clear` | The picture contacts see (a JPEG within 512 px; 128 px is what the app sends) |
| `group invite <group> <chat>`, `group remove <group> <member>`, `group admin <group> <member>` | Membership, for the admin |
| `group rotate <group>`, `group link <group> [--off] [--reset]`, `group picture <group> <jpeg> \| --clear` | A fresh secret; the link; the picture |
| `file send <chat> <path> [--name n] [--mime t] [--voice [ms] [--peaks …]]` | A file, or a voice note (its length and waveform measured from the file unless given) |
| `file list <chat>`, `file accept\|decline\|pause\|resume\|cancel [<chat>] <file>` | Transfers; a file over 25 MiB waits for `file accept` (files/3). A file's id names its chat, so `<chat>` may be left out |
| `file resend [<chat>] <file>`, `file request [<chat>] <file>` | A file that stopped moving: sent again from here, or asked for again from the contact; either goes on from the bytes the receiver holds (files/3) |
| `file wait [<chat>] <file> [--timeout s]` | Wait until a transfer ends: exit `0` when the file is all here, `1` with the transfer's error when it failed (`details.retry`: `file resend` can go on), `4` on timeout (default 300 s) |
| `file save [<chat>] <file> [--dir d \| --path p] [--force] [--wait [--timeout s]]` | Write a received file to disk (never over one without `--force`; an unfinished one says how many bytes are here; `--wait` waits for it first) |
| `profile backup --out <file>`, `profile restore <file> <new profile>` | An encrypted backup (WISP 05 envelope); the passphrase from `--passphrase-file` or `GHOSTLY_BACKUP_PASSPHRASE` |
| `identity providers`, `identity list` | Kinds of proof and their signers; this profile's proofs |
| `identity add <provider> [subject] [--signer id] [--field name=value]… [--days n]` | A proof: an in-app signer (NIP-46 and the like) finishes here; a tool or a published record answers with the statement |
| `identity complete <draft> [--evidence-file f \| --stdin]` | Finish it with the tool's output (or nothing, for a published record); needs the daemon that began it |
| `identity share\|withdraw <chat> <id>`, `identity contact <chat>`, `identity recheck <chat> <id>`, `identity remove <id>` | Show a proof to a contact; what a contact showed, as checked here |
| `service add <name> <http://127.0.0.1:port>`, `service share <service> <chat> [--off]`, `service list`, `service remove\|enable` | Share a web app on this machine, per contact |
| `service peer <chat>`, `service open <chat> <service> [--port p]`, `service close <chat> <service>` | A contact's app on a loopback port here (daemon) |
| `wallet list [--network n]` | Wallets and balances, and what `wallet create` can make on each network |
| `wallet create <type> [--network testnet] [--provider id] [--value name=value]… [--api-key key]` | A wallet: `cashu`, `lightning` (a card: its source's form in `--value`), `arkade`, `spark` (on Mainnet, `--api-key` is your Breez API key), `bitcoin` (BDK), `usdt` |
| `wallet remove <type> [--network n] [--card id] [--accept-loss]` | Refused while it holds money or waits for some, unless `--accept-loss` |
| `wallet faucet <type>`, `wallet add-mint <url> [--primary]` | Test coins; another Cashu mint |
| `wallet receive <sats>`, `wallet address <type>`, `wallet redeem <token>`, `wallet history` | Receive, and what came and went |
| `lightning default <card>`, `lightning rename <card> <name>` | Lightning cards: which receives by default |
| `pay <invoice\|address\|lnurl> [--amount sats] [--network n] [--max-fee sats] [--confirm-real]` | Pay over Lightning (Testnet unless `--network mainnet`) |
| `chat pay <chat> <sats> [--memo t] [--network n] [--confirm-real]` | Ecash to a contact |
| `chat request <chat> <sats> [--memo t] [--method m] [--rail r]`, `chat pay-request <chat> <payment>` | Ask a contact to pay; pay the contact's request |
| `chat accept <chat> <method> [--off] [--networks mainnet,testnet]` | Which ways of paying the chat takes |
| `payment list [--chat c]`, `payment check <chat> <payment>`, `payment reclaim <payment>` | Payments and requests |
| `call start <chat> [--rate 48000]`, `call answer [<chat\|call>] [--rate n]` | Voice calls (daemon): the result names the call's audio socket ([Calls](#calls)) |
| `call hangup [<chat\|call>]`, `call list`, `call flush [<chat\|call>]` | Hang up (or decline); calls on now; drop the audio queued and not played yet |
| `call auto [on\|off] [--from <chat>]… [--rate n]` | Answer calls by themselves, from anyone or the chats named (kept in the profile) |
| `call pipe [<chat\|call>]` | A call's audio on stdin and stdout, for shell pipelines (sox, ffmpeg) |
| `settings get [--show-secret]`, `settings set <key> <json>` | Relays, Iroh relays, the HyperDHT relay, ICE servers, `sendTyping` (false: contacts are never told you type), … |
| `engine <method> [json \| -] [--confirm-real] [--show-secret]`, `engine --list` | Any call of the app's engine |

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

Cashu (and Lightning through the mints), Lightning cards (NWC, LND, Core Lightning, Breez, LNURL), Arkade, Spark,
BDK and USDT run as in the app. Two do not yet: **Bark** (its SDK ships a browser build only) and **Fedimint** (its
client needs the origin-private file system and a module worker); `wallet list` offers them as unavailable, with
the reason. No wallet is made by itself: a bot has exactly the wallets it created. A Cashu test mint's invoice (from
`wallet receive`) is credited once its payer vouches for it in a chat, as in the app (a test mint says every invoice
is paid); on a real mint, the mint's answer decides.

### Secrets

Nothing prints a seed, a key, a wallet phrase or ecash unless asked with `--show-secret`: `settings get` masks
credentials, and engine calls that answer with secrets (`exportLinks`, `walletExport`, the wallets' backups) are
refused without it.

## Events

`ghostly listen` prints one event per line:

```json
{"seq":6,"id":"message.received:f3gg…:peer_jY7N…","type":"message.received","at":1790450767762,"chat":"f3gg…","message":{"id":"peer_jY7N…","chat":"f3gg…","from":"peer","text":"hello bob","timestamp":1790450767735,"delivery":null,"deliveryError":null,"via":"datalink","nick":null}}
```

- `seq` grows by one per event in the profile, across restarts; `id` is the same whenever the same fact is reported.
  Dedupe by `id`; resume with `--since <seq>`, or let `--cursor <file>` remember the last event handled.
- Types: `daemon.started`, `chat.created`, `chat.removed`, `chat.renamed`, `chat.pairing` (`stage`: publishing,
  waiting, resolving, on-dht, live, …), `chat.connection` (`live`, `transport`), `typing.started` and `typing.stopped` (the contact is writing, or stopped: a message, a stop, or 6 s of silence), `chat.joined` (the contact's app
  announced itself; not a message), `chat.announced`, `message.received`, `message.sent`, `message.delivery`
  (`delivery`: sending, queued, waiting, held, sent, delivered, failed), `message.deleted`, `group.created`,
  `group.status`, `group.members` (`joined`, `left`), `group.message` (`message.mentioned` when it names this
  profile), `group.sent`, `group.event`, `file.offered` (a file over 25 MiB waits for `file accept`),
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
- `--type message.received` keeps one type; `--type message.` (or `message.*`) a family.
- `--exec <cmd>` runs the command through the shell once per event, in order, with the event on stdin and
  `GHOSTLY_EVENT_TYPE`, `GHOSTLY_EVENT_ID`, `GHOSTLY_EVENT_SEQ` in its environment.
- `--webhook <url>` POSTs each event (JSON) to a local bridge: `127.0.0.1`, `localhost` or `[::1]` only.
- With no daemon running, `listen` becomes the daemon (socket included), so a hook can answer with `ghostly send`.

As the app's chat screen does, the side that joined a chat says `👋 <name> joined` once it first goes live, and the
side that invited answers once.

## The socket API

The daemon listens on a Unix socket in the profile's folder (`daemon.sock`, 0600; in `/tmp` under a hashed name
when the folder's path is too long for a socket). One JSON object per line each way:

```json
{"id":1,"method":"chat.send","params":{"chat":"alice","text":"hi","wait":"sent"}}
{"id":1,"result":{"chat":"f3gg…","messageId":"me_…","delivery":"sent"}}
{"id":2,"method":"events.subscribe","params":{"since":40}}
{"event":{"seq":41,"type":"message.received",…}}
```

Methods: `status`, `profile.get|set`, `settings.get|set`, `invite.create|join`, `chat.list|get|history|send|retry|
delete|details|rename|remove|transport|connect|disconnect|verify|wait|pay|request|payRequest|accept`,
`group.create|join|list|get|history|send|leave|forget|accept|decline`, `wallet.list|create|remove|faucet|history|
receive|address|redeem`, `wallet.mint.add`, `lightning.default|rename`, `pay`, `payment.list|check|reclaim`,
`file.send|list|action|wait|save`, `group.invite|remove|admin|rotate|link|picture`, `profile.picture|backup`,
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

## Transports

The engine picks as the app does: WebRTC (libdatachannel), HyperDHT (native, in process), Iroh (the wasm build,
relay only, as in the web app), and the DHT floor through the Pkarr relays in the settings. Tests and private
networks: `GHOSTLY_HYPERDHT_BOOTSTRAP=host:port,…` replaces HyperDHT's bootstrap nodes, `settings set relays
'["http://…"]'` the Pkarr relays, `settings set irohRelays '["https://…"]'` the Iroh relays. `GHOSTLY_WEBRTC=0`
turns WebRTC off.

## Not yet

- **DHT-direct**: the DHT floor goes through the Pkarr relays, as in the web app; reading the Mainline DHT directly,
  as the Desktop does, needs a BEP 44 client on Node.
- **Bark and Fedimint** wallets (see above), **OpenID Connect** proofs (a browser window), and video in calls
  (calls are voice only).
- **A single binary**: the CLI needs Node.
- Link previews made by the sender, and holding messages for an away contact.

## Tests

`npm test -w @ghostly/cli` builds the CLI and runs the unit tests and a two-bot end-to-end test on loopback (a Pkarr
relay in the test process and a HyperDHT testnet), a voice call between them included.
`e2e/web/headless-chat.spec.ts` puts a bot and the web app in one chat; `e2e/web/headless-call.spec.ts` has them
call each other, with a tone each way.
