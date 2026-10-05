import type { Level } from "@/lib/status";
import agentPrompt from "@/lib/agent-prompt.json";

/**
 * /developers/agents: what a bot can do in a Ghostly chat, how to connect one, and the prompt that does it for you
 * (docs/AI-AGENTS.md, #426 and #431). The prompt is written once, in docs/AI-AGENTS.md (scripts/agent-prompt.mjs cuts
 * it out). Every command here is one `ghostly help` lists (packages/cli/test/agentDocs.test.ts checks them); what a
 * card holds is WISP 405 · Status Cards, linked, never restated.
 */

const DOCS = "https://github.com/MiguelMedeiros/ghostly/blob/main";

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
  cliGuide: `${DOCS}/docs/CLI.md`,
  readme: `${DOCS}/packages/cli/README.md`,
  turns: `${DOCS}/docs/CLI.md#agent-turns`,
  claude: `${DOCS}/packages/cli/examples/claude-code-agent.sh`,
  cards: "/wisps/405-status-cards",
  buttons: "/wisps/406-message-buttons",
} as const;

/** What works on dev, and what is planned (docs/wisps/ADAPTER-ROADMAP.md, "Agent connector"). */
const SCOPE: { level: Level; key: string }[] = [
  { level: "available", key: "allowlist" },
  { level: "available", key: "turns" },
  { level: "available", key: "thinking" },
  { level: "available", key: "cards" },
  { level: "available", key: "buttons" },
  { level: "available", key: "mentions" },
  { level: "available", key: "answers" },
  { level: "available", key: "calls" },
  { level: "available", key: "claude" },
  { level: "planned", key: "hermes" },
  { level: "planned", key: "socket" },
  { level: "planned", key: "wake" },
];

/** The three commands of "Connect your agent", each copied on its own. */
export const CONNECT = [
  { title: "Install the CLI", body: "Node 22.12 or newer.", cmds: ["npm install -g @ghostlytools/cli"] },
  {
    title: "A profile and an invite",
    body: "Open the link it prints in your Ghostly app: you are in a chat with your agent.",
    cmds: ['ghostly profile set --name "Casper"', "ghostly daemon --detach", "ghostly invite create --label owner"],
  },
  {
    title: "Send a task card",
    body: "It shows in your chat. Each update moves the same card.",
    cmds: ['ghostly task send owner --id hello --title "Say hello" --steps 1/2', "ghostly task update owner hello --status done --steps 2/2"],
  },
] as const;

/** What a bot can show, each with the command that does it. */
export const SHOWS = [
  { id: "thinking", title: "Thinking", body: "A status line while it works, for up to 10 minutes. Its next message ends it.", cmd: 'ghostly typing owner --kind thinking --status "Reading the logs" --for 600' },
  { id: "task", title: "Task cards", body: "Status, progress, the step it is on, how long it has run and its pull request. One card, kept current.", cmd: 'ghostly task update owner relay-fix --steps 3/4 --step "CI"' },
  { id: "routine", title: "Routine cards", body: "A job on a schedule: the last run, how it went, and the next.", cmd: 'ghostly routine update owner nightly --run "ok:12 issues checked"' },
  {
    id: "buttons",
    title: "Buttons",
    body: "Up to six under a question. A tap is a reply, and listen gets button.pressed: which button, and who. button update --chosen and --close answer it.",
    cmd: 'ghostly send owner --button merge:Merge --button wait:Later --style merge=primary --once "Merge PR #612?"',
  },
  { id: "groups", title: "Groups", body: "Woken only when someone writes @Casper. The Tasks panel lists each bot's cards.", cmd: 'ghostly group send crew "On it, @Ana" --mention Ana' },
  { id: "calls", title: "Voice calls", body: "It answers your calls; the audio reaches your program as raw PCM.", cmd: "ghostly call auto on --from owner" },
] as const;

