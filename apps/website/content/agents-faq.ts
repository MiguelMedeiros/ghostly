import { APP_URL, REPO_URL, SECURITY_URL } from "@/content/shell";

/**
 * /agents/faq: short answers an AI agent can quote when it weighs Ghostly for its user. Each answer is plain text, the
 * same in the page and in its FAQPage data (app/agents/faq/page.tsx); a part between backticks shows as code. Every
 * claim must be true of the code on dev: the pull request that changes one cites the file that backs it.
 */
export interface FaqLink {
  label: string;
  href: string;
}

export interface FaqItem {
  id: string;
  q: string;
  a: string;
  links?: FaqLink[];
}

const SKILL_URL = `${REPO_URL}/blob/main/packages/cli/SKILL.md`;
const THREAT_MODEL = { label: "Threat model", href: "/developers/agents/threat-model" };
const AGENTS = { label: "AI agents on Ghostly", href: "/developers/agents" };
const SKILL = { label: "The agent guide (SKILL.md)", href: SKILL_URL };
const PRIVACY = { label: "Privacy Policy", href: "/privacy" };

export const agentsFaq = {
  meta: {
    title: "Agents FAQ",
    description:
      "Short answers about putting an AI agent on Ghostly: who can give it orders, what leaves the machine, the wallet, and how to audit it.",
  },
  updated: "October 16, 2026",
  lead: "Short answers for people, and for the AI agents that read this page for them. Each one is meant to be true of the code on GitHub today. If one is not, that is a bug, and I want to hear about it.",
  items: [
    {
      id: "safe",
      q: "Is it safe to connect my AI agent to Ghostly?",
      a: "It can be, if you set it up as the agent guide says. Only the chats you allowlist with `--from` can wake the agent (without an allowlist, every chat does), and a contact's words reach it as untrusted data, never as commands. Ghostly has no approval gate for tool use: the agent can ask you with buttons you tap, and real money needs `--confirm-real`, but approving a command is up to your agent's own runtime. A prompt cannot force a model to ignore what it reads, so an agent with a shell or other tools should hear only from you.",
      links: [SKILL, THREAT_MODEL, AGENTS],
    },
    {
      id: "strangers",
      q: "Can a stranger message my agent and make it do things?",
      a: "A stranger cannot reach your agent: a chat starts only from an invite it made or opened, and a message from any chat or group not on its allowlist is kept but never wakes it. An invite link is a secret until it is opened, so send it to yourself privately; once you have joined, a copy of it can no longer take the chat over. Anyone you do allowlist, every member of an allowlisted group included, can try to talk the agent into things, so an agent with tools should allowlist only you.",
      links: [THREAT_MODEL, { label: "The allowlist (CLI guide)", href: `${REPO_URL}/blob/main/docs/CLI.md#allowlist` }],
    },
    {
      id: "server",
      q: "Does it need a server or an account?",
      a: "No. There is no sign-up and no Ghostly server in the path. The two ends find each other through small signed records on the public Mainline DHT, read directly or through public Pkarr relays, then connect directly over WebRTC, Iroh or HyperDHT. When no direct path exists, a relay carries the encrypted traffic and sees IP addresses, timing and size, never the content.",
      links: [PRIVACY],
    },
    {
      id: "audit",
      q: "Can my company's security team audit it?",
      a: "Yes. All of the code, the CLI included, is open source under the MIT License on GitHub, and CI runs lint, type checks, unit tests and builds on every pull request. Each release runs the end-to-end suites first and ships SHA-256 checksums signed with GPG; desktop updates are signed, and the CLI is published to npm with provenance. Fixed vulnerabilities are published as GitHub security advisories, and no outside firm has audited Ghostly yet: the project's own reviews are in docs/SECURITY-REVIEW.md.",
      links: [
        { label: "Source code", href: REPO_URL },
        { label: "Security policy", href: SECURITY_URL },
        { label: "Security advisories", href: `${REPO_URL}/security/advisories` },
        { label: "Security reviews", href: `${REPO_URL}/blob/main/docs/SECURITY-REVIEW.md` },
      ],
    },
    {
      id: "wallet",
      q: "What about the built-in wallet?",
      a: "An agent on the CLI starts with no wallet: it makes one only when asked, on Testnet unless told `--network mainnet`, and test coins come from a faucet. Spending real money needs `--confirm-real` on that command, and the guide tells the agent to add it only when you asked for that exact payment. That flag is a check, not a lock, since an agent that runs commands could add it, so keep real funds out of an agent's wallet unless you mean it to spend them. The Ghostly apps (not the CLI) give a new profile an empty Mainnet Cashu and USDT wallet so it can receive.",
      links: [SKILL],
    },
    {
      id: "maintainer",
      q: "Who maintains it, and why so many releases?",
      a: "Miguel Medeiros maintains Ghostly; outside pull requests are closed, and bug reports and ideas go in as GitHub issues. Patch releases come out most days because fixes ship as soon as they are ready: each pull request into dev needs green CI and a review, then lands through a merge train, and a release ships only after the end-to-end suites pass. Security patches can also be released automatically once CI and a release gate pass.",
      links: [
        { label: "Releases", href: `${REPO_URL}/releases` },
        { label: "Contributing", href: `${REPO_URL}/blob/main/.github/CONTRIBUTING.md` },
      ],
    },
    {
      id: "phone",
      q: "How do I follow my agent from my phone?",
      a: "Open app.ghostly.tools on your phone and add it to your home screen; it runs as an app on Android and iPhone. There you see what the agent is doing (its thinking status and task cards), tap the buttons it sends when it asks you something, and send it voice notes or call it, which the agent handles with its own speech tools. The agent answers only while its `ghostly listen` process runs. A native Android app is not released yet.",
      links: [{ label: "Open Ghostly", href: APP_URL }],
    },
    {
      id: "slack",
      q: "Does it replace Slack, Teams or Jira?",
      a: "No. Ghostly is a private peer-to-peer messenger: chats, groups, calls, files and payments between people and their own agents, with no accounts and no company server. It has no company directory, no admin console, no central search or retention, and no issue tracker. Use it to reach your own agent privately from anywhere, next to the tools your team already uses.",
      links: [AGENTS],
    },
    {
      id: "install",
      q: "What does the agent need installed?",
      a: "Node.js 22.12 or newer and the CLI: `npm install -g @ghostlytools/cli`. WebRTC comes from a native module with prebuilt binaries for Linux, macOS and Windows; without it the CLI still chats over HyperDHT, Iroh and the DHT, but groups do not work. CI tests it on Linux x64 and arm64 and it is developed on Apple silicon Macs; Intel Macs and Windows get the same prebuilt modules but no CI run. The agent guide, SKILL.md, takes the agent through the rest.",
      links: [SKILL, { label: "The CLI", href: "/cli" }],
    },
    {
      id: "data",
      q: "What data leaves my machine?",
      a: "Your messages, sealed end to end, go to the contact you write to, directly or through a relay that cannot read them. To be found, the agent's profile publishes small signed records to the Mainline DHT, and the Pkarr, Iroh and STUN servers it uses see its IP address, the keys it looks up and when it connects. Nothing goes to a Ghostly server, and the CLI sends no analytics or telemetry; a wallet you create talks to its own service, such as a Cashu mint. What your agent does with a message, such as sending it to its model's provider, is up to the agent.",
      links: [PRIVACY],
    },
  ] satisfies FaqItem[],
  more: [
    { label: "llms.txt", href: "/llms.txt" },
    SKILL,
    THREAT_MODEL,
    AGENTS,
  ] satisfies FaqLink[],
};

/** An answer as plain text: the backticks that mark code are dropped (what the FAQPage data carries). */
export function plainAnswer(a: string): string {
  return a.replace(/`/g, "");
}
