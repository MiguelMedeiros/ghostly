import type { Level } from "./status";
import type { Localized } from "./i18n";

/**
 * The pieces of the architecture, as blocks for the composer on /developers
 * and the map on /roadmap. Levels were checked in the code (v0.4.0 on `main`
 * = released; merged on `dev` = development, shipping in 0.5.0; see
 * lib/wisp-editorial.ts for the same rule). `wisps` point at the drafts by
 * file slug so a renumbering follows; `refs` at other reference documents.
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
  { id: "groups", color: "#fb923c", title: { en: "Groups", "pt-br": "Grupos" } },
  { id: "ecosystem", color: "#94a3b8", title: { en: "SDK, apps & catalogs", "pt-br": "SDK, apps e catálogos" } },
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

/** " · " that never starts a line: block names wrap as a whole. */
const D = " · ";

export const BLOCKS: Block[] = [
  // Rendezvous, keys & negotiation
  b("core", "base", "Ghost core", "released", ["01-ghost-core"], "Find a peer through small signed records on Pkarr / Mainline DHT.", "Encontrar um peer por pequenos registros assinados no Pkarr / DHT Mainline."),
  b("keys", "base", "Peer keys", "released", ["02-peer-keys"], "A fresh participation key per connection. Paired chats also pin the other side's key.", "Uma chave de participação nova por conexão. Chats pareados também fixam a chave do outro lado."),
  b("invite", "base", "Invitations", "released", ["800-invite-join", "801-invitation-profiles"], "Turn a private link or code into a mutually admitted connection.", "Transformar um link ou código privado numa conexão admitida pelos dois lados."),
  b("qrinvite", "base", "QR invitations", "development", ["801-invitation-profiles"], "The paired invitation as a QR code to scan: the same code as the one you copy.", "O convite pareado como um QR code para escanear: o mesmo código que você copia."),
  b("caps", "base", "Capabilities", "development", ["03-capabilities"], "Both sides offer versioned abilities (chat/1, files/2, payments-cashu/1, hold/1 …) and use only the ones they share.", "Os dois lados oferecem capacidades versionadas (chat/1, files/2, payments-cashu/1, hold/1 …) e usam só as que têm em comum."),

  // Transports
  b("webrtc", "transport", "WebRTC", "released", ["100-transports", "101-webrtc"], "A data channel every Ghostly app has: browser, extension, desktop.", "Um canal de dados que todo app Ghostly tem: navegador, extensão, desktop."),
  b("iroh", "transport", "Iroh", "development", ["100-transports", "102-iroh"], "QUIC between desktop apps, bound to Ghostly authentication. In paired chats, after a first WebRTC pairing.", "QUIC entre apps desktop, amarrado à autenticação do Ghostly. Em chats pareados, depois de um primeiro pareamento por WebRTC."),
  b("hyperdht", "transport", "HyperDHT", "development", ["100-transports", "103-hyperdht"], "An authenticated Noise stream found through HyperDHT, between desktop apps.", "Um fluxo Noise autenticado encontrado pela HyperDHT, entre apps desktop."),
  b("dhttext", "transport", "DHT text", "released", ["403-dht-text"], "Very short text in DHT records when no live link is up. Bounded, not a mailbox.", "Textos bem curtos em registros da DHT quando não há link ao vivo. Limitado, não é caixa postal."),
  b("tor", "transport", "Tor", "research", [], "Reaching peers over Tor. An open question, not a plan yet.", "Alcançar peers pelo Tor. Uma pergunta em aberto, ainda não um plano.", ["adapter-roadmap"]),

  // Chat, files & media
  b("chat", "talk", "Chat", "released", ["400-chat", "402-legacy-chat"], "Messages with storage receipts and retries, over a live link or the bounded DHT path.", "Mensagens com confirmação de armazenamento e novas tentativas, por um link ao vivo ou pelo caminho limitado da DHT."),
  b("paired", "talk", "Paired chats", "development", ["401-paired-chat", "501-paired-files"], "Authenticated one-to-one chats: pinned keys, a durable outbox, names and pictures, negotiated files. No calls in them yet.", "Chats um a um autenticados: chaves fixadas, caixa de saída durável, nomes e fotos, arquivos negociados. Ainda sem chamadas neles."),
  b("hold", "talk", "Held messages", "development", ["4xx-store-and-forward"], "Text, a file up to 8 MiB or a Cashu/Lightning request, held for an away contact in your own S3 bucket and found through a DHT pointer. Opt-in per chat; up to seven days after you were last online.", "Texto, um arquivo de até 8 MiB ou um pedido Cashu/Lightning, guardados para um contato ausente no seu próprio bucket S3 e achados por um ponteiro na DHT. Opcional por chat; até sete dias depois da sua última vez online."),
  b("files", "talk", "Files", "released", ["500-files", "502-legacy-files"], "Verified transfers up to 100 MiB while both peers are online.", "Transferências verificadas de até 100 MiB com os dois peers online."),
  b("media", "talk", "Voice & video", "released", ["600-media", "601-webrtc-media"], "One-to-one calls and screen sharing over WebRTC media, in unpaired chats.", "Chamadas um a um e compartilhamento de tela por mídia WebRTC, nos chats não pareados."),

  // Payments
  b("cashu", "pay", "Cashu", "released", ["200-payments", "201-cashu"], "Ecash tokens in the chat; a mint you choose holds the funds.", "Tokens de ecash no chat; um mint escolhido por você guarda os fundos."),
  b("lightning", "pay", "Lightning", "released", ["203-lightning"], "Invoices in the chat, paid and received through the Cashu mint in v0.4.0.", "Faturas no chat, pagas e recebidas pelo mint Cashu na v0.4.0."),
  b("lnproviders", "pay", "Lightning sources", "development", ["203-lightning"], "Your own node or wallet as the Lightning source: NWC, LND, Core Lightning, a browser wallet (WebLN, web app only), Breez (Testnet only).", "Seu próprio nó ou carteira como fonte Lightning: NWC, LND, Core Lightning, uma carteira do navegador (WebLN, só no app web), Breez (só em Testnet)."),
  b("lnurl", "pay", "Lightning addresses", "development", ["205-lnurl"], "Pay name@domain or an LNURL through your Lightning source, from the wallet or from a chat. Paying only: receiving on an address needs a server.", "Pagar nome@domínio ou um LNURL pela sua fonte Lightning, da carteira ou de um chat. Só pagar: receber num endereço exige um servidor."),
  b("external", "pay", "Pay from any wallet", "development", ["200-payments"], "A request paid by a wallet that is not Ghostly: QR, text or a lightning:/bitcoin: link. The payee's own source confirms it, never the payer's word.", "Um pedido pago por uma carteira que não é o Ghostly: QR, texto ou um link lightning:/bitcoin:. Quem confirma é a fonte de quem recebe, nunca a palavra de quem paga."),
  b("onchain", "pay", `On-chain${D}BDK${D}Bitcoin Core`, "development", [], "Plain bitcoin in a chat, through a BDK wallet (test networks) or your own Bitcoin Core node (desktop).", "Bitcoin on-chain no chat, por uma carteira BDK (redes de teste) ou pelo seu próprio nó Bitcoin Core (desktop).", ["adapter-roadmap"]),
  b("arkade", "pay", `Ark${D}Arkade`, "development", ["202-arkade"], "Exact Ark payments through a pinned operator. Experimental; unilateral exit is still a release gate.", "Pagamentos Ark exatos por um operador fixado. Experimental; a saída unilateral ainda é requisito de lançamento."),
  b("bark", "pay", `Ark${D}Bark`, "development", ["204-bark"], "A second Ark provider (Second's Bark), test networks only. Its own method and capability, not interchangeable with Arkade.", "Um segundo provedor de Ark (o Bark, da Second), só em redes de teste. Método e capacidade próprios, não é intercambiável com o Arkade."),
  b("usdt", "pay", `USDT${D}WDK`, "development", [], "USDT on Ethereum through Tether WDK, signed locally. Experimental; no WISP number.", "USDT na Ethereum via Tether WDK, assinado localmente. Experimental; sem número de WISP.", ["usdt-integration"]),
  b("testnet", "pay", "Testnet mode", "development", [], "Every wallet on test networks together, with nothing real at stake. Mainnet and Testnet keep separate sources.", "Todas as carteiras em redes de teste, juntas, sem nada real em jogo. Mainnet e Testnet guardam fontes separadas."),

  // Identity proofs & social
  b("proofs", "identity", "Identity proofs", "development", ["300-peer-proofs"], "Optionally prove to one contact that you control an outside identity: made once, shared per chat, revocable.", "Provar, se quiser, a um contato que você controla uma identidade externa: feita uma vez, compartilhada por chat, revogável."),
  b("nostr", "identity", "Nostr", "development", ["301-nostr"], "A Nostr proof through a NIP-07 extension or a NIP-46 signer: a proof, not a transport.", "Uma prova Nostr por uma extensão NIP-07 ou um signer NIP-46: uma prova, não um transporte."),
  b("proofkinds", "identity", `Domain${D}OpenPGP${D}SSH${D}Bitcoin`, "development", ["3xx-domain", "3xx-openpgp", "3xx-ssh", "3xx-bitcoin"], "Self-custodied proofs made once with your own tools: a DNS record, gpg, ssh-keygen, a wallet's BIP-322 signature.", "Provas sob seu controle, feitas uma vez com as suas ferramentas: um registro DNS, gpg, ssh-keygen, uma assinatura BIP-322 da carteira."),
  b("oidc", "identity", "OpenID accounts", "development", ["3xx-oidc-proofs"], "An account at Google, Microsoft, Apple, GitLab or Twitch, attested by that provider. Not offered until Ghostly's clients are registered.", "Uma conta no Google, Microsoft, Apple, GitLab ou Twitch, atestada por esse provedor. Só é oferecida quando os clientes do Ghostly forem registrados."),
  b("social", "identity", "Nostr social", "development", ["3xx-nostr-social"], "Behind a verified Nostr proof: a contact's profile, follows and notes, loaded when you ask. Publishing is off until you turn it on, and each post is confirmed.", "Atrás de uma prova Nostr verificada: perfil, quem segue e notas de um contato, carregados quando você pede. Publicar fica desligado até você ligar, e cada post é confirmado."),
  b("pubky", "identity", "Pubky", "research", ["302-pubky"], "A Pubky binding. Using Pkarr alone is not a Pubky integration.", "Um vínculo Pubky. Usar Pkarr, sozinho, não é integração com Pubky."),
  b("keet", "identity", "Keet", "research", ["303-keet"], "A Keet relationship; blocked on a signer API for existing accounts.", "Uma relação com o Keet; depende de uma API de assinatura para contas existentes."),

  // Local services
  b("http", "services", "Local HTTP apps", "released", ["700-local-services", "701-http-services"], "A contact opens a web app running on your computer; you can take it back. Desktop and extension.", "Um contato abre um app web que roda no seu computador; você pode retirar o acesso. Desktop e extensão."),

  // Profiles, backup & storage
  b("profiles", "keep", "Local profiles", "development", ["04-profiles"], "Separate lives on one device, never announced to contacts.", "Vidas separadas no mesmo aparelho, sem anunciar isso aos contatos."),
  b("backups", "keep", "Backups", "development", ["05-backups"], "A whole profile in one passphrase-sealed bundle; a restore always creates a new profile.", "Um perfil inteiro num pacote selado por senha; uma restauração sempre cria um perfil novo."),
  b("storage", "keep", `Storage: file${D}S3`, "development", ["1000-storage", "1001-local-storage", "1002-s3-storage"], "Where sealed bundles wait: a file you keep or an S3-compatible bucket, which also holds messages for an away contact.", "Onde os pacotes selados esperam: um arquivo seu ou um bucket compatível com S3, que também guarda mensagens para um contato ausente."),

  // Groups
  b("groups", "groups", "Private groups", "development", ["900-group-sessions", "9xx-group-mesh", "9xx-group-community"], "Two kinds, text only: a private mesh of up to eight, and a community of up to 256 whose link anyone can open, let in by any member through hubs the members elect. Keys change whenever someone leaves, so whoever is out reads nothing after. Web, extension and desktop.", "Dois tipos, só texto: uma malha privada de até oito, e uma comunidade de até 256 cujo link qualquer um abre, admitida por qualquer membro por hubs que os membros elegem. As chaves mudam quando alguém sai, então quem está fora não lê mais nada. Web, extensão e desktop."),
  b("gossipsub", "groups", "GossipSub", "planned", ["901-gossipsub"], "A candidate distribution layer for larger groups, off the DHT.", "Uma camada candidata de distribuição para grupos maiores, fora da DHT."),

  // SDK, apps & catalogs
  b("sdk", "ecosystem", "@ghostly/sdk", "development", [], "Write a wallet source or an identity proof outside the app, test it with the contract suites, and it joins the pickers as a plugin: no registry line. Not on npm yet.", "Escreva uma fonte de carteira ou uma prova de identidade fora do app, teste com as suítes de contrato, e ela entra nos seletores como plugin: sem linha no registro. Ainda fora do npm.", ["sdk"]),
  b("apps", "ecosystem", "Apps & catalogs", "planned", [], "Mini-apps, games and independent catalogs, possibly with indexers.", "Miniapps, jogos e catálogos independentes, talvez com indexadores.", ["adapter-roadmap"]),
  b("os", "ecosystem", "Self-hosted runtime", "planned", [], "An always-on personal node, even a Raspberry Pi, running your Ghostly.", "Um nó pessoal sempre ligado, até um Raspberry Pi, rodando o seu Ghostly.", ["adapter-roadmap"]),
];