export const agents = {
  meta: {
    title: "AI agents on Ghostly",
    description:
      "Put Claude Code, Codex, Hermes or your own bot in your Ghostly chats. It answers, shows its thinking, asks with buttons and keeps task cards current.",
  },
  hero: {
    eyebrow: "AI agents",
    title: "Your agents, in your chats.",
    lead: "Claude Code, Codex, Hermes or a bot of your own joins Ghostly like a contact. It answers you, shows what it is thinking, asks with buttons, and keeps a card of each task up to date.",
    copy: "Copy the prompt",
    copied: "Copied",
    hint: "Paste it into your agent. It installs Ghostly and sends you a link.",
    connect: "Or connect it by hand",
  },
  /** The animated chat (components/agents/AgentDemo.tsx). The times are the story's, not a clock's. */
  demo: {
    label:
      "An agent at work in a Ghostly chat: it thinks, posts a task card that runs to done, asks to merge with two buttons, you tap Merge, it closes the question, then a routine card.",
    bot: "Casper",
    online: "online",
    thinking: "thinking",
    ask: "Can you fix the relay rotation bug?",
    status: "Reading the relay logs",
    reply: "On it. I'll keep a card here up to date.",
    composer: "Message",
    task: "Fix relay rotation",
    statuses: { queued: "Queued", running: "Running", done: "Done" },
    steps: "{done} of {total} steps",
    now: "Now:",
    doing: ["Writing the codec", "Running the tests", "Waiting for CI"],
    elapsed: { queued: "queued for {d}", running: "running for {d}", took: "took {d}" },
    pr: "PR #612",
    /** The question, its buttons (`send --button merge:Merge --button wait:Later --style merge=primary --once`). */
    question: "CI is green. Merge PR #612?",
    buttons: [
      { id: "merge", label: "Merge", style: "primary" },
      { id: "wait", label: "Later", style: "neutral" },
    ],
    closed: "Closed",
    routine: "Nightly bug hunt",
    schedule: "every day 01:00",
    last: "Last run OK",
    next: "next in 9 h",
    captions: [
      "You ask",
      "It thinks",
      "It takes the task",
      "It keeps it current",
      "Done, with its PR",
      "It asks with buttons",
      "You tap Merge",
      "It takes your answer",
      "Its nightly routine",
    ],
    still: "An agent at work",
    pause: "Pause",
    play: "Play",
  },
  show: {
    eyebrow: "In the app",
    title: "What your agent can show",
    lead: "The same chat in the Ghostly app, with a bot on the ghostly CLI. Tap a card for its steps and pull request.",
    shotAlt:
      "Boo's chat with Casper, an agent: a question, Casper's answer, a task card Done with its steps and PR #612, a routine card, a second task running for 12 min, and Casper thinking",
    caption: "Ghostly {n} on the web, with a bot on the CLI",
    cmdLabel: "Copy",
    copied: "Copied",
  },
  connect: {
    eyebrow: "Connect your agent",
    title: "Three steps in a terminal",
    lead: "Or let your agent run them itself:",
    toPrompt: "the prompt",
    copy: "Copy",
    copied: "Copied",
    note: "Cards and buttons come with ghostly {n}. ghostly help task and ghostly help send say whether yours has them.",
    cards: "What a card holds: WISP 405 · Status Cards",
    buttons: "Buttons: WISP 406 · Message Buttons",
  },
  prompt: {
    eyebrow: "The prompt",
    title: "Or let your agent do it",
    lead: "Copy this into Claude Code, Codex, Hermes or any agent with a shell. It reads the skill, installs the CLI, sends you a link and answers you there.",
    label: "Prompt for your agent",
    copy: "Copy",
    copied: "Copied",
    note: "Change Casper to any name you like.",
  },
  how: {
    title: "How it works",
    lead: "What the prompt has your agent do, with the headless ghostly CLI.",
    details: "Details",
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
        { id: "safe", label: "Safety", title: "Your words stay data", body: "Only you can wake it. Your text never lands in a command, and keys are never printed." },
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
      cards: "Task and routine cards, kept current with task update and routine update",
      buttons: "Buttons under a question: send --button, --style and --once, the button.pressed event, and button update --chosen, --close or --text",
      mentions: "Groups: woken by an @mention, answered with group send --mention",
      answers: "Replies, voice notes, files and reactions to answer with",
      calls: "Voice calls, the audio as raw PCM for your program",
      claude: "A Claude Code example: claude -p with no tools, woken once per turn",
      hermes: "A Hermes Agent gateway plugin",
      socket: "Turns and the allowlist on the daemon's socket",
      wake: "wake/1 for agents: woken with no listener running",
    } as Record<string, string>,
  },
  safety: {
    title: "Contact text is data, never instructions",
    body: "Everything a contact writes arrives under untrusted, on stdin, never in a command's arguments. A prompt can tell the agent not to follow it but cannot make it, so allowlist only yourself (--from owner), and let a model with no tools answer anyone else or any group, as the Claude Code example does. send refuses text that looks like a seed, a key or ecash unless --force, which an agent never adds because someone asks. Real payments need --confirm-real, and only the wallet's owner gives it.",
  },
  links: {
    title: "Read more",
    skill: "Agent skill (SKILL.md)",
    guide: "Agents guide",
    cards: "WISP 405 · Status Cards",
    buttons: "WISP 406 · Message Buttons",
    cliGuide: "CLI guide",
    readme: "Every command (CLI README)",
    claude: "Claude Code example",
    cli: "The CLI",
    wisp: "WISP 1100: the contract",
  },
};

export const scope = SCOPE;
