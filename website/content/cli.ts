import type { Localized } from "@/lib/i18n";
import type { Level } from "@/lib/status";

/**
 * /cli: the headless `ghostly` (@ghostly/cli, packages/cli, WISP 11xx). Short on
 * purpose: a pitch, the install line, four commands, a bot and links. The long
 * version is docs/CLI.md. Checked against packages/cli on `dev`.
 */

const DOCS = "https://github.com/MiguelMedeiros/ghostly/blob/dev";

/** One line: builds the package from a clone and installs it (it is not on npm yet). */
export const INSTALL =
  "git clone https://github.com/MiguelMedeiros/ghostly && cd ghostly && npm install && npm run build -w @ghostly/cli && npm pack -w @ghostly/cli && npm install -g ./ghostly-cli-*.tgz";

/** A session, as the terminal in the hero shows it. Output shapes from packages/cli/README.md. */
export const SESSION = `$ ghostly daemon --detach
$ ghostly invite create --label casper
{"invite":"ghostly1…","link":"https://ghostly.tools/#ghostly1…"}
$ ghostly send casper "Boo! 👻"
{"messageId":"me_…","delivery":"sending"}
$ ghostly listen
{"type":"message.received","message":{"text":"deploy?"}}`;

/** packages/cli/examples/echo-bot.sh, without its comments. */
export const ECHO_BOT = `ghostly listen --type message.received --cursor ~/.ghostly/echo.cursor --exec '
  event="$(cat)"
  printf "echo: %s" "$(jq -r .message.text <<<"$event")" \\
    | ghostly send "$(jq -r .chat <<<"$event")" --stdin'`;

export const COMMANDS = [
  "ghostly daemon --detach",
  "ghostly invite create --label alice",
  'ghostly send alice "hello"',
  "ghostly listen",
] as const;

export const LINKS = {
  guide: `${DOCS}/docs/CLI.md`,
  reference: `${DOCS}/packages/cli/README.md`,
  agents: `${DOCS}/docs/AI-AGENTS.md`,
  paymentBot: `${DOCS}/packages/cli/examples/payment-bot.mjs`,
  echoBot: `${DOCS}/packages/cli/examples/echo-bot.sh`,
  legacy: `${DOCS}/cli/README.md`,
} as const;

/** What it covers, one level each (the site's levels; see lib/status.ts). */
const SCOPE: { level: Level; key: string }[] = [
  { level: "available", key: "chats" },
  { level: "available", key: "groups" },
  { level: "available", key: "files" },
  { level: "available", key: "pay" },
  { level: "available", key: "ids" },
  { level: "available", key: "services" },
  { level: "planned", key: "npm" },
  { level: "planned", key: "dht" },
  { level: "planned", key: "wallets" },
  { level: "planned", key: "binary" },
];

const en = {
  meta: {
    title: "Ghostly CLI: the app's engine for bots",
    description:
      "ghostly runs the Ghostly app's own engine without a screen: invites, chats, groups, files and payments for scripts, bots and AI agents, with every event as a JSON line.",
  },
  hero: {
    eyebrow: "Command line",
    title: "Ghostly for bots.",
    lead: "ghostly runs the app's own engine without a screen. Your script gets the same invites, chats, groups and payments as the app, and every event as a JSON line.",
    install: "Install",
    guide: "Full guide",
    term: "Example ghostly session",
  },
  install: {
    title: "Install",
    hint: "Node 22.12 or newer. Built from source until the npm package is published.",
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
      groups: "Groups, with mentions and admin tools",
      files: "Files and voice notes",
      pay: "Wallets and payments (Mainnet only with --confirm-real)",
      ids: "Identity proofs",
      services: "Shared web apps",
      npm: "An npm release",
      dht: "Reading the DHT directly (relays for now)",
      wallets: "Bark and Fedimint wallets",
      binary: "A single binary, without Node",
    } as Record<string, string>,
  },
  links: {
    title: "Read more",
    guide: "Guide",
    reference: "Every command and event",
    agents: "Skill for AI agents",
    wisp: "WISP 11xx: the contract",
  },
  legacy: {
    title: "Looking for ghostly-cli?",
    body: "The Rust ghostly-cli is the compatibility client for v0.4 chats. It reads only ghost:// invites and cannot pair with the app. It keeps working for bots built on it.",
    link: "ghostly-cli",
  },
};

export type CliCopy = typeof en;

const ptBr: CliCopy = {
  meta: {
    title: "Ghostly CLI: o motor do app para bots",
    description:
      "ghostly roda o motor do próprio app Ghostly sem tela: convites, chats, grupos, arquivos e pagamentos para scripts, bots e agentes de IA, com cada evento numa linha JSON.",
  },
  hero: {
    eyebrow: "Linha de comando",
    title: "Ghostly para bots.",
    lead: "ghostly roda o motor do próprio app sem tela. Seu script ganha os mesmos convites, chats, grupos e pagamentos do app, e cada evento numa linha JSON.",
    install: "Instalar",
    guide: "Guia completo",
    term: "Exemplo de sessão do ghostly",
  },
  install: {
    title: "Instalar",
    hint: "Node 22.12 ou mais novo. Compilado do código até o pacote npm ser publicado.",
    copy: "Copiar",
    copied: "Copiado",
  },
  commands: {
    title: "Quatro comandos",
    hints: [
      "Mantém seu perfil online.",
      "Um convite ghostly1 que abre no app.",
      "Envia uma mensagem. Todo comando responde em JSON.",
      "Transmite os eventos, uma linha JSON cada.",
    ],
  },
  bot: {
    title: "Um bot de eco",
    lead: "Cada evento chega no stdin do gancho, nunca nos argumentos, então o texto de um contato não alcança o shell.",
    payment: "Um bot de pagamentos, com moedas de teste",
    echo: "O bot de eco",
  },
  scope: {
    title: "O que ele cobre",
    items: {
      chats: "Convites e um só chat, pelos transportes do app",
      groups: "Grupos, com menções e ferramentas de admin",
      files: "Arquivos e mensagens de voz",
      pay: "Carteiras e pagamentos (Mainnet só com --confirm-real)",
      ids: "Provas de identidade",
      services: "Apps web compartilhados",
      npm: "Uma versão no npm",
      dht: "Ler a DHT direto (por enquanto, relays)",
      wallets: "Carteiras Bark e Fedimint",
      binary: "Um binário único, sem Node",
    },
  },
  links: {
    title: "Leia mais",
    guide: "Guia (em inglês)",
    reference: "Todos os comandos e eventos (em inglês)",
    agents: "Skill para agentes de IA (em inglês)",
    wisp: "WISP 11xx: o contrato",
  },
  legacy: {
    title: "Procurando o ghostly-cli?",
    body: "O ghostly-cli em Rust é o cliente de compatibilidade para chats da v0.4. Ele só lê convites ghost:// e não pareia com o app. Continua funcionando para os bots feitos com ele.",
    link: "ghostly-cli",
  },
};

export const cli: Localized<CliCopy> = { en, "pt-br": ptBr };
export const scope = SCOPE;
