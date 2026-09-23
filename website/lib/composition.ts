import type { Level } from "./status";
import type { Localized } from "./i18n";

/**
 * The pieces of the architecture, as blocks for the composer on /developers.
 * Levels were checked in the code (see lib/wisp-editorial.ts for the same
 * rule); `wisps` point at the drafts by file slug so a renumbering follows.
 */
export type DimId = "base" | "transport" | "talk" | "pay" | "identity" | "services" | "keep" | "groups" | "ecosystem";

export const DIMS: { id: DimId; color: string; title: Localized<string> }[] = [
  { id: "base", color: "#22d3ee", title: { en: "Rendezvous, keys & negotiation", "pt-br": "Encontro, chaves e negociação" } },
  { id: "transport", color: "#60a5fa", title: { en: "Transports", "pt-br": "Transportes" } },
  { id: "talk", color: "#a78bfa", title: { en: "Chat, files & media", "pt-br": "Chat, arquivos e mídia" } },
  { id: "pay", color: "#fbbf24", title: { en: "Payments", "pt-br": "Pagamentos" } },
  { id: "identity", color: "#f472b6", title: { en: "Identity proofs & social", "pt-br": "Provas de identidade e social" } },
  { id: "services", color: "#2dd4bf", title: { en: "Local services", "pt-br": "Serviços locais" } },
  { id: "keep", color: "#4ade80", title: { en: "Profiles, backup & storage", "pt-br": "Perfis, backup e armazenamento" } },
  { id: "groups", color: "#fb923c", title: { en: "Groups & distribution", "pt-br": "Grupos e distribuição" } },
  { id: "ecosystem", color: "#94a3b8", title: { en: "Plugins, apps & catalogs", "pt-br": "Plugins, apps e catálogos" } },
];

export type Block = {
  id: string;
  dim: DimId;
  name: string;
  level: Level;
  wisps: string[];
  /** Other reference documents (reader slugs) when no WISP number exists. */
  refs?: string[];
  enables: Localized<string>;
};

const b = (id: string, dim: DimId, name: string, level: Level, wisps: string[], en: string, pt: string, refs?: string[]): Block => ({
  id,
  dim,
  name,
  level,
  wisps,
  refs,
  enables: { en, "pt-br": pt },
});

