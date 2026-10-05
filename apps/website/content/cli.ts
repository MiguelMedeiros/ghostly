import type { Level } from "@/lib/status";

/**
 * /cli: the headless `ghostly` (@ghostlytools/cli, packages/cli, WISP 1100). Short on
 * purpose: a pitch, the install line, four commands, a bot and links. The long
 * version is docs/CLI.md. Checked against packages/cli on `main`.
 */

const DOCS = "https://github.com/MiguelMedeiros/ghostly/blob/main";

/** One line: installs the package from npm. */
export const INSTALL = "npm install -g @ghostlytools/cli";

/** A session, as the terminal in the hero shows it. Output shapes from packages/cli/README.md. */
export const SESSION = `$ ghostly daemon --detach
$ ghostly invite create --label casper
{"invite":"ghostly1…","link":"https://ghostly.tools/#ghostly1…"}
$ ghostly send casper "Boo! 👻"
{"messageId":"me_…","delivery":"sending"}
$ ghostly listen
{"type":"message.received","message":{"text":"deploy?"}}`;

/** packages/cli/examples/echo-bot.sh, without its comments. */
export const ECHO_BOT = `ghostly listen --type message.received --cursor "\${GHOSTLY_HOME:-\$HOME/.ghostly}/echo.cursor" --exec '
  event="$(cat)"
  printf "echo: %s" "$(printf "%s" "$event" | jq -r .message.text)" \\
    | ghostly send "$(printf "%s" "$event" | jq -r .chat)" --stdin'`;

export const COMMANDS = [
  "ghostly daemon --detach",
  "ghostly invite create --label alice",
  'ghostly send alice "hello"',
  "ghostly listen",
] as const;

export const LINKS = {
  guide: `${DOCS}/docs/CLI.md`,
  reference: `${DOCS}/packages/cli/README.md`,
  paymentBot: `${DOCS}/packages/cli/examples/payment-bot.mjs`,
  echoBot: `${DOCS}/packages/cli/examples/echo-bot.sh`,
  legacy: `${DOCS}/docs/wisps/402-legacy-chat.md`,
} as const;

/** What it covers, one level each (the site's levels; see lib/status.ts). */
const SCOPE: { level: Level; key: string }[] = [
  { level: "available", key: "chats" },
  { level: "available", key: "chatting" },
  { level: "available", key: "groups" },
  { level: "available", key: "files" },
  { level: "available", key: "pay" },
  { level: "available", key: "ids" },
  { level: "available", key: "services" },
  { level: "available", key: "calls" },
  { level: "available", key: "npm" },
  { level: "planned", key: "dht" },
  { level: "planned", key: "wallets" },
  { level: "planned", key: "binary" },
];

export const cli = {
  meta: {
    title: "Ghostly CLI: the app's engine for bots",
    description:
      "The Ghostly app's engine without a screen: invites, chats, groups, files, payments and calls for scripts, bots and AI agents, every event a JSON line.",
  },
  hero: {
    eyebrow: "Command line",
    title: "Ghostly for bots.",
    lead: "ghostly runs the app's own engine without a screen. Your script gets the same invites, chats, groups, payments and voice calls as the app, and every event as a JSON line.",
    install: "Install",
    guide: "Full guide",
    term: "Example ghostly session",
  },
  install: {
    title: "Install",
    hint: "Node 22.12 or newer. The command is ghostly.",
    copy: "Copy",
    copied: "Copied",
  },
  commands: {
    title: "Four commands",
    hints: [
      "Keeps your profile online.",
      "A ghostly1 invite that opens in the app.",
      "Sends a message. Every command answers in JSON.",
      "Streams events, one JSON line each.",
    ],
  },
  bot: {
    title: "An echo bot",
    lead: "Each event arrives on the hook's stdin, never in its arguments, so a contact's text cannot reach the shell.",
    payment: "A payment bot, on test coins",
    echo: "The echo bot",
  },
  scope: {
    title: "What it covers",
    items: {
      chats: "Invites and one chat, over the app's transports",
      chatting: "Typing and a status line, replies, edits and emoji reactions",
      groups: "Groups, with mentions and admin tools",
      files: "Files and voice notes, with their waveform",
      pay: "Wallets and payments (Mainnet only with --confirm-real)",
      ids: "Identity proofs",
      services: "Shared web apps",
      calls: "Voice calls, the audio handed to your program",
      npm: "On npm as @ghostlytools/cli",
      dht: "Reading the DHT directly (relays for now)",
      wallets: "Bark wallets",
      binary: "A single binary, without Node",
    } as Record<string, string>,
  },
  links: {
    title: "Read more",
    guide: "Guide",
    reference: "Every command and event",
    agents: "AI agents",
    wisp: "WISP 1100: the contract",
  },
  legacy: {
    title: "Looking for ghostly-cli?",
    body: "The older Rust ghostly-cli, the client for v0.4 chats, was removed after 1.0. Bots on it move to ghostly, above. Its record format stays documented.",
    link: "WISP 402",
  },
};

export const scope = SCOPE;
export type CliCopy = typeof cli;
