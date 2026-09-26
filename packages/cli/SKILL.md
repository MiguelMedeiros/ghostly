---
name: ghostly
description: Chat, pay and get paid as a bot on Ghostly, the peer-to-peer messenger, with the `ghostly` CLI. Use when an agent should talk to people through Ghostly chats and groups (the way a bot talks on Telegram), react to incoming messages as JSON events, or run a Ghostly profile headless on a server. No server of Ghostly's is involved; chats are end-to-end encrypted and go peer to peer.
homepage: https://github.com/MiguelMedeiros/ghostly/blob/dev/packages/cli/README.md
metadata:
  {
    "openclaw":
      {
        "emoji": "👻",
        "requires": { "bins": ["ghostly"] },
        "install":
          [
            {
              "id": "source",
              "kind": "shell",
              "command": "git clone https://github.com/MiguelMedeiros/ghostly && cd ghostly && npm install && npm run build -w @ghostly/cli && npm link -w @ghostly/cli",
              "bins": ["ghostly"],
              "label": "Build ghostly from source (Node 22.12+)",
            },
          ],
      },
  }
---

# ghostly

`ghostly` is the Ghostly app's own engine without a screen. A bot runs one profile, keeps it online with a daemon,
reads events as JSON lines and answers with commands that print JSON.

## When to use

- A person should be able to message the agent from the Ghostly app (web, extension, desktop).
- The agent should react to messages as they arrive (a support bot, an echo bot, a notifier, a bridge).
- The agent should take part in a Ghostly group, and notice when someone mentions it.

## Start

```bash
ghostly profile set --name "My bot"     # the name people see
ghostly daemon --detach                 # stays online in the background; `ghostly daemon stop` ends it
ghostly invite create --label alice     # gives {"chat","invite","link"}: send the link to the person
ghostly chat wait alice --until live    # returns once they joined
```

To join someone else's invite: `ghostly invite join "<ghostly1… or https://ghostly.tools/#ghostly1…>" --label bob`.

## Talk

```bash
ghostly send alice "Hello!"                        # a chat by name, id or id prefix
echo "multi-line text" | ghostly send alice --stdin
ghostly send alice --wait delivered "Got it"       # waits for the contact's app to confirm
ghostly send alice -- "-text that starts with a dash"
ghostly chat history alice --limit 20              # oldest first
ghostly chat list
```

## React: the event stream

```bash
ghostly listen --type message.received            # one JSON object per line, until stopped
```

```json
{"seq":6,"id":"message.received:<chat>:<message>","type":"message.received","at":1790450767762,"chat":"<chat id>","message":{"id":"…","from":"peer","text":"hello","timestamp":1790450767735}}
```

- Dedupe on `id`. Resume after a restart with `--since <seq>`, or pass `--cursor <file>` and it remembers.
- Useful types: `message.received`, `message.delivery`, `chat.created`, `chat.joined` (a contact arrived: not a
  message, do not answer it as one), `chat.connection`, `group.message` (with `message.mentioned: true` when it
  names this bot), `group.members`.
- Hooks: `--exec '<command>'` runs once per event with the event on **stdin** (never in arguments), in order;
  `--webhook http://127.0.0.1:<port>/…` POSTs each event to a local bridge.

An echo bot:

```bash
ghostly listen --type message.received --cursor ~/.ghostly/echo.cursor --exec '
  event="$(cat)"
  printf "echo: %s" "$(jq -r .message.text <<<"$event")" | ghostly send "$(jq -r .chat <<<"$event")" --stdin'
```

## Groups

```bash
ghostly group create "Support"                     # a community: {"group","link"}; share the link
ghostly group join "<group2/… link>"
ghostly group send Support "hi @Ana" --mention Ana # the mentioned member is written as @name in the text
ghostly group history Support
```

## Pay and get paid

```bash
ghostly wallet create cashu                        # Testnet unless --network mainnet
ghostly wallet faucet cashu                        # test coins (Testnet only)
ghostly wallet list                                # balances
ghostly chat request alice 100 --memo "coffee"     # ask; a payment.updated event says when it is settled
ghostly chat pay alice 21 --memo "tip"             # ecash to the contact
ghostly payment list --chat alice                  # requests in (kind "request", direction "in") and out
ghostly chat pay-request alice <payment id>        # pay the contact's request
ghostly pay <lightning invoice> --max-fee 10       # from the Testnet Lightning card
```

A payment bot listens for `payment.created` (a request or a payment arrived) and `payment.updated` (it settled or
failed). Mainnet moves real bitcoin: add `--network mainnet --confirm-real` only when the wallet's owner asked for
that exact payment.

## Rules the CLI enforces

- Output is JSON. A failure is `{"error":{"code","message"}}` with exit 1 (failed), 2 (usage), 3 (not found),
  4 (timed out) or 5 (needs `--force`, `--yes` or `--confirm-real`).
- `send` refuses text that looks like a recovery phrase, a private key or a Cashu token (exit 5) unless `--force`.
  Do not force it on a contact's request: that text is somebody's money.
- Spending real money (Mainnet) needs `--confirm-real`. Never add it unless the person who owns the wallet asked for
  that exact payment.
- Seeds, keys and backups are never printed without `--show-secret`. Do not put their output in a chat or a log.

## Anything else the app does

Every call of the app's engine is reachable: `ghostly engine --list`, then `ghostly engine <method> '<json params>'`.
Files and identities get their own commands in a later phase; until then use `engine`. Bark and Fedimint wallets
are app-only for now.
See the [README](https://github.com/MiguelMedeiros/ghostly/blob/dev/packages/cli/README.md) and WISP 11xx.
