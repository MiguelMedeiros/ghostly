import type { Localized } from "@/lib/i18n";
import type { Level } from "@/lib/status";

/**
 * The roadmap as a timeline: columns in the order things happen, rows by area.
 * No dates: a column is a stage, not a quarter. "Today" is where Ghostly
 * stands (the 0.5.0 release on `dev`); every column after it is future work,
 * checked against the code (see content/roadmap.ts).
 */
export const PHASES = ["now", "planned", "later"] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_LEVEL: Record<Phase, Level> = {
  now: "available",
  planned: "planned",
  later: "planned",
};

type Item = string | { text: string; level: Level };
type Lane = { id: string; color: string; title: string; items: Partial<Record<Phase, Item[]>> };
type Timeline = {
  mapTitle: string;
  mapLead: string;
  timelineTitle: string;
  timelineLead: string;
  detailsTitle: string;
  grid: {
    presets: string;
    selectHint: string;
    enables: string;
    specs: string;
    noSpec: string;
    docs: string;
    included: string;
    close: string;
    stages: { title: string; play: string; pause: string; names: Record<Level, string> };
  };
  phases: Record<Phase, { title: string; sub: string }>;
  here: string;
  empty: string;
  lanes: Lane[];
};

const en: Timeline = {
  mapTitle: "The map",
  mapLead: "Every piece of Ghostly, by area. Start from today, then move along the stages to see what comes next.",
  timelineTitle: "Stage by stage",
  timelineLead: "Left to right is the order things happen. No dates: a column is a stage, not a quarter.",
  detailsTitle: "Why this order? Dependencies and what \"done\" means",
  grid: {
    presets: "Stages",
    selectHint: "Tap any block to see what it lets you do and where it is specified.",
    enables: "What it enables",
    specs: "Specified in",
    noSpec: "No WISP yet",
    docs: "Reference",
    included: "{n} of {t} pieces",
    close: "Close",
    stages: {
      title: "Stages",
      play: "Play the evolution",
      pause: "Pause",
      names: { available: "Today", planned: "Planned", research: "Research" },
    },
  },
  phases: {
    now: { title: "Today", sub: "What the app does now" },
    planned: { title: "Next steps", sub: "In order of what they depend on" },
    later: { title: "Horizon", sub: "Long-term vision and open questions" },
  },
  here: "We are here",
  empty: "None",
  lanes: [
    {
      id: "talk",
      color: "#22d3ee",
      title: "Chat & connection",
      items: {
        now: ["Chats: files, payments, local apps", "Short texts over the DHT when the live link drops", "Calls with Ghostly 0.4 contacts", "Iroh and HyperDHT on desktop", "QR invitations", "Pairing progress you can watch", "Voice messages"],
        planned: ["DHT start and self-upgrade in every chat", "ghostly1 invite codes", "Calls in every chat", "Local network discovery, QUIC and WebSocket relay profiles"],
        later: [{ text: "Tor, libp2p, Pear components", level: "research" }],
      },
    },
    {
      id: "pay",
      color: "#fbbf24",
      title: "Payments",
      items: {
        now: ["Cashu and Lightning, from your own source too", "Lightning addresses, paying from any wallet", "Ark, Spark, Fedimint, USDT, on-chain (experimental)", "Testnet mode for every wallet"],
        planned: ["Mainnet for Bark, Breez, BDK and Fedimint", "Unilateral exit for Ark", "Liquid and other rails"],
      },
    },
    {
      id: "keep",
      color: "#4ade80",
      title: "Profiles & backup",
      items: {
        now: ["Local profiles", "Sealed backups to a file or S3", "Messages held for an away contact"],
        planned: ["Scheduled backups and retention", "More storage places"],
      },
    },
    {
      id: "identity",
      color: "#f472b6",
      title: "Identity (optional)",
      items: {
        now: ["Proofs: Nostr · domain · OpenPGP · SSH · Bitcoin address", "Nostr social layer"],
        planned: ["OpenID accounts, once Ghostly's clients are registered", "Hardware signers, passkeys"],
        later: [{ text: "Pubky and Keet, and their profiles and content", level: "research" }],
      },
    },
    {
      id: "groups",
      color: "#fb923c",
      title: "Groups",
      items: {
        now: ["Private groups (8) and communities (256)", "A group picture, payments between members"],
        planned: ["Files and calls in groups", "More than one admin"],
        later: ["Channels and topics", { text: "Group encryption beyond epoch keys (MLS)", level: "research" }],
      },
    },
    {
      id: "sdk",
      color: "#a78bfa",
      title: "SDKs & plugins",
      items: {
        now: ["Open contracts (WISP drafts)", "@ghostly/sdk and plugins"],
        planned: ["Adapter manifests, the SDK on npm", "Package authenticity and updates"],
        later: [{ text: "A permissioned plugin host", level: "research" }],
      },
    },
    {
      id: "eco",
      color: "#94a3b8",
      title: "Apps & self-hosting",
      items: {
        later: ["Mini-apps and P2P games", "Independent catalogs and indexers", "Always-on self-hosted runtime (even a Raspberry Pi)", "Ghostly OS"],
      },
    },
  ],
};

