/**
 * /developers/agents/threat-model: what someone who can message a chat can and cannot make a connected agent do, which
 * control stops what, and the limits no control removes. Each control is one the CLI has; the comment beside it names
 * the code. What is not built yet is listed under `gaps`, never claimed.
 */

export const threat = {
  meta: {
    title: "Threat model for AI agents",
    description: "What someone who can message your agent's chat can and cannot make it do on Ghostly, which control stops what, and the limits that remain.",
  },
  hero: {
    eyebrow: "AI agents · Threat model",
    title: "What a message can make your agent do",
    lead: "Your agent on Ghostly reads chat messages. This page says who can reach it, what each control stops, and what no control stops.",
    back: "AI agents",
  },
  who: {
    eyebrow: "Who can reach it",
    title: "Four kinds of sender",
    items: [
      // packages/cli/src/listen.ts (Allowlist.allows).
      { id: "owner", title: "You, in the owner chat", body: "On the allowlist. Every message you send is a turn, and the agent acts on it with whatever tools it has." },
      // packages/cli/src/listen.ts (Allowlist.allows: a chat not on the list is dropped before any hook).
      { id: "contact", title: "Any other contact", body: "Not on the allowlist. The message stays in the chat and never reaches the agent." },
      // packages/cli/src/listen.ts (groups by id only); packages/browser/src/engine/groups.ts (member from the signed frame).
      { id: "group", title: "A member of an allowed group", body: "Any member who mentions the agent wakes it, and can press its buttons in that group. Treat them as strangers: answer with a model that has no tools." },
      // packages/browser/src/engine/node.ts (a paired chat refuses another key); packages/cli/src/apiKit.ts (INVITE_TAKEN).
      { id: "invite", title: "Someone with a copy of your invite", body: "Once your app has opened it, a copy is refused. Before that, whoever opens it first gets the chat, so open yours right away." },
    ],
  },
  cannot: {
    eyebrow: "Cannot",
    title: "What a sender cannot make it do",
    items: [
      // packages/cli/src/listen.ts (Allowlist.allows).
      { id: "wake", text: "Wake it, unless their chat or group is on the allowlist.", cmd: "ghostly listen --turns --from owner" },
      // packages/cli/src/listen.ts (toTurn: untrusted; --exec takes the event on stdin).
      { id: "args", text: "Put their words in a command line. A turn reaches your hook on stdin, the words under untrusted.", cmd: "ghostly listen --turns --from owner --exec ./on-turn.sh" },
      // packages/cli/src/listen.ts (checkWebhook: 127.0.0.1, localhost or [::1]); packages/cli/src/main.ts (a URL with a path or a query is warned about: it goes in GHOSTLY_WEBHOOK, out of ps).
      { id: "webhook", text: "Send events off the machine. A webhook can only be on this machine.", cmd: "ghostly listen --turns --from owner --webhook http://127.0.0.1:8787" },
      // packages/cli/src/runtime/engine.ts (automaticWallets: false); packages/browser/src/engine/payments.ts (requests kept pending).
      { id: "pay", text: "Make it pay. A CLI profile has no wallet until you create one, a payment request waits until you pay it, and Mainnet needs --confirm-real.", cmd: "ghostly wallet list" },
      // packages/browser/src/shared/buttons.ts (a press only from the chat's contact, on an open question).
      { id: "press", text: "Press a button in a chat they are not in. In a 1:1 chat only you can answer, and the event says who pressed.", cmd: "ghostly listen --type button.pressed --from owner" },
      // packages/cli/src/commands/files.ts (file save); packages/cli/src/files.ts (saveName); packages/cli/src/runtime/fileBytes.ts (a received file is files/<space>/<id> in the profile folder).
      { id: "files", text: "Save a file under its own name in a folder you use. Only file save does, never over a file without --force, and a name that starts with a dash gets a _ first. A file a contact sends is kept in the profile's own folder, under an id.", cmd: "ghostly file save <file> --dir ./inbox" },
      // packages/cli/src/commands/services.ts (service share, per chat).
      { id: "services", text: "Open a local web app you serve, unless you shared it with their chat.", cmd: "ghostly service share <service> <chat> --off" },
      // packages/cli/src/calls/manager.ts (autoFor: on, and the chat on --from when given).
      { id: "calls", text: "Have a call answered, when auto answer names only your chat.", cmd: "ghostly call auto on --from owner" },
    ],
  },
  controls: {
    eyebrow: "Controls",
    title: "Which control stops what",
    items: [
      // packages/cli/src/listen.ts (Allowlist).
      { id: "owner", title: "Owner-only orders", stops: "A stranger giving the agent work.", how: "Allowlist only your chat with --from owner." },
      // packages/cli/src/listen.ts (toTurn, AgentTurn.untrusted).
      { id: "data", title: "Data, not instructions", stops: "Shell injection from a message, and a hook mistaking a name or an id for an order.", how: "The sender's words, name and ids sit under untrusted, and reach your hook on stdin." },
      // packages/cli/src/buttons.ts (--once); packages/browser/src/shared/buttons.ts (answered: once counts per member); packages/cli/src/events.ts (button.pressed, by); packages/cli/src/listen.ts (press on the turn).
      { id: "approve", title: "Approvals with buttons", stops: "A risky step that runs before you agree.", how: "The agent asks with buttons and waits for button.pressed from you. --once takes one answer from each person: in a group every member can answer once, so the hook checks that by is your key." },
      // packages/cli/examples/claude-code-agent.sh.
      { id: "tools", title: "A model with no tools for others", stops: "A persuaded model reading files or running commands for someone who is not you.", how: 'The Claude Code example runs claude -p --tools "" with no MCP servers and none of your settings.' },
      // packages/cli/src/runtime/engine.ts (automaticWallets: false); packages/cli/src/wallets.ts (--confirm-real).
      { id: "wallet", title: "No wallet, least credentials", stops: "Money, and production systems, within the agent's reach.", how: "No wallet unless you create one. Give the agent's shell only what the task needs, never production keys." },
      // packages/cli/src/api.ts (findSecret before a send, a forward or an edit).
      { id: "secrets", title: "A guard on what it sends", stops: "The agent pasting a seed, a key or ecash into a chat by mistake.", how: "send refuses text that looks like one, unless --force." },
      // packages/cli/src/host.ts (the socket is 0600); packages/cli/src/profiles.ts (the profile folder is 0700).
      { id: "local", title: "Owner-only files", stops: "Another user on the machine driving the agent's profile.", how: "The daemon's socket and the profile's files are readable by your user only." },
    ],
  },
  limits: {
    eyebrow: "Limits",
    title: "What no control stops",
    items: [
      // packages/cli/src/listen.ts (toTurn has no forward mark); packages/cli/src/views.ts (message.received carries forwarded).
      { id: "forward", title: "What you forward", body: "A message you forward, or text you paste, arrives as your own turn. If it hides instructions, the agent may follow them. Read before you forward, and keep risky steps behind a button. A turn does not mark a forward yet; the raw message.received event does." },
      // apps/ui/src/contexts/LockScreenContext.tsx (the app lock); packages/cli/src/commands/chats.ts (chat remove).
      { id: "device", title: "Your own device", body: "Whoever holds your unlocked phone, or your Ghostly keys, can give orders as you. Lock the app, and if a device is lost, remove the chat on the agent's side with ghostly chat remove." },
      { id: "persuasion", title: "Persuasion", body: "A language model can be talked into things by text it reads. The controls decide who can write to it, not what it will do with what it reads. An agent with tools takes orders from you only." },
      // packages/cli/src/profiles.ts and src/runtime/storage.ts (0700 folder, 0600 files, nothing encrypted at rest).
      { id: "machine", title: "The agent's machine", body: "The profile's keys are files only your user can read, not encrypted. Any program running as that user can read them and act as the agent, so keep them under a user of their own (below)." },
    ],
  },
  // packages/cli/src/profiles.ts and src/runtime/storage.ts (0700 folder, 0600 files); packages/cli/src/host.ts and
  // src/daemonProof.ts (a command reads daemon.secret in the profile folder, so it runs as the profile's user).
  apart: {
    eyebrow: "Keys at rest",
    title: "Give Ghostly a user of its own",
    lead: "A CLI profile's keys, the identity seed and each wallet's seed, are files in a folder only your user can open (0700, files 0600). They are not encrypted, and the CLI has no lock password as the app has: any program running as your user can read them, the agent's own shell tools and the packages in its project too. To keep them out of that reach, run Ghostly as another OS user.",
    steps: [
      { id: "user", title: "A user that owns the profile", body: "Make a system user for Ghostly, keep its data folder in that user's home, and set the profile up as that user. Your user cannot open the folder." },
      { id: "hook", title: "Ghostly and its hook run as it", body: "ghostly listen runs as that user and starts your hook for each turn. The hook hands the turn to your agent as your user, through one sudo rule, and sends what the agent prints." },
      { id: "tools", title: "The agent's tools run as you", body: "The model, its shell and your project stay under your user. Give your user no way to run commands as the Ghostly user: whoever can run ghostly as it can do anything the profile can. The agent then speaks in the chat only through what the hook sends." },
    ],
    examples: [
      {
        id: "linux",
        title: "Linux, with systemd",
        code: `sudo useradd --system --create-home --home-dir /var/lib/ghostly --shell /usr/sbin/nologin ghostly
sudo -u ghostly ghostly invite create --label owner --home /var/lib/ghostly/.ghostly   # open it in your app

# /etc/sudoers.d/ghostly (sudo visudo -f): the ghostly user may run your agent, nothing more
ghostly ALL=(alice) NOPASSWD: /home/alice/agent/answer.sh

#!/bin/sh
# /var/lib/ghostly/on-turn.sh, owned by root, mode 0755
turn="$(cat)"
chat="$(printf '%s' "$turn" | jq -r .chat)"
printf '%s' "$turn" | sudo -u alice /home/alice/agent/answer.sh |
  ghostly send "$chat" --stdin --home /var/lib/ghostly/.ghostly

# /etc/systemd/system/ghostly-agent.service, then: sudo systemctl enable --now ghostly-agent
[Service]
User=ghostly
ExecStart=/usr/bin/env ghostly listen --turns --from owner --home /var/lib/ghostly/.ghostly --exec /var/lib/ghostly/on-turn.sh
Restart=on-failure

[Install]
WantedBy=multi-user.target`,
      },
      {
        id: "mac",
        title: "macOS, with launchd",
        code: `sudo sysadminctl -addUser ghostly -password -   # then the same sudo rule and hook, under /Users/ghostly

<!-- /Library/LaunchDaemons/tools.ghostly.agent.plist, then:
     sudo launchctl bootstrap system /Library/LaunchDaemons/tools.ghostly.agent.plist -->
<plist version="1.0"><dict>
  <key>Label</key><string>tools.ghostly.agent</string>
  <key>UserName</key><string>ghostly</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/ghostly</string><string>listen</string><string>--turns</string>
    <string>--from</string><string>owner</string><string>--home</string><string>/Users/ghostly/.ghostly</string>
    <string>--exec</string><string>/Users/ghostly/on-turn.sh</string>
  </array>
  <key>KeepAlive</key><true/>
</dict></plist>`,
      },
    ],
  },
  gaps: {
    eyebrow: "Not built yet",
    title: "Controls that do not exist yet",
    lead: "Said here so nobody counts on them.",
    items: [
      "A read-only mode for an agent. What it can do is what its own tools allow.",
      "Approvals Ghostly enforces. Today the agent's own code waits for the tap.",
      "An allowlist of members inside a group. A group is allowed whole.",
      // packages/cli/src/commands/chats.ts (chat remove, no invite withdraw); packages/cli/src/commands/groups.ts (group link --off, --reset).
      "A chat invite that expires or can be withdrawn. Removing the chat is the way to stop one. A group's link can be turned off or replaced already, with group link --off or --reset.",
      "A switch that turns payments off for a profile. It has no wallet unless you create one, and wallet remove takes one away.",
      "A forward mark on agent.turn.",
      "A passphrase that keeps a CLI profile's keys encrypted on disk. Today a user of its own is the way to keep them apart.",
    ],
  },
  more: {
    title: "Read more",
    agents: "AI agents on Ghostly",
    faq: "Agents FAQ",
    llms: "llms.txt, for AI readers",
    safe: "Safe setup (Agents guide)",
    policy: "Security policy",
  },
};
