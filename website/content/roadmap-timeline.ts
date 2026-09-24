import type { Localized } from "@/lib/i18n";
import type { Level } from "@/lib/status";

/**
 * The roadmap as a timeline: columns in the order things happen, rows by area.
 * No dates — a column is a stage, not a quarter. Every item's stage matches
 * its availability as checked in the code (see content/roadmap.ts).
 */
export const PHASES = ["now", "next", "building", "planned", "later"] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_LEVEL: Record<Phase, Level> = {
  now: "released",
  next: "development",
  building: "building",
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
  mapLead: "Every piece of Ghostly, by area. Move along the stages and watch the pieces light up as they arrive.",
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
      names: { released: "Today · v0.4.0", development: "Next · 0.5.0", building: "Being built", planned: "Planned", research: "Research" },
    },
  },
  phases: {
    now: { title: "Today", sub: "Public release v0.4.0" },
    next: { title: "Next release", sub: "0.5.0 · merged, not released" },
    building: { title: "Being built", sub: "Work in progress now" },
    planned: { title: "Next steps", sub: "In order of what they depend on" },
    later: { title: "Horizon", sub: "Long-term vision and open questions" },
  },
  here: "We are here",
  empty: "—",
  lanes: [
    {
      id: "talk",
      color: "#22d3ee",
      title: "Chat & connection",
      items: {
        now: ["Private chat from an invitation", "Files up to 100 MiB", "Voice, video and screen sharing", "Share a local web app", "CLI for scripts and bots"],
        next: ["Paired chats with pinned keys", "QR invitations you can scan", "Iroh and HyperDHT on desktop"],
        planned: ["Calls and local apps inside paired chats", "Local network discovery, QUIC and WebSocket relay profiles"],
        later: [{ text: "Tor, libp2p, Pear components", level: "research" }],
      },
    },
    {
      id: "pay",
      color: "#fbbf24",
      title: "Payments",
      items: {
        now: ["Cashu wallet", "Lightning through the mint"],
        next: ["Ark via Arkade (experimental)", "USDT via Tether WDK (experimental)", "Testnet mode for every wallet", "Lightning sources: NWC · LND · Core Lightning · WebLN · Breez (regtest only)", "Ark via Bark (test networks)", "On-chain: BDK (test networks) · Bitcoin Core (desktop)"],
        planned: ["Mainnet for Bark, Breez and BDK", "Spark, Fedimint, Liquid and other rails"],
      },
    },
    {
      id: "keep",
      color: "#4ade80",
      title: "Profiles & backup",
      items: {
        now: ["App lock, themes, 8 languages"],
        next: ["Local profiles", "Sealed backups to a file or S3"],
        planned: ["Scheduled backups and retention", "More storage places", "Offline sync (store-and-forward)"],
      },
    },
    {
      id: "identity",
      color: "#f472b6",
      title: "Identity (optional)",
      items: {
        next: ["Proofs made once, shared per chat: Nostr · domain · OpenPGP · SSH · Bitcoin address", "OpenID accounts (Google, Microsoft, Apple, GitLab, Twitch) — once clients are registered"],
        planned: ["Hardware signers, passkeys"],
        later: ["Profiles, social graph and posts", { text: "Pubky and Keet", level: "research" }],
      },
    },
    {
      id: "groups",
      color: "#fb923c",
      title: "Groups",
      items: {
        planned: ["Private groups, roles and permissions"],
        later: ["Channels and topics", { text: "Group encryption", level: "research" }],
      },
    },
    {
      id: "sdk",
      color: "#a78bfa",
      title: "SDKs & plugins",
      items: {
        now: ["Open contracts (WISP drafts)"],
        planned: ["SDKs and adapter manifests", "Package authenticity and updates"],
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
  mapLead: "Todas as peças do Ghostly, por área. Avance pelas etapas e veja as peças acenderem conforme chegam.",
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
      names: { released: "Hoje · v0.4.0", development: "Próxima · 0.5.0", building: "Em construção", planned: "Planejado", research: "Pesquisa" },
    },
  },
  phases: {
    now: { title: "Hoje", sub: "Versão pública v0.4.0" },
    next: { title: "Próxima versão", sub: "0.5.0 · integrado, não lançado" },
    building: { title: "Em construção", sub: "Trabalho em andamento agora" },
    planned: { title: "Próximos passos", sub: "Na ordem do que depende de quê" },
    later: { title: "Horizonte", sub: "Visão de longo prazo e perguntas em aberto" },
  },
  here: "Estamos aqui",
  empty: "—",
  lanes: [
    {
      id: "talk",
      color: "#22d3ee",
      title: "Conversa e conexão",
      items: {
        now: ["Chat privado a partir de um convite", "Arquivos de até 100 MiB", "Voz, vídeo e compartilhamento de tela", "Compartilhar um app web local", "CLI para scripts e bots"],
        next: ["Chats pareados com chaves fixadas", "Convites por QR que dá para escanear", "Iroh e HyperDHT no desktop"],
        planned: ["Chamadas e apps locais dentro dos chats pareados", "Descoberta na rede local, perfis QUIC e relay WebSocket"],
        later: [{ text: "Tor, libp2p, componentes Pear", level: "research" }],
      },
    },
    {
      id: "pay",
      color: "#fbbf24",
      title: "Pagamentos",
      items: {
        now: ["Carteira Cashu", "Lightning pelo mint"],
        next: ["Ark via Arkade (experimental)", "USDT via Tether WDK (experimental)", "Modo Testnet para todas as carteiras", "Fontes Lightning: NWC · LND · Core Lightning · WebLN · Breez (só regtest)", "Ark via Bark (redes de teste)", "On-chain: BDK (redes de teste) · Bitcoin Core (desktop)"],
        planned: ["Mainnet para Bark, Breez e BDK", "Spark, Fedimint, Liquid e outros trilhos"],
      },
    },
    {
      id: "keep",
      color: "#4ade80",
      title: "Perfis e backup",
      items: {
        now: ["Trava do app, temas, 8 idiomas"],
        next: ["Perfis locais", "Backups selados em arquivo ou S3"],
        planned: ["Backups agendados e retenção", "Mais lugares de armazenamento", "Sincronização offline (store-and-forward)"],
      },
    },
    {
      id: "identity",
      color: "#f472b6",
      title: "Identidade (opcional)",
      items: {
        next: ["Provas feitas uma vez, compartilhadas por chat: Nostr · domínio · OpenPGP · SSH · endereço Bitcoin", "Contas OpenID (Google, Microsoft, Apple, GitLab, Twitch) — quando os clientes forem registrados"],
        planned: ["Signers de hardware, passkeys"],
        later: ["Perfis, grafo social e posts", { text: "Pubky e Keet", level: "research" }],
      },
    },
    {
      id: "groups",
      color: "#fb923c",
      title: "Grupos",
      items: {
        planned: ["Grupos privados, papéis e permissões"],
        later: ["Canais e tópicos", { text: "Criptografia de grupo", level: "research" }],
      },
    },
    {
      id: "sdk",
      color: "#a78bfa",
      title: "SDKs e plugins",
      items: {
        now: ["Contratos abertos (rascunhos WISP)"],
        planned: ["SDKs e manifestos de adapters", "Autenticidade de pacotes e atualizações"],
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