const ptBr: Timeline = {
  mapTitle: "O mapa",
  mapLead: "Todas as peças do Ghostly, por área. Comece por hoje e avance pelas etapas para ver o que vem depois.",
  timelineTitle: "Etapa por etapa",
  timelineLead: "Da esquerda para a direita é a ordem em que as coisas acontecem. Sem datas: uma coluna é uma etapa, não um trimestre.",
  detailsTitle: "Por que nesta ordem? Dependências e o que significa \"pronto\"",
  grid: {
    presets: "Etapas",
    selectHint: "Toque em qualquer bloco para ver o que ele permite fazer e onde está especificado.",
    enables: "O que permite",
    specs: "Especificado em",
    noSpec: "Ainda sem WISP",
    docs: "Referência",
    included: "{n} de {t} peças",
    close: "Fechar",
    stages: {
      title: "Etapas",
      play: "Ver a evolução",
      pause: "Pausar",
      names: { available: "Hoje", planned: "Planejado", research: "Pesquisa" },
    },
  },
  phases: {
    now: { title: "Hoje", sub: "O que o app faz agora" },
    planned: { title: "Próximos passos", sub: "Na ordem do que depende de quê" },
    later: { title: "Horizonte", sub: "Visão de longo prazo e perguntas em aberto" },
  },
  here: "Estamos aqui",
  empty: "Nenhum",
  lanes: [
    {
      id: "talk",
      color: "#22d3ee",
      title: "Conversa e conexão",
      items: {
        now: ["Chats: arquivos, pagamentos, apps locais", "Textos curtos pela DHT quando o link direto cai", "Chamadas com contatos no Ghostly 0.4", "Iroh e HyperDHT no desktop", "Convites por QR", "Progresso do pareamento à vista", "Mensagens de voz"],
        planned: ["Início na DHT e upgrade sozinho em todo chat", "Códigos de convite ghostly1", "Chamadas em todo chat", "Descoberta na rede local, perfis QUIC e relay WebSocket"],
        later: [{ text: "Tor, libp2p, componentes Pear", level: "research" }],
      },
    },
    {
      id: "pay",
      color: "#fbbf24",
      title: "Pagamentos",
      items: {
        now: ["Cashu e Lightning, também da sua própria fonte", "Lightning addresses, pagar com qualquer carteira", "Ark, Spark, Fedimint, USDT, on-chain (experimentais)", "Modo Testnet para todas as carteiras"],
        planned: ["Mainnet para Bark, Breez, BDK e Fedimint", "Saída unilateral no Ark", "Liquid e outros trilhos"],
      },
    },
    {
      id: "keep",
      color: "#4ade80",
      title: "Perfis e backup",
      items: {
        now: ["Perfis locais", "Backups selados em arquivo ou S3", "Mensagens guardadas para um contato ausente"],
        planned: ["Backups agendados e retenção", "Mais lugares de armazenamento"],
      },
    },
    {
      id: "identity",
      color: "#f472b6",
      title: "Identidade (opcional)",
      items: {
        now: ["Provas: Nostr · domínio · OpenPGP · SSH · endereço Bitcoin", "Camada social do Nostr"],
        planned: ["Contas OpenID, quando os clientes do Ghostly forem registrados", "Signers de hardware, passkeys"],
        later: [{ text: "Pubky e Keet, com os perfis e conteúdos deles", level: "research" }],
      },
    },
    {
      id: "groups",
      color: "#fb923c",
      title: "Grupos",
      items: {
        now: ["Grupos privados (8) e comunidades (256)", "Foto do grupo, pagamentos entre membros"],
        planned: ["Arquivos e chamadas em grupos", "Mais de um admin"],
        later: ["Canais e tópicos", { text: "Criptografia de grupo além das chaves por época (MLS)", level: "research" }],
      },
    },
    {
      id: "sdk",
      color: "#a78bfa",
      title: "SDKs e plugins",
      items: {
        now: ["Contratos abertos (rascunhos WISP)", "@ghostly/sdk e plugins"],
        planned: ["Manifestos de adapters, o SDK no npm", "Autenticidade de pacotes e atualizações"],
        later: [{ text: "Um host de plugins com permissões", level: "research" }],
      },
    },
    {
      id: "eco",
      color: "#94a3b8",
      title: "Apps e auto-hospedagem",
      items: {
        later: ["Miniapps e jogos P2P", "Catálogos e indexadores independentes", "Runtime auto-hospedado sempre ligado (até num Raspberry Pi)", "Ghostly OS"],
      },
    },
  ],
};

export const timeline: Localized<Timeline> = { en, "pt-br": ptBr };
