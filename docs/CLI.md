# The Ghostly CLI

`ghostly` ([`@ghostlytools/cli`](../packages/cli), in `packages/cli`) is the Ghostly app's own engine without a screen. A
bot or a script gets the same chats as the web app, the extension and the Desktop: `ghostly1` invites, one chat that
starts on the DHT and goes live, typing (with a bot's status line), replies, edits, reactions and forwards, private and community groups, files and voice notes, wallets and payments,
identity proofs, shared web apps and voice calls. Every command prints JSON, and `ghostly listen` streams what happens
as one JSON event per line. `ghostly help <command>` (or `<command> --help`) prints a command's usage and options.

- Every command, event and socket method: [packages/cli/README.md](../packages/cli/README.md).
- The contract (runtime, local API, event stream, parity with the app): [WISP 11xx](wisps/11xx-headless.md).
- For AI agents: [packages/cli/SKILL.md](../packages/cli/SKILL.md), installed as in [AI-AGENTS.md](AI-AGENTS.md).

Status: available since 1.0. On npm as `@ghostlytools/cli`.

## Install

Node 22.12 or newer:

```bash
npm install -g @ghostlytools/cli
ghostly --version
```

Or from a clone of the repository:

```bash
npm install
npm run build -w @ghostlytools/cli
npm pack -w @ghostlytools/cli
npm install -g ./ghostlytools-cli-*.tgz
```

WebRTC comes from `node-datachannel`
(prebuilt for Linux, macOS and Windows). Without it the CLI still chats over HyperDHT, Iroh and the DHT, but groups
and voice calls need WebRTC and are unavailable.

Platforms: CI tests the CLI on Linux x64 and Linux arm64 (glibc; Graviton, Ampere, Hetzner ARM, a 64-bit Raspberry Pi
OS), including the package installed from its npm tarball on arm64. It is developed on macOS arm64. macOS x64 and
Windows x64 have the same prebuilt modules but no CI run.

## A first chat

```bash
ghostly profile set --name "Echo bot"     # the name contacts see
ghostly daemon --detach                   # keep the profile online
ghostly invite create --label alice       # {"chat","invite":"ghostly1…","link":"https://ghostly.tools/#ghostly1…"}
ghostly chat wait alice --until live      # once Alice opened the link in the app
ghostly send alice "hello"
ghostly listen                            # one JSON event per line
```

To join someone else's invite: `ghostly invite join <ghostly1… or link> --label bob`. The invite is the app's own, so
the other side can be the web app, the extension, the Desktop or another `ghostly`.

## Profiles

A profile is a folder, `~/.ghostly/profiles/<name>/` (0700, files 0600), with its own chats, keys and wallets.

| Command or option | What |
|---|---|
| `ghostly profile create <name> [--use]`, `profile list`, `profile use <name>` | Make, list and pick profiles |
| `--profile <name>` or `GHOSTLY_PROFILE` | Run one command on another profile |
| `--home <dir>` or `GHOSTLY_HOME` | Move the whole `~/.ghostly` folder |
| `profile set --name <name>`, `profile picture <jpeg>` | What contacts see |
| `profile backup --out <file>`, `profile restore <file> <name>` | An encrypted backup of the headless profile |

Only one process opens a profile at a time.

## The daemon and the socket API

`ghostly daemon --detach` keeps a profile online; `ghostly daemon status` and `ghostly daemon stop` check and end it,
and `ghostly daemon restart` starts it again on the CLI's own code (after an upgrade, commands warn on stderr that
the daemon runs another version). Ctrl-C, a service manager's stop, or the terminal or SSH session closing all stop
it cleanly: it tells contacts it is going and removes its socket.
While it runs, every command goes through its socket. With no daemon, a command runs the profile itself and leaves
(a one-shot), so the contact sees it come and go. Bots should run the daemon.

The daemon listens on a Unix socket, `daemon.sock` in the profile's folder, owner-only (0600), never on TCP. One JSON
object per line each way:

```json
{"id":1,"method":"chat.send","params":{"chat":"alice","text":"hi","wait":"sent"}}
{"id":1,"result":{"chat":"f3gg…","messageId":"me_…","delivery":"sent"}}
{"id":2,"method":"events.subscribe","params":{"since":40}}
{"event":{"seq":41,"type":"message.received",…}}
```

The methods mirror the commands (`chat.send`, `group.create`, `wallet.list`, `pay`, …), and `engine.call` reaches any
call of the app's engine. `ghostly engine --list` and `ghostly engine <method> '<json>'` do the same from the shell.

## Events and hooks

`ghostly listen` prints one event per line:

```json
{"seq":6,"id":"message.received:f3gg…:peer_jY7N…","type":"message.received","at":1790450767762,"chat":"f3gg…","message":{"id":"peer_jY7N…","from":"peer","text":"hello","timestamp":1790450767735}}
```

