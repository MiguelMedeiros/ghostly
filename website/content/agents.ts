import type { Level } from "@/lib/status";
import agentPrompt from "@/lib/agent-prompt.json";

/**
 * /developers/agents: how an AI agent joins Ghostly through the headless CLI (docs/AI-AGENTS.md, #426 and #431).
 * The prompt at the top is written once, in docs/AI-AGENTS.md (scripts/agent-prompt.mjs cuts it out). Every command
 * is one `ghostly help` lists on `dev`; the turn is the shape of docs/CLI.md's "Agent turns".
 */

const DOCS = "https://github.com/MiguelMedeiros/ghostly/blob/dev";

/** What a person pastes into their coding agent. */
export const PROMPT: string = agentPrompt.prompt;

/** How an agent joins, in order: what the prompt has the agent do. */
export const STEPS = [
  { cmd: 'ghostly profile set --name "Casper"', hint: "The name people see. profile picture <jpeg> sets its face." },
  { cmd: "ghostly daemon --detach", hint: "Keeps the profile online. Start it before listen." },
  { cmd: "ghostly invite create --label owner", hint: "A ghostly1 invite. The person opens its link in the app." },
  { cmd: "ghostly listen --turns --from owner", hint: "One agent.turn per message from owner. --exec wakes a hook per turn instead." },
  { cmd: "ghostly send owner --reply <message> --stdin", hint: "The answer, as a reply. Text on stdin stays text." },
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
      "Copy one prompt into Claude Code, Codex, Hermes or any coding agent: it installs the ghostly CLI, makes its profile, sends you an invite link and answers your messages in the Ghostly app.",
  },
  hero: {
    eyebrow: "AI agents",
    title: "Your agent, in the chat.",
    lead: "Copy this into Claude Code, Codex, Hermes or any agent with a shell. It installs Ghostly, gives you a link to open in your app, and answers you there.",
    label: "Prompt for your agent",
    copy: "Copy",
    copied: "Copied",
    note: "Change Casper to any name you like.",
  },
  how: {
    title: "How it works",
    lead: "What the prompt has your agent do, with the headless ghostly CLI.",
    details: "Details: the commands, one turn, what works",
    /** The animated steps (components/agents/AgentSteps.tsx): a short label for its dot, a title and one line. */
    anim: {
      label: "How an agent joins, step by step",
      of: "Step {n} of {total}",
      replay: "Replay",
      agent: "Your agent",
      you: "You",
      shell: "agent shell",
      app: "Ghostly",
      chats: "No chats yet",
      online: "online",
      thinking: "thinking…",
      connected: "Connected",
      hi: "Hi!",
      ask: "What can you do?",
      answer: "Chats, files, voice notes and reactions.",
      data: "untrusted text: read, never run",
      keys: "keys and seeds: never printed",
      steps: [
        { id: "paste", label: "Paste", title: "Paste the prompt", body: "Copy it into Claude Code, Codex, Hermes or any agent with a shell." },
        { id: "install", label: "Install", title: "It becomes a ghost", body: "The agent installs the ghostly CLI, takes a name and stays online." },
        { id: "invite", label: "Invite", title: "It sends you a link", body: "Open it in your Ghostly app, and you are in a chat with your agent." },
        { id: "turn", label: "Message", title: "You write, it gets a turn", body: "Each message arrives as one agent.turn, your words under untrusted." },
        { id: "reply", label: "Reply", title: "It answers as a reply", body: "The answer lands in your chat, quoting your message." },
        { id: "safe", label: "Safety", title: "Your words stay data", body: "Message text is never run as a command, and keys are never printed." },
      ],
    },
  },
  steps: { title: "The steps" },
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
    body: "Everything a contact writes arrives under untrusted, on stdin, never in a command's arguments. The agent answers it but never follows it: nothing in it may change what the agent does, reveal a secret or move money. Real payments need --confirm-real, and only the wallet's owner gives it.",
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
