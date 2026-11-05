# Talk to an AI by voice

Call a contact from your Ghostly app and talk to Claude: it listens, answers out loud, and stops talking when you talk.
The contact is [ghostly-voice-agent](https://github.com/MiguelMedeiros/ghostly-voice-agent), an open-source program
that you run on your own computer with the `ghostly` CLI and your own keys. Nothing is hosted for you, and there is no
shared account.

```
your app ──call──► ghostly CLI (your computer) ──audio──► ghostly-voice-agent
                                                           ├─ speech to text: ElevenLabs
                                                           ├─ the answer: Claude
                                                           └─ text to speech: ElevenLabs
```

## What you need

| | |
|---|---|
| A computer that stays on while you want to call | With Node 22.12 or newer for the CLI, and Python for the agent (its README says which version and systems) |
| The `ghostly` CLI | `npm install -g @ghostlytools/cli` ([CLI.md](CLI.md#install)). It runs the call and hands its audio to the agent ([Voice calls](CLI.md#voice-calls)) |
| An ElevenLabs API key | For speech to text and the voice. A key of your own ElevenLabs account |
| Claude | Either a Claude subscription logged in with the `claude` CLI on that computer, or an Anthropic API key |
| A Ghostly app | Desktop, web or phone: the one you call from |

## Set it up

1. Give the agent its own Ghostly profile and keep it online:

   ```bash
   ghostly profile set --name "Voice"
   ghostly daemon --detach
   ```

2. Add it as a contact. Run `ghostly invite create --label owner`, open the `link` it prints in your Ghostly app, and
   wait until the chat is live: `ghostly chat wait owner --timeout 600`.
3. Note your chat's id, the one the agent may take calls from: `ghostly chat show owner` prints it as `id`.
4. Install and start the agent by following [its README](https://github.com/MiguelMedeiros/ghostly-voice-agent#readme):
   it lists the versions it needs, where your keys go, which chats may call it, and how to start and stop it. Keys stay
   in a file on your computer; the agent never prints them.

An AI coding agent can do these steps for you: give it this page and the agent's README.

## Call it

Open the chat with the agent in your Ghostly app and press the call button. The agent answers, greets you, and you
talk. Talk over it to interrupt. Hang up as with any call. While no call is on, the agent waits; it answers only the
chats you allowed and ignores calls from anyone else.

If the call stays on "connecting" and then fails, see [When a call does not connect](CLI.md#voice-calls): a VPN that is
the default route on the same machine is the usual cause.

## What it costs

Ghostly costs nothing here. The agent spends on your accounts, for every call:

- **ElevenLabs**: speech to text for the time you talk, and text to speech for every character the agent says. A
  reply that you interrupt still counts for what was already sent.
- **Claude**: with a subscription, calls use your plan's limits like any other `claude` session; with an API key, each
  turn is billed by tokens. See the agent's README for which models it uses and how it behaves when a limit is hit.

Check both providers' pricing pages before long calls.

## Privacy

A Ghostly call is end-to-end encrypted between your app and your computer. From there, the agent sends it on:

- **Your voice** goes to ElevenLabs, to be turned into text.
- **What you said, as text**, goes to Anthropic, to write the answer.
- **The answer, as text**, goes to ElevenLabs, to be spoken.

So those two companies receive what you say on these calls, under their own terms and retention rules. The agent may
also keep transcripts and logs on your computer: its README says what it writes and where. Don't say anything on such a
call that you would not type into those services, and tell anyone else you let call it that they are talking to an AI
whose audio leaves the call.

## Keep it safe

- Allow only your own chat. Anyone who can call the agent can try to talk it into something.
- The agent's Claude answers with no tools: it can talk, not read files or run commands. Keep it that way
  ([Safe setup](AI-AGENTS.md#safe-setup)).
- The keys are yours: keep the file that holds them out of git and backups you share.

## Why it is not in the Store

The Ghostly Store lists mini-apps, signed web bundles that run in the app's sandbox
([WISP 1200](wisps/1200-marketplace.md#what-an-app-and-a-plugin-are)). A bot is a program on your computer with your
keys, and the Store does not list bots yet. A mini-app cannot reach a call's audio either. So the voice agent is a
recipe: this page and the agent's repository.

More bots and agents on the CLI: [AI agents and bots](AI-AGENTS.md).
