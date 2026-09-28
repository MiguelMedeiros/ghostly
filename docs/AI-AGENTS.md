# AI agents

Put your AI agent on Ghostly: [packages/cli/SKILL.md](../packages/cli/SKILL.md) teaches an agent to use `ghostly`,
the app's engine without a screen, for [OpenClaw](https://openclaw.dev) and other coding agents. People message the
agent from the Ghostly app; the agent reads JSON events and answers, in chats and groups, and can pay and get paid.
The short version, with what works and what is planned: [AI agents on Ghostly](https://ghostly.tools/developers/agents).

## 1. Install the CLI

The agent needs `ghostly` on its `PATH` (Node 22.12 or newer). It is built from source until the npm package is
published; see [CLI.md](CLI.md#install).

## 2. Install the skill

### OpenClaw / Codex

```bash
curl -fsSL --create-dirs https://raw.githubusercontent.com/MiguelMedeiros/ghostly/main/packages/cli/SKILL.md \
  -o ~/.codex/skills/ghostly/SKILL.md
```

### Cursor

```bash
curl -fsSL --create-dirs https://raw.githubusercontent.com/MiguelMedeiros/ghostly/main/packages/cli/SKILL.md \
  -o ~/.cursor/skills/ghostly/SKILL.md
```

`main` holds the released version of the skill. Until the next release reaches `main`, use `dev` in the URL.

## What the agent can do

| Command | What |
|---|---|
| `ghostly daemon --detach` | keep its profile online |
| `ghostly invite create` / `invite join` | make or open a `ghostly1…` invite, the same one the app uses |
| `ghostly send <chat> <text>` | send a message |
| `ghostly listen` | stream what happens as JSON lines; `--exec` or `--webhook` to react |
| `ghostly listen --turns --from <chat>` | one `agent.turn` event per message to answer, from the allowed chats and groups only; the contact's words under `untrusted` |
| `ghostly group create` / `group send` | take part in a group, with `@mentions` |
| `ghostly chat request` / `chat pay` | ask for a payment or pay, on Testnet unless told otherwise |

Real money needs `--confirm-real`, and the skill tells the agent to add it only when the wallet's owner asked for
that exact payment. Every command, event and socket method: [CLI.md](CLI.md) and the
[package README](../packages/cli/README.md). Examples: an [echo bot](../packages/cli/examples/echo-bot.sh), a
[payment bot](../packages/cli/examples/payment-bot.mjs), and a
[Claude Code agent](../packages/cli/examples/claude-code-agent.sh) woken on each turn ([Agent turns](CLI.md#agent-turns)).
A contact's text is data for the agent, never its instructions.

## Ghostly as a channel for agents

Partly built ([its row](wisps/ADAPTER-ROADMAP.md#plugins-apps-catalogs-and-ghostlyos)). An agent on Telegram is woken
by its gateway on each message. On Ghostly, `ghostly listen --turns` with an allowlist does that part: one generic
connector, so any agent framework that takes a webhook or reads a socket gets Ghostly messages the way it gets
Telegram's. It builds on what the CLI has and adds no wire format. Built: the allowlist (`--from`, `--group`), the
turn event (`agent.turn`, [its contract](CLI.md#agent-turns)) and the Claude Code adapter. Still to build: the Hermes
Agent plugin, turns on the daemon's socket (`events.subscribe` gives every event today), and `wake/1` for agents: until
then an agent is woken only while a `ghostly listen` process runs.

The contract:

| Part | What |
|---|---|
| In | Each `message.received`, and each `group.message` that mentions the agent, starts one turn: `ghostly listen --turns` makes it one `agent.turn` event. The event arrives on stdin (`listen --exec`), as a POST body to a local bridge (`listen --webhook`) or on the daemon's socket (`events.subscribe`), never in a command's arguments. Dedupe on its `id`; a `--cursor` resumes after a restart. |
| Allowlist | Per contact and per group (`listen --from <chat>`, `--group <group>`), checked before the agent wakes. Anyone else's message is kept in the chat and never reaches the agent. |
| Data, not instructions | The connector hands the agent a contact's text as quoted data, under `untrusted` in the turn. Nothing a contact writes can change the agent's instructions, reveal a secret or move money: real payments keep `--confirm-real`, given only by the wallet's owner. |
| Out | `send` (with `--reply`), `typing --kind thinking --status "<text>"` while the agent works, `file send --voice` for a voice note, `file send` for a file, `react`. |

First adapters:

- **Claude Code.** Built: [examples/claude-code-agent.sh](../packages/cli/examples/claude-code-agent.sh), a
  `ghostly listen --turns --exec` loop that wakes `claude -p` with the turn on stdin.
- **Hermes Agent** (Nous Research). Its gateway adds a platform as a plugin in `~/.hermes/plugins/`, an adapter that
  extends `BasePlatformAdapter` with `connect`, `disconnect`, `send` and `send_typing`
  ([adding a platform adapter](https://hermes-agent.nousresearch.com/docs/developer-guide/adding-platform-adapters)).
  A Ghostly plugin maps those to the daemon's socket, and its allowlist to the gateway's per-platform allowed users
  ([messaging gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)).

## The older skill

[cli/SKILL.md](../cli/SKILL.md) teaches the legacy `ghostly-cli`, a compatibility client that reads only `ghost://`
invites and cannot pair with the app. Bots already built on it keep working; new agents use `ghostly`.