- `seq` grows by one per event in the profile, across restarts. `id` is stable for the fact it reports: dedupe on it.
- `--since <seq>` replays from the journal (the last 10,000 events); `--cursor <file>` remembers the last event
  handled, so a restarted bot resumes where it stopped.
- `--type message.received` keeps one type; `--type message.` a family.
- `--from <chat|key>` and `--group <group>` (each again for more) are an allowlist: only those chats' and groups'
  events get through. See [Allowlist](#allowlist).
- `--turns` gives one `agent.turn` event per message to answer. See [Agent turns](#agent-turns).
- `--exec '<command>'` runs a shell command once per event, in order, with the event on **stdin** (never in its
  arguments, so a contact's text cannot reach the shell).
- `--webhook <url>` POSTs each event to a local bridge (`127.0.0.1`, `localhost` or `[::1]` only).
- With no daemon running, `listen` becomes the daemon, so a hook can answer with `ghostly send`.

Main types: `message.received`, `message.sent`, `message.delivery`, `message.edited`, `chat.pairing`, `chat.connection`, `chat.joined`,
`typing.started` (with `kind` and `status`) and `typing.stopped` (`group.typing.started` and `group.typing.stopped` in a private group, with `member`), `message.reaction` and `group.reaction`, `group.message.edited`,
`group.message` and `group.sent` (with `messageId`, `member`, `nick` from the roster, and `mentioned`), `group.members`,
`file.offered`, `file.done` and `file.failed` (with the file's `messageId`), `payment.created`, `payment.updated`,
`identity.received`, `call.incoming`, `call.outgoing`, `call.connected`, `call.ended`. The full list is in the
[package README](../packages/cli/README.md#events).

### Allowlist

```bash
ghostly listen --from alice --from bob --group team --exec ./bot.sh
```

- `--from` takes a chat (id, prefix or name) or a contact's key (`peer` in `chat show`); a key also matches a chat
  made after `listen` started, and only ever the chat of that key (a contact's own name never stands for a key, and
  a chat's label wins over a contact's name). `--group` takes a group (id, prefix or name). Names are turned into ids once, at the
  start, so a contact who renames themselves later changes nothing. A name that matches nothing is an error (exit 3).
- With either flag, an event of any other chat or group never reaches `--exec`, `--webhook` or stdout. The message
  itself is kept in the chat as always, and the cursor moves past it. Events of the profile itself
  (`daemon.started`, `events.gap`, `identity.approval`) still pass.
- `--group` alone lets no 1:1 chat through, and `--from` alone no group.
- It is a flag, not profile state. Several listeners can run on one profile, each for its own agent with its own
  allowlist, and the allowlist is in plain sight in the command that wakes the agent. Nothing stored in the profile
  can quietly widen it. (`call auto on --from` is kept in the profile because the daemon itself answers the call.)
- `events.subscribe` on the socket gives every event: a program there keeps its own allowlist.

### Agent turns

`--turns` is the event shape for an agent (Claude Code, a bot on a model): each `message.received`, and each
`group.message` that mentions this profile, becomes one `agent.turn`. Nothing else is one (my own messages, edits,
reactions, typing).

```json
{"seq":41,"id":"agent.turn:message.received:f3gg…:peer_jY7N…","type":"agent.turn","at":1790450767762,
 "source":"message.received","chat":"f3gg…","messageId":"peer_jY7N…","timestamp":1790450767735,
 "untrusted":{"text":"hello","name":"Alice","replyTo":{"id":"me_…","snippet":"…"},"file":{"id":"…","name":"a.pdf","size":123,"mime":"application/pdf","voice":false}}}
```

- `chat` for a 1:1 chat, or `group` and `member` (the author's key) for a group. `messageId` is what
  `ghostly send <chat> --reply <messageId>` (or `group send <group> --reply`) takes to answer it.
- `seq` is the source event's, so `--since` and `--cursor` work as for any event. `id` is stable for the message:
  dedupe on it.
- **Untrusted data.** Everything the sender controls (the text, their name, a quoted snippet, a file's name) is under
  `untrusted` and nowhere else. Hand it to the agent as quoted data, never merged into its instructions: nothing a
  contact writes should change what the agent does, reveal a secret or move money. A prompt cannot promise that, so
  the model that answers turns should have no tools ([safe setup](AI-AGENTS.md#safe-setup)). Real payments keep
  `--confirm-real`, for the wallet's owner only.
- Combine it with the allowlist: `ghostly listen --turns --from alice --exec …`. `--turns` takes the place of `--type`.

## What it does

| Area | Commands |
|---|---|
| Invites and chats | `invite create\|join`, `chat list\|show\|history\|wait\|rename\|remove\|verify`, `send` (argument or `--stdin`; `--reply <message>` quotes one), `edit <chat> <message>` (a status updated in place), `message retry\|delete\|details`, `react <chat> <message> <emoji>` (`--remove` takes yours back), `forward <chat> <message>… --to <chat\|group>…` (up to 5; files from the bytes here), `typing <chat> [--kind typing\|recording\|thinking] [--status <text>] [--for s] [--stop]` |
| Transports | `chat transport <chat> auto\|dht\|webrtc\|iroh\|hyperdht`, `chat connect\|disconnect`, `chat disconnect <chat> --hold <minutes>` (off the direct link that long, on the DHT; `settings online false` is the whole profile); relays and ICE servers with `settings set` |
| Files and voice | `file send <chat> <path>`, `file send … --voice [ms]` (length and waveform measured from the file), `file send … --reply <message>` (quotes it), `file accept\|decline\|pause\|resume\|cancel\|resend\|request [<chat>] <file>` (a resent file goes on from what the receiver holds), `file wait <file>`, `file save <file> [--wait]`. Files over 25 MiB wait for `file accept`. `message.received` carries the file (`id`, and a voice note's `duration` and `peaks`); `file.*` events name its `messageId` |
| Groups | `group create <name>` (a community link) or `--mesh` (private), `group join`, `group send … --mention <member> --reply <message>` (answers with the message id), `group history` (each message names its author), `group react`, `group edit <group> <message>` (a status updated in place), `group typing <group>` (private groups: typing, recording, thinking or a status line), `--wait sent` on both (until an edge took it); admin: `group invite\|remove\|admin\|rotate\|link\|picture\|hub\|rename` (`group rename <group> <name…>` keeps the picture) |
| Wallets | `wallet create cashu\|lightning\|arkade\|spark\|bitcoin\|fedimint\|usdt` (`fedimint --invite <code>`; Spark on Mainnet with your Breez API key; `--stdin` takes secret fields as `name=value` lines, `api-key=…` too, out of `ps` and the shell's history), `wallet add-mint`, `wallet list`, `wallet faucet` (test coins), `wallet receive\|address\|redeem\|history` (`wallet redeem` with no token reads it from stdin), `wallet remove` (refused while it holds or awaits money), several `lightning` cards |
| Payments | `chat pay <chat> <sats>`, `chat request`, `chat pay-request`, `chat accept`, `pay <invoice\|address\|lnurl>`, `payment list\|check\|reclaim` |
| Identities | `identity providers\|list\|add\|complete\|cancel\|remove`, `identity share\|withdraw\|recheck <chat> <id>`, `identity contact <chat>` |
| Shared services | `service add <name> http://127.0.0.1:<port>`, `service share <service> <chat>`, `service peer\|open\|close` |
| Voice calls | `call start <chat>`, `call answer`, `call auto on [--from <chat>]`, `call hangup\|list\|flush`, `call pipe`: the audio as raw PCM on a Unix socket per call, for a program of yours |

Safety rules the CLI enforces:

- **Real money.** Wallets default to Testnet. A Mainnet spend needs `--network mainnet --confirm-real`; without the
  flag it exits with code 5. `pay` never guesses Mainnet from an invoice.
- **Secret guard.** `send` refuses text that looks like a recovery phrase, a private key or a Cashu token (exit 5)
  unless `--force`.
- **Secrets stay hidden.** Seeds, keys, wallet phrases, backups and group entry links are printed only with `--show-secret` (or `group link`, for a group's link).

Errors print `{"error":{"code","message"}}` and exit with 1 (failed), 2 (usage), 3 (not found), 4 (timed out) or
5 (needs `--force`, `--yes` or `--confirm-real`).

## Bots

An echo bot in one command ([examples/echo-bot.sh](../packages/cli/examples/echo-bot.sh)):

```bash
ghostly listen --type message.received --cursor ~/.ghostly/echo.cursor --exec '
  event="$(cat)"
  printf "echo: %s" "$(printf "%s" "$event" | jq -r .message.text)" | ghostly send "$(printf "%s" "$event" | jq -r .chat)" --stdin'
```

- The same bot on the socket, in Node without dependencies: [examples/echo-bot.mjs](../packages/cli/examples/echo-bot.mjs).
- A payment bot on Testnet ("request 21", "tip 5", "balance", and a thank-you when a request is paid):
  [examples/payment-bot.mjs](../packages/cli/examples/payment-bot.mjs). Before it:
  `ghostly wallet create cashu && ghostly wallet faucet cashu && ghostly daemon --detach`.
- A Claude Code agent: [examples/claude-code-agent.sh](../packages/cli/examples/claude-code-agent.sh) wakes
  `claude -p` on each turn from an allowlist (`GHOSTLY_AGENT_FROM`, `GHOSTLY_AGENT_GROUPS`; it will not start
  without one), shows "thinking" while it works, and sends its answer with `send --reply`. Each turn runs with no
  tools, no MCP servers and none of your Claude Code settings, so a contact's text can shape an answer but cannot
  read a file or run a command. A group gets one conversation per member ([safe setup](AI-AGENTS.md#safe-setup)).
- A task card: `ghostly task send <chat|group> --title "…" --steps 1/4`, then `ghostly task update <chat|group> <task>
  --steps 2/4 --step "…"` as the work goes, and `--status done` at the end. People see a small card with a progress
  bar and the pull request's size, which opens on a tap; apps without cards read a short text. Updates merge, at
  most one per card every 2.5 s ([WISP 4xx · Status Cards](wisps/4xx-status-cards.md)). A routine the same way:
  `ghostly routine send <chat|group> --name "…" --schedule "every day 01:00" --next <date>`, then
  `ghostly routine update <chat|group> <routine> --run ok` after each run.
- A voice bot: [examples/call-echo.mjs](../packages/cli/examples/call-echo.mjs) answers every call, plays a WAV
  greeting (speaking over it stops it), then echoes the caller a second later.

## Voice calls

A bot or an agent can join a voice call with the apps. The CLI runs the call (WebRTC with Opus, as the apps) and
hands its audio to your program; speech-to-text, a model or text-to-speech are your program's, not Ghostly's.

```bash
ghostly daemon --detach
ghostly call auto on --from alice        # or: ghostly call answer alice, on each call.incoming event
ghostly listen --type call.              # call.connected carries {"audio":{"socket":…,"rate":48000,…}}
```

The audio contract, one Unix socket per call:

- **Format.** Raw PCM, no framing: s16le, mono, at the call's rate (48000 by default; 24000, 16000, 12000 or 8000
  with `--rate`).
- **From the call.** The contact's voice in 20 ms frames, as they are decoded.
- **To the call.** Write any amount, at any pace: the CLI plays it at real time, and silence when there is nothing.
- **Barge-in.** `ghostly call flush` drops what is queued, at once.
- **End.** The program reads EOF when the call ends; `call.ended` says why (`hangup`, `remote-hangup`, `missed`,
  `rejected`, `unanswered`, `crossed`, `failed`, `stopped`).
- **Shell pipelines.** `ghostly call pipe` puts a call's audio on stdin and stdout, for sox or ffmpeg.

**When a call does not connect** (it stays `connecting`, then ends `failed`): the daemon's log lists the candidates
each side offered and every ICE state, and `call list` shows `stats.ice` (the state and the pair). A VPN that is the
default route on the app's machine is the usual cause on one Mac.

Voice only: a video call is answered as a voice call. The details are in the
[package README](../packages/cli/README.md#calls).

## Pkarr: relays and the Mainline DHT

The CLI publishes every Pkarr packet to the relays in its settings and to the Mainline DHT (BEP 44, over UDP, as the
Desktop does), and reads the relays first, the DHT when every relay fails. So a bot keeps finding its contacts, and its
group's edges come up, while the relays answer errors. `GHOSTLY_DHT=0` leaves the DHT out (relays only, as the web app);
`GHOSTLY_DHT_BOOTSTRAP=host:port,…` replaces the public bootstrap routers (a private testnet). The daemon is then a DHT node like any
other: it answers other nodes' queries and keeps the small values they store for a while, as the Desktop's Pkarr client
does.

## Hubs of large private groups

A daemon stays online, so in a private group past 16 members it offers to be a hub, as the Desktop app does: the
members connect to it and it passes the group's messages on ([WISP 9xx · Group Mesh § Hubs](wisps/9xx-group-mesh.md#hubs)).
`GHOSTLY_HUB=0` keeps a daemon a plain member (on a laptop that sleeps, say). The admin decides over both with
`ghostly group hub <group> <member> --pin | --exclude | --auto`.

## Not there yet

- **Bark wallets.** Bark's SDK runs only in a browser. `wallet list` shows it as unavailable.
- **A single binary.** The CLI needs Node; there is no standalone executable yet.
- Also open: link previews made by the sender, and holding messages for an away contact. OpenID Connect proofs
  need a browser: make them in the app. Calls are voice only (no video).
- **A connector for agent frameworks.** Partly built: `listen --turns` with `--from` and `--group` wakes an agent
  (Claude Code has an example); the Hermes Agent plugin is open ([AI-AGENTS.md](AI-AGENTS.md#ghostly-as-a-channel-for-agents)).

## The older `ghostly-cli` (removed)

`ghostly-cli`, a Rust client, came first. It spoke only the v0.4 record format ([WISP 402](wisps/402-legacy-chat.md))
with its own `ghost://` invites and could not pair with the app. The release stopped shipping it at 1.0, and its source
was removed after 1.0; it stays in the git history. `ghostly` (`packages/cli`) is the CLI: bots on `ghostly-cli` move
to it.