export const BLOCKS: Block[] = [
  b("core", "base", "Ghost core", "released", ["01-ghost-core"], "Find a peer through small signed records on Pkarr / Mainline DHT.", "Encontrar um peer por pequenos registros assinados no Pkarr / DHT Mainline."),
  b("keys", "base", "Peer keys", "released", ["02-peer-keys"], "A fresh participation key per connection; paired chats pin the other side's key.", "Uma chave de participação nova por conexão; chats pareados fixam a chave do outro lado."),
  b("invite", "base", "Invitations", "released", ["800-invite-join", "801-invitation-profiles"], "Turn a private link, QR or code into a mutually admitted connection.", "Transformar um link, QR ou código privado numa conexão admitida pelos dois lados."),
  b("caps", "base", "Capabilities", "development", ["03-capabilities"], "Announce versioned abilities and use only the ones both sides share.", "Anunciar capacidades versionadas e usar só as que os dois lados têm."),

  b("webrtc", "transport", "WebRTC", "released", ["100-transports", "101-webrtc"], "A data channel every Ghostly app has: browser, extension, desktop.", "Um canal de dados que todo app Ghostly tem: navegador, extensão, desktop."),
  b("iroh", "transport", "Iroh", "development", ["100-transports", "102-iroh"], "QUIC between desktop apps, bound to Ghostly authentication.", "QUIC entre apps desktop, amarrado à autenticação do Ghostly."),
  b("hyperdht", "transport", "HyperDHT", "development", ["100-transports", "103-hyperdht"], "An authenticated Noise stream found through HyperDHT, on desktop.", "Um fluxo Noise autenticado encontrado pela HyperDHT, no desktop."),
  b("dhttext", "transport", "DHT text", "released", ["403-dht-text"], "Very short text in DHT records when no live link is up. Bounded, not a mailbox.", "Textos bem curtos em registros da DHT quando não há link ao vivo. Limitado, não é caixa postal."),
  b("tor", "transport", "Tor", "research", [], "Reaching peers over Tor. An open question, not a plan yet.", "Alcançar peers pelo Tor. Uma pergunta em aberto, ainda não um plano.", ["adapter-roadmap"]),

  b("chat", "talk", "Chat", "released", ["400-chat", "401-paired-chat", "402-legacy-chat"], "Messages with storage receipts and retries; paired chats add names and pictures.", "Mensagens com confirmação de armazenamento e novas tentativas; chats pareados somam nomes e fotos."),
  b("files", "talk", "Files", "released", ["500-files", "501-paired-files", "502-legacy-files"], "Verified transfers up to 100 MiB while both peers are online.", "Transferências verificadas de até 100 MiB com os dois peers online."),
  b("media", "talk", "Voice & video", "released", ["600-media", "601-webrtc-media"], "One-to-one calls and screen sharing over WebRTC media.", "Chamadas um a um e compartilhamento de tela por mídia WebRTC."),

  b("cashu", "pay", "Cashu", "released", ["200-payments", "201-cashu"], "Ecash tokens in the chat; a mint you choose holds the funds.", "Tokens de ecash no chat; um mint escolhido por você guarda os fundos."),
  b("lightning", "pay", "Lightning", "released", ["203-lightning"], "Invoices in the chat, paid and received through the Cashu mint today.", "Faturas no chat, pagas e recebidas pelo mint Cashu hoje."),
  b("arkade", "pay", "Ark · Arkade", "development", ["202-arkade"], "Exact Ark payments through a pinned operator. Experimental.", "Pagamentos Ark exatos por um operador fixado. Experimental."),
  b("usdt", "pay", "USDT · WDK", "development", [], "USDT on Ethereum through Tether WDK, signed locally. Experimental; no WISP number.", "USDT na Ethereum via Tether WDK, assinado localmente. Experimental; sem número de WISP.", ["usdt-integration"]),
  b("bark", "pay", "Ark · Bark", "building", [], "A second Ark provider, so Ark isn't tied to one implementation.", "Um segundo provedor de Ark, para o Ark não depender de uma implementação.", ["adapter-roadmap"]),
  b("lnproviders", "pay", "NWC · LND · CLN", "building", [], "Your own Lightning node or wallet: NWC, WebLN, LND, Core Lightning, Breez.", "Seu próprio nó ou carteira Lightning: NWC, WebLN, LND, Core Lightning, Breez.", ["adapter-roadmap"]),
  b("onchain", "pay", "On-chain", "building", [], "Plain bitcoin through BDK or your own Bitcoin Core RPC.", "Bitcoin on-chain via BDK ou o seu próprio Bitcoin Core RPC.", ["adapter-roadmap"]),

  b("proofs", "identity", "Identity proofs", "planned", ["300-peer-proofs"], "Optionally prove to one contact that you control an outside identity.", "Provar, se quiser, a um contato que você controla uma identidade externa."),
  b("nostr", "identity", "Nostr", "planned", ["301-nostr"], "A Nostr proof — a proof, not a transport, and not permission to publish.", "Uma prova Nostr — uma prova, não um transporte, nem permissão para publicar."),
  b("pubky", "identity", "Pubky", "research", ["302-pubky"], "A Pubky binding. Using Pkarr alone is not a Pubky integration.", "Um vínculo Pubky. Usar Pkarr, sozinho, não é integração com Pubky."),
  b("keet", "identity", "Keet", "research", ["303-keet"], "A Keet relationship; blocked on a signer API for existing accounts.", "Uma relação com o Keet; depende de uma API de assinatura para contas existentes."),
  b("social", "identity", "Social graph & posts", "planned", [], "Profiles, follows and posts through adapters — distinct from proving a key.", "Perfis, seguidores e posts por adapters — diferente de provar uma chave.", ["adapter-roadmap"]),

  b("http", "services", "Local HTTP apps", "released", ["700-local-services", "701-http-services"], "A contact opens a web app running on your computer; you can take it back.", "Um contato abre um app web que roda no seu computador; você pode retirar o acesso."),

  b("profiles", "keep", "Local profiles", "development", ["04-profiles"], "Separate lives on one device, never announced to contacts.", "Vidas separadas no mesmo aparelho, sem anunciar isso aos contatos."),
  b("backups", "keep", "Backups", "development", ["05-backups"], "A whole profile in one passphrase-sealed bundle.", "Um perfil inteiro num pacote selado por senha."),
  b("storage", "keep", "Storage: file · S3", "development", ["1000-storage", "1001-local-storage", "1002-s3-storage"], "Where sealed bundles wait: a file you keep or an S3-compatible bucket.", "Onde os pacotes selados esperam: um arquivo seu ou um bucket compatível com S3."),

  b("groups", "groups", "Group sessions", "planned", ["900-group-sessions"], "Sessions with more than two people, fanout kept off the DHT.", "Sessões com mais de duas pessoas, distribuição fora da DHT."),
  b("gossipsub", "groups", "GossipSub", "planned", ["901-gossipsub"], "A candidate distribution layer for groups.", "Uma camada candidata de distribuição para grupos."),

  b("sdk", "ecosystem", "SDKs & plugins", "planned", [], "Packaged adapters and interfaces others can install. A plugin is packaging, not a WISP.", "Adapters e interfaces empacotados que outros podem instalar. Plugin é embalagem, não WISP.", ["adapter-roadmap"]),
  b("apps", "ecosystem", "Apps & catalogs", "planned", [], "Mini-apps, games and independent catalogs, possibly with indexers.", "Miniapps, jogos e catálogos independentes, talvez com indexadores.", ["adapter-roadmap"]),
  b("os", "ecosystem", "Self-hosted runtime", "planned", [], "An always-on personal node — even a Raspberry Pi — running your Ghostly.", "Um nó pessoal sempre ligado — até um Raspberry Pi — rodando o seu Ghostly.", ["adapter-roadmap"]),
];

