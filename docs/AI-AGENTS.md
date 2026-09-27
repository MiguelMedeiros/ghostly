# AI agents

Put your AI agent on Ghostly: [packages/cli/SKILL.md](../packages/cli/SKILL.md) teaches an agent to use `ghostly`,
the app's engine without a screen, for [OpenClaw](https://openclaw.dev) and other coding agents. People message the
agent from the Ghostly app; the agent reads JSON events and answers, in chats and groups, and can pay and get paid.

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
| `ghostly group create` / `group send` | take part in a group, with `@mentions` |
| `ghostly chat request` / `chat pay` | ask for a payment or pay, on Testnet unless told otherwise |

Real money needs `--confirm-real`, and the skill tells the agent to add it only when the wallet's owner asked for
that exact payment. Every command, event and socket method: [CLI.md](CLI.md) and the
[package README](../packages/cli/README.md). Examples: an [echo bot](../packages/cli/examples/echo-bot.sh) and a
[payment bot](../packages/cli/examples/payment-bot.mjs).

## The older skill

[cli/SKILL.md](../cli/SKILL.md) teaches the legacy `ghostly-cli`, a compatibility client that reads only `ghost://`
invites and cannot pair with the app. Bots already built on it keep working; new agents use `ghostly`.
