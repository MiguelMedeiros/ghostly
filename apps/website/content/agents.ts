import type { Level } from "@/lib/status";
import agentPrompt from "@/lib/agent-prompt.json";

/**
 * /developers/agents: what a bot can do in a Ghostly chat, who can give it work, how to connect one, and the prompt
 * that does it for you (docs/AI-AGENTS.md, #426 and #431). The prompt is written once, in docs/AI-AGENTS.md
 * (scripts/agent-prompt.mjs cuts it out). Every command here is one `ghostly help` lists
 * (packages/cli/test/agentDocs.test.ts checks them); what a card holds is WISP 405 · Status Cards, linked, never
 * restated. Each control in SECURITY is one the CLI has: the comment beside it names the code.
 */

const REPO = "https://github.com/MiguelMedeiros/ghostly";
const DOCS = `${REPO}/blob/main`;

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
export const TURN = `{"seq":41,"id":"agent.turn:message.received:f3gg…:t_5d0c…","type":"agent.turn",
 "source":"message.received","chat":"f3gg…","messageId":"t_5d0c…",
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
  safe: `${DOCS}/docs/AI-AGENTS.md#safe-setup`,
  repo: REPO,
  license: `${DOCS}/LICENSE`,
  releases: `${REPO}/releases`,
  advisories: `${REPO}/security/advisories`,
  policy: `${DOCS}/.github/SECURITY.md`,
  verify: `${DOCS}/docs/INSTALLATION.md#desktop-app`,
  queue: `${DOCS}/docs/TESTING.md#the-merge-queue`,
  threat: "/developers/agents/threat-model",
  /** The agents FAQ, written in a sibling pull request: its path until that one lands. */
  faq: "/agents/faq",
  llms: "/llms.txt",
  testing: `${DOCS}/docs/TESTING.md`,
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

/**
 * The security model, up front: who can give the agent work, and what it does before it acts. Each card is a control
 * the CLI has; the comment names the code, and the PR that wrote this page cites each one.
 */
export const SECURITY = [
  // packages/cli/src/listen.ts (Allowlist.allows, checked before --exec, --webhook or the output; groups by id only).
  {
    id: "allowlist",
    title: "Only you can wake it",
    body: "listen --from is an allowlist, checked before the agent wakes. A message from anyone else stays in the chat and never reaches your agent. Allow a group only for an agent with no tools: any member who mentions it can wake it.",
    cmd: "ghostly listen --turns --from owner",
  },
  // packages/browser/src/engine/node.ts (a paired chat refuses another key) and packages/core/src/dhtDelivery.ts.
  {
    id: "invite",
    title: "Your invite, yours alone",
    body: "An invite pairs with the first app that opens it, and the chat keeps that key. A copy of the link opened later is refused. Open yours right away, and remove a chat you no longer use.",
    cmd: "ghostly chat remove <chat> --yes",
  },
  // packages/cli/src/listen.ts (toTurn: the sender's words under untrusted; checkWebhook: loopback only).
  {
    id: "data",
    title: "Text is data, not commands",
    body: "What a person writes arrives under untrusted, on stdin, never in a command's arguments. A webhook can only point at this machine.",
    cmd: "ghostly listen --turns --from owner --exec ./on-turn.sh",
  },
  // packages/browser/src/shared/buttons.ts (only the chat's contact presses), packages/cli/src/events.ts (by).
  {
    id: "approve",
    title: "It asks, you approve",
    body: "Have your agent ask before a merge, a deploy or anything you want to check, and wait for your tap. Only the person in the chat can press, and the event says who did. --once takes one answer.",
    cmd: 'ghostly send owner --button go:Deploy --button stop:Stop --style go=primary --once "Deploy to staging?"',
  },
  // packages/cli/src/runtime/engine.ts (automaticWallets: false); packages/cli/src/wallets.ts (Testnet, --confirm-real).
  {
    id: "wallet",
    title: "No wallet unless you make one",
    body: "A CLI profile starts with no wallet, and no payment request is paid by itself. A wallet you create is on Testnet unless you say otherwise, and real money needs --confirm-real on the agent's machine.",
    cmd: "ghostly wallet list",
  },
  // packages/cli/examples/claude-code-agent.sh (no tools, no MCP servers, none of your settings).
  {
    id: "least",
    title: "Give it the least",
    body: "Ghostly holds only its own chat keys, never your cloud or repo credentials. Keep production keys out of the agent's shell, and answer anyone but you with a model that has no tools.",
    cmd: 'claude -p --tools "" --strict-mcp-config --setting-sources ""',
  },
] as const;

/** What you can check before you trust it: each line true today, each with its link. */
export const TRUST = [
  { id: "license", text: "MIT license. Every line is on GitHub.", link: "repo", label: "The code" },
  { id: "signed", text: "Signed releases: checksums signed with a published GPG key, desktop updates signed, and the CLI on npm with provenance.", link: "verify", label: "Check a download" },
  { id: "advisories", text: "Security fixes are published as advisories.", link: "advisories", label: "Advisories" },
  { id: "report", text: "You can report a flaw privately, and I fix it before it is public.", link: "policy", label: "Security policy" },
  { id: "tests", text: "More than 11,000 unit tests, 1,000 end-to-end tests and 390 Rust tests.", link: "testing", label: "How it is tested" },
  { id: "ci", text: "Nothing lands on the development branch until CI passes on a branch up to date with it.", link: "queue", label: "The merge queue" },
] as const;

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
      "Follow and steer your AI agents from your phone, in a private encrypted chat. Only your chat can give them work, and you approve steps with a tap.",
  },
  hero: {
    eyebrow: "AI agents",
    title: "Your agents, on your phone.",
    lead: "A private, end-to-end encrypted chat between you and your agents, with no Ghostly server and no account. From your phone or your desktop you see what they do, answer their questions with a tap, and approve or stop their work.",
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
  security: {
    eyebrow: "Security model",
    title: "Only you can give it work",
    lead: "Ghostly is the channel to your agent, not the agent. These are its controls, and the one limit no channel can remove.",
    limitTitle: "The limit, said plainly",
    limit:
      "A language model can be talked into things by text it reads, and no prompt can stop that. The allowlist decides whose text reaches your agent, so allow only yourself. Keep production credentials out of the agent's reach too, and a stranger has nothing to steer it with.",
    more: "Safe setup, in detail",
    threat: "The threat model",
  },
  fit: {
    eyebrow: "Fit",
    title: "Is it for you?",
    forTitle: "For",
    notTitle: "Not for",
    for: [
      "Following your own agents from anywhere: what they are doing, what they need, and your answer.",
      "Approving or stopping a step with one tap, away from your desk.",
      "One person, or a few, each with agents on their own machines.",
    ],
    not: [
      "A ticket tracker. It does not replace Jira.",
      "A team chat. It does not replace Teams or Slack.",
      "An orchestrator. It does not run or schedule your agents, and it does not connect to Jira, Bitbucket or AWS. Your agent does that work; Ghostly is how you talk to it.",
    ],
  },
  trust: {
    eyebrow: "What you can check",
    title: "Before you trust it",
    lead: "Things you can verify yourself, each with its link.",
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
    threat: "Threat model for agents",
    faq: "Agents FAQ",
    llms: "llms.txt, for AI readers",
  },
};

export const scope = SCOPE;
