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
              "id": "npm",
              "kind": "node",
              "package": "@ghostly/cli",
              "bins": ["ghostly"],
              "label": "Install ghostly (npm, once published)",
            },
            {
              "id": "source",
              "kind": "shell",
              "command": "git clone https://github.com/MiguelMedeiros/ghostly && cd ghostly && npm install && npm run build -w @ghostly/cli && npm pack -w @ghostly/cli && npm install -g ./ghostly-cli-*.tgz",
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
ghostly daemon restart                  # after upgrading the CLI: the daemon runs the new code (commands warn on stderr until then)
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
ghostly typing alice --for 30                      # "typing…" on the contact's screen while you compose, up to 30 s
ghostly typing alice --kind thinking --status "Transcribing your audio…" --for 60   # a bot at work; 40 chars, no links
ghostly typing alice --stop                        # or just send: the message ends it
ghostly send alice --reply peer_jY7N… "Yes, that one"  # quotes a message of the chat (its id from history or an event)
ghostly react alice peer_jY7N… 👍                   # one reaction per message: a new one replaces it
ghostly react alice peer_jY7N… --remove            # takes it back
id=$(ghostly send alice "Working: 0 of 3" | jq -r .messageId)   # a status message…
ghostly edit alice "$id" --text "Working: 2 of 3"  # …updated in place: the contact sees one message, marked edited
echo "Done: 3 of 3" | ghostly edit alice "$id" --stdin
gid=$(ghostly group send crew "Deploy: 0 of 3" --wait sent | jq -r .messageId)  # the same in a group…
ghostly group edit crew "$gid" --text "Deploy: done" --wait sent  # …every member sees one message, marked edited
# A group has no receipts: --wait sent returns once a member's edge (or a hub's) took it; exit 4 on --timeout
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
- A reply carries `message.replyTo`: `{id, snippet, from, found}` (`from`: me, peer or null). Answer in the same
  thread with `ghostly send <chat> --reply "$(jq -r .message.id <<<"$event")" "…"`.
- An edited message (the contact's or mine) comes as `message.edited`, once per edit, with `edits` (how many) and
  `message.text` as it is now (in a group: `group.message.edited`, with `group`); `chat history` shows the latest text with `edits` and `editedAt`.
- Useful types: `message.received`, `message.delivery`, `chat.created`, `chat.joined` (a contact arrived: not a
  message, do not answer it as one), `chat.connection`, `group.message` (with `message.mentioned: true` when it
  names this bot), `group.members`, `typing.started` / `typing.stopped` (the contact is writing, or stopped; a start has `kind`: typing, recording or thinking),
  `message.reaction` / `group.reaction` (`by`, `emoji`, "" when taken back; `mine` when it is on your message).
- Files: `message.received` carries `message.file` (`id`, `name`, `size`, `mime`, and for a voice note `voice`:
  `{duration, peaks}`); `file.done` and `file.failed` carry `file`, `chat` and `messageId`.
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
                                                   # {"group","messageId","sent"}: keep messageId to reply or react later
ghostly group send Support --reply <message id> "on it"  # a reply in the group
ghostly group history Support                      # each message: member (key) and nick (name, from the roster)
ghostly group show Support                         # link is "<hidden>": it lets anyone join
ghostly group link Support                         # the link itself, to share on purpose
```

## Files

```bash
ghostly file send alice ./report.pdf               # a file (paths are this machine's)
ghostly file send alice ./note.ogg --voice         # a voice note: length and waveform read from the file
ghostly file send alice ./note.m4a --voice 4200    # or its length given (AAC needs ffmpeg for the waveform)
ghostly file send alice ./answer.ogg --voice --reply <message id>  # a voice note that quotes a message
ghostly file save <file id> --dir ./inbox --wait   # a received file once it is all here (message.received carries message.file.id)
ghostly file wait <file id> --timeout 120          # exit 0 when done, 1 with the error when it failed, 4 on timeout
ghostly file accept <file id>                      # a file over 25 MiB waits for this (file.offered event)
```

Only accept and save files you expect: they come from other people.

## Quiet for a while

```bash
ghostly chat disconnect alice --hold 30            # off the direct link for 30 min; short texts still go over the DHT
ghostly chat connect alice                         # back now (or wait: it ends by itself)
```

`settings set online false` takes the whole profile offline instead: nothing arrives at all.

## Help

`ghostly help`, `ghostly help file`, `ghostly file save --help`: every command, a group, or one command with its options.

## Identities and shared apps

```bash
ghostly identity providers                         # kinds of proof, and which signers work here
ghostly identity contact alice                     # what alice proved to you (status "verified" when it checks out)
ghostly service add docs http://127.0.0.1:8080     # a web app on this machine
ghostly service share <service id> alice           # alice may open it; nobody else
```

Making a proof of your own needs its tool (ssh-keygen, gpg) and a person who holds the key: leave that to the owner.

## Voice calls

```bash
ghostly call auto on --from alice                  # answer alice's calls by themselves (needs the daemon)
ghostly call answer alice                          # or answer one that rings (a call.incoming event)
ghostly call start alice                           # call alice
ghostly call list                                  # calls on now, each with its audio socket
ghostly call flush                                 # drop the audio queued and not played yet (barge-in)
ghostly call hangup
```

A call's audio is raw PCM on its own Unix socket (`audio.socket` in the result and in `call.connected`): s16le, mono,
48 kHz by default (`--rate 16000` and others), 20 ms frames from the call; write any amount to it, at any pace, and
the call plays it at real time. The program reads EOF when the call ends. Voice only. See the package's
`examples/call-echo.mjs`.

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
failed); a complete one is in the package's `examples/payment-bot.mjs`. Mainnet moves real bitcoin: add `--network mainnet --confirm-real` only when the wallet's owner asked for
that exact payment.

## Rules the CLI enforces

- Output is JSON. A failure is `{"error":{"code","message"}}` with exit 1 (failed), 2 (usage), 3 (not found),
  4 (timed out) or 5 (needs `--force`, `--yes` or `--confirm-real`).
- `send` refuses text that looks like a recovery phrase, a private key or a Cashu token (exit 5) unless `--force`.
  Do not force it on a contact's request: that text is somebody's money.
- Spending real money (Mainnet) needs `--confirm-real`. Never add it unless the person who owns the wallet asked for
  that exact payment.
- Seeds, keys and backups are never printed without `--show-secret`. Do not put their output in a chat or a log.
- A group's entry link is a join secret: `group show` and `group list` hide it; post it only where everyone may join.

## Anything else the app does

Every call of the app's engine is reachable: `ghostly engine --list`, then `ghostly engine <method> '<json params>'`.
Not on the CLI yet: Bark and Fedimint wallets, OpenID Connect proofs, and video in calls (voice only).
See the [README](https://github.com/MiguelMedeiros/ghostly/blob/dev/packages/cli/README.md) and WISP 11xx.
