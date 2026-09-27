# The Ghostly CLI

`ghostly` ([`@ghostly/cli`](../packages/cli), in `packages/cli`) is the Ghostly app's own engine without a screen. A
bot or a script gets the same chats as the web app, the extension and the Desktop: `ghostly1` invites, one chat that
starts on the DHT and goes live, groups, files, wallets and payments, identity proofs and shared web apps. Every
command prints JSON, and `ghostly listen` streams what happens as one JSON event per line.

- Every command, event and socket method: [packages/cli/README.md](../packages/cli/README.md).
- The contract (runtime, local API, event stream, parity with the app): [WISP 11xx](wisps/11xx-headless.md).
- For AI agents: [packages/cli/SKILL.md](../packages/cli/SKILL.md), installed as in [AI-AGENTS.md](AI-AGENTS.md).

Status: available on `dev` and built from source. The npm package is ready but not published yet.

## Install

Node 22.12 or newer. From a clone of the repository:

```bash
npm install
npm run build -w @ghostly/cli
npm pack -w @ghostly/cli
npm install -g ./ghostly-cli-*.tgz
ghostly --version
```

Once the package is published, `npm install -g @ghostly/cli` does the same. WebRTC comes from `node-datachannel`
(prebuilt for Linux, macOS and Windows). Without it the CLI still chats over HyperDHT, Iroh and the DHT, but groups
need WebRTC and are unavailable.

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

`ghostly daemon --detach` keeps a profile online; `ghostly daemon status` and `ghostly daemon stop` check and end it.
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
- `--exec '<command>'` runs a shell command once per event, in order, with the event on **stdin** (never in its
  arguments, so a contact's text cannot reach the shell).
- `--webhook <url>` POSTs each event to a local bridge (`127.0.0.1`, `localhost` or `[::1]` only).
- With no daemon running, `listen` becomes the daemon, so a hook can answer with `ghostly send`.

Main types: `message.received`, `message.delivery`, `chat.pairing`, `chat.connection`, `chat.joined`,
`typing.started` and `typing.stopped`,
`group.message` (with `mentioned`), `group.members`, `file.offered`, `file.done`, `payment.created`,
`payment.updated`, `identity.received`, `call.offer`. The full list is in the
[package README](../packages/cli/README.md#events).

## What it does

| Area | Commands |
|---|---|
| Invites and chats | `invite create\|join`, `chat list\|show\|history\|wait\|rename\|remove\|verify`, `send` (argument or `--stdin`; `--reply <message>` quotes one), `message retry\|delete\|details` |
| Transports | `chat transport <chat> auto\|dht\|webrtc\|iroh\|hyperdht`, `chat connect\|disconnect`; relays and ICE servers with `settings set` |
| Files and voice | `file send <chat> <path>`, `file send … --voice <ms>`, `file accept\|decline\|pause\|resume\|cancel`, `file save`. Files over 25 MiB wait for `file accept` |
| Groups | `group create <name>` (a community link) or `--mesh` (private), `group join`, `group send … --mention <member> --reply <message>`, `group history`; admin: `group invite\|remove\|admin\|rotate\|link\|picture` |
| Wallets | `wallet create cashu\|lightning\|arkade\|spark\|bitcoin\|usdt`, `wallet list`, `wallet faucet` (test coins), `wallet receive\|address\|redeem\|history`, `wallet remove` (refused while it holds or awaits money), several `lightning` cards |
| Payments | `chat pay <chat> <sats>`, `chat request`, `chat pay-request`, `chat accept`, `pay <invoice\|address\|lnurl>`, `payment list\|check\|reclaim` |
| Identities | `identity providers\|list\|add\|complete`, `identity share\|withdraw <chat> <id>`, `identity contact <chat>` |
| Shared services | `service add <name> http://127.0.0.1:<port>`, `service share <service> <chat>`, `service peer\|open\|close` |

Safety rules the CLI enforces:

- **Real money.** Wallets default to Testnet. A Mainnet spend needs `--network mainnet --confirm-real`; without the
  flag it exits with code 5. `pay` never guesses Mainnet from an invoice.
- **Secret guard.** `send` refuses text that looks like a recovery phrase, a private key or a Cashu token (exit 5)
  unless `--force`.
- **Secrets stay hidden.** Seeds, keys, wallet phrases and backups are printed only with `--show-secret`.

Errors print `{"error":{"code","message"}}` and exit with 1 (failed), 2 (usage), 3 (not found), 4 (timed out) or
5 (needs `--force`, `--yes` or `--confirm-real`).

## Bots

An echo bot in one command ([examples/echo-bot.sh](../packages/cli/examples/echo-bot.sh)):

```bash
ghostly listen --type message.received --cursor ~/.ghostly/echo.cursor --exec '
  event="$(cat)"
  printf "echo: %s" "$(jq -r .message.text <<<"$event")" | ghostly send "$(jq -r .chat <<<"$event")" --stdin'
```

- The same bot on the socket, in Node without dependencies: [examples/echo-bot.mjs](../packages/cli/examples/echo-bot.mjs).
- A payment bot on Testnet ("request 21", "tip 5", "balance", and a thank-you when a request is paid):
  [examples/payment-bot.mjs](../packages/cli/examples/payment-bot.mjs). Before it:
  `ghostly wallet create cashu && ghostly wallet faucet cashu && ghostly daemon --detach`.

## Not there yet

- **DHT-direct.** The Desktop reads the Mainline DHT itself; the CLI reaches the DHT through Pkarr relays, as the
  web app does. It needs a BEP 44 client on Node.
- **Bark and Fedimint wallets.** Their SDKs run only in a browser. `wallet list` shows them as unavailable.
- **A single binary.** The CLI needs Node; there is no standalone executable yet.
- **An npm release.** Install from source until the package is published.
- Also open: link previews made by the sender, and holding messages for an away contact. OpenID Connect proofs
  need a browser: make them in the app. Calls are app-only (a bot gets `call.offer` events only).

## The older `ghostly-cli`

`ghostly-cli` (Rust, in [`cli/`](../cli)) came first. It is now the **compatibility client**: it speaks only the
v0.4 record format ([WISP 402](wisps/402-legacy-chat.md)) with its own `ghost://` invites, and it cannot pair with the
app. An app invite (`ghostly1…`) is refused with a message saying to open it in the Ghostly app. It stays, unchanged,
for the bots already built on it, and the release still ships its binaries. Removing it is a separate decision, to be
announced first. New bots use `ghostly`. Its commands: [cli/README.md](../cli/README.md).