export type PresetId = "cli" | "minimal" | "released" | "next" | "horizon";

export const PRESETS: { id: PresetId; blocks: (bl: Block) => boolean; title: Localized<string>; blurb: Localized<string> }[] = [
  {
    id: "minimal",
    blocks: (bl) => ["core", "keys", "invite", "webrtc", "chat"].includes(bl.id),
    title: { en: "A minimal client", "pt-br": "Um cliente mínimo" },
    blurb: {
      en: "Five pieces make a private text chat over WebRTC. Everything else can stay out.",
      "pt-br": "Cinco peças fazem um chat de texto privado por WebRTC. Todo o resto pode ficar de fora.",
    },
  },
  {
    id: "cli",
    blocks: (bl) => ["core", "keys", "invite", "dhttext", "chat"].includes(bl.id),
    title: { en: "The CLI today", "pt-br": "A CLI hoje" },
    blurb: {
      en: "The real command-line client: short text over DHT records, no live transport. Its invitations don't open in the app.",
      "pt-br": "O cliente de linha de comando real: textos curtos por registros na DHT, sem transporte ao vivo. Os convites dela não abrem no app.",
    },
  },
  {
    id: "released",
    blocks: (bl) => bl.level === "released",
    title: { en: "Public release", "pt-br": "Versão pública" },
    blurb: {
      en: "What v0.4.0 composes: chat, files and calls over WebRTC or DHT text, Cashu with Lightning through the mint, local HTTP apps.",
      "pt-br": "O que a v0.4.0 compõe: chat, arquivos e chamadas por WebRTC ou texto na DHT, Cashu com Lightning pelo mint, apps HTTP locais.",
    },
  },
  {
    id: "next",
    blocks: (bl) => bl.level === "released" || bl.level === "development",
    title: { en: "Next · 0.5.0", "pt-br": "Próxima · 0.5.0" },
    blurb: {
      en: "Merged on dev, not yet released: paired chats, private groups, held messages, profiles and backups, your own wallets, identity proofs with Nostr social, and the SDK.",
      "pt-br": "Integrado na dev, ainda não lançado: chats pareados, grupos privados, mensagens guardadas, perfis e backups, suas próprias carteiras, provas de identidade com o social do Nostr, e o SDK.",
    },
  },
  {
    id: "horizon",
    blocks: () => true,
    title: { en: "Horizon", "pt-br": "Horizonte" },
    blurb: {
      en: "Everything on the board, including what is planned or still a question. Not a promise.",
      "pt-br": "Tudo no tabuleiro, inclusive o que está planejado ou ainda é pergunta. Não é promessa.",
    },
  },
];