export type PresetId = "cli" | "minimal" | "released" | "next" | "horizon";

export const PRESETS: { id: PresetId; blocks: (bl: Block) => boolean; title: Localized<string>; blurb: Localized<string> }[] = [
  {
    id: "minimal",
    blocks: (bl) => ["core", "keys", "invite", "webrtc", "chat"].includes(bl.id),
    title: { en: "A minimal client", "pt-br": "Um cliente mínimo" },
    blurb: {
      en: "Five pieces are enough for a private text chat over WebRTC. Everything else can stay out.",
      "pt-br": "Cinco peças bastam para um chat de texto privado por WebRTC. Todo o resto pode ficar de fora.",
    },
  },
  {
    id: "cli",
    blocks: (bl) => ["core", "keys", "invite", "dhttext", "chat"].includes(bl.id),
    title: { en: "The CLI today", "pt-br": "A CLI hoje" },
    blurb: {
      en: "The real command-line client: rendezvous, keys, its own invitations and short text over DHT records. No live transport at all. (Its invitations don't open in the app; interop needs the keys passed by hand.)",
      "pt-br": "O cliente de linha de comando real: encontro, chaves, convites próprios e textos curtos por registros na DHT. Nenhum transporte ao vivo. (Os convites dela não abrem no app; a interoperabilidade exige passar as chaves à mão.)",
    },
  },
  {
    id: "released",
    blocks: (bl) => bl.level === "released",
    title: { en: "Ghostly, public release", "pt-br": "Ghostly, versão pública" },
    blurb: {
      en: "What the downloadable app composes today.",
      "pt-br": "O que o app disponível para download compõe hoje.",
    },
  },
  {
    id: "next",
    blocks: (bl) => bl.level === "released" || bl.level === "development",
    title: { en: "Ghostly, next release", "pt-br": "Ghostly, próxima versão" },
    blurb: {
      en: "Adds negotiated capabilities, native transports, profiles, backups, Ark and USDT — merged, not released.",
      "pt-br": "Soma capacidades negociadas, transportes nativos, perfis, backups, Ark e USDT — integrados, não lançados.",
    },
  },
  {
    id: "horizon",
    blocks: () => true,
    title: { en: "The horizon", "pt-br": "O horizonte" },
    blurb: {
      en: "Everything on the board, including what is being built, planned or still a question. Not a promise.",
      "pt-br": "Tudo no tabuleiro, inclusive o que está sendo construído, planejado ou ainda é pergunta. Não é promessa.",
    },
  },
];
