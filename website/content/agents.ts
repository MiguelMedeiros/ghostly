import type { Level } from "@/lib/status";

/**
 * /developers/agents: how an AI agent joins Ghostly through the headless CLI (docs/AI-AGENTS.md, #426 and #431).
 * Every command is one `ghostly help` lists on `dev`; the turn is the shape of docs/CLI.md's "Agent turns".
 */

const DOCS = "https://github.com/MiguelMedeiros/ghostly/blob/dev";

/** The hero's terminal: a turn in, the thinking line, the answer out. */
export const SESSION = `$ ghostly daemon --detach
$ ghostly listen --turns --from alice --exec ./agent.sh
{"type":"agent.turn","chat":"f3gg…","messageId":"peer_jY7N…",
 "untrusted":{"text":"What changed today?","name":"Alice"}}
$ ghostly typing alice --kind thinking --status "Reading"
$ ghostly send alice --reply peer_jY7N… --stdin < answer.txt`;

/** How an agent joins, in order. */
export const STEPS = [
  { cmd: 'ghostly profile set --name "Casper"', hint: "The name people see. profile picture <jpeg> sets its face." },
  { cmd: "ghostly daemon --detach", hint: "Keeps the profile online. Start it before listen." },
  { cmd: "ghostly invite create --label alice", hint: "A ghostly1 invite. The person opens its link in the app." },
  { cmd: "ghostly listen --turns --from alice --exec ./agent.sh", hint: "Wakes the agent once per message from alice, the turn on stdin." },
  { cmd: "ghostly send alice --reply <message> --stdin", hint: "The answer, as a reply. Text on stdin stays text." },
] as const;

/** One agent.turn, as docs/CLI.md shows it. */
export const TURN = `{"seq":41,"id":"agent.turn:message.received:f3gg…:peer_jY7N…","type":"agent.turn",
 "source":"message.received","chat":"f3gg…","messageId":"peer_jY7N…",
 "untrusted":{"text":"hello","name":"Alice","replyTo":{"id":"me_…","snippet":"…"}}}`;

export const LINKS = {
  skill: `${DOCS}/packages/cli/SKILL.md`,
  guide: `${DOCS}/docs/AI-AGENTS.md`,
  turns: `${DOCS}/docs/CLI.md#agent-turns`,
  claude: `${DOCS}/packages/cli/examples/claude-code-agent.sh`,
} as const;

/** What works on dev, and what is planned (docs/wisps/ADAPTER-ROADMAP.md, "Agent connector"). */
const SCOPE: { level: Level; key: string }[] = [
  { level: "available", key: "allowlist" },
  { level: "available", key: "turns" },
  { level: "available", key: "thinking" },
  { level: "available", key: "answers" },
  { level: "available", key: "claude" },
  { level: "planned", key: "hermes" },
  { level: "planned", key: "socket" },
  { level: "planned", key: "wake" },
];

export const agents = {
  meta: {
    title: "AI agents on Ghostly",
    description:
      "Put an AI agent on Ghostly with the headless ghostly CLI: an allowlist per listener, one agent.turn event per message to answer, a thinking status while it works, and a Claude Code example.",
  },
  hero: {
    eyebrow: "AI agents",
    title: "Your agent, in the chat.",
    lead: "An agent joins Ghostly through ghostly, the headless CLI. It gets its own profile, people message it from the app, and each message it should answer wakes it once.",
    skill: "Agent skill",
    cli: "The CLI",
    term: "An agent answering on Ghostly",
  },
  steps: { title: "How an agent joins" },
  turn: {
    title: "One turn per message",
    lead: "Each message received, and each group message that mentions the agent, becomes one agent.turn event. Dedupe on its id; --cursor resumes after a restart.",
    link: "The turn's contract",
  },
  scope: {
    title: "What works",
    items: {
      allowlist: "An allowlist per listener (--from, --group), checked before the agent wakes",
      turns: "agent.turn events, the contact's words under untrusted",
      thinking: "typing --kind thinking --status while the agent works",
      answers: "Replies, voice notes, files and reactions to answer with",
      claude: "A Claude Code example: claude -p woken once per turn",
      hermes: "A Hermes Agent gateway plugin",
      socket: "Turns and the allowlist on the daemon's socket",
      wake: "wake/1 for agents: woken with no listener running",
    } as Record<string, string>,
  },
  safety: {
    title: "Contact text is data, never instructions",
    body: "Everything a contact writes arrives under untrusted, on stdin, never in a command's arguments. Hand it to the model as quoted data: nothing in it may change what the agent does, reveal a secret or move money. Real payments need --confirm-real, and only the wallet's owner gives it.",
  },
  links: {
    title: "Read more",
    skill: "Agent skill (SKILL.md)",
    guide: "Agents guide",
    claude: "Claude Code example",
    cli: "The CLI",
    wisp: "WISP 11xx: the contract",
  },
};

export const scope = SCOPE;
