import type { Level } from "./status";
import type { Localized } from "./i18n";

/**
 * The pieces of the architecture, as blocks for the composer on /developers
 * and the map on /roadmap. Levels were checked in the code on `dev` (the 0.5.0
 * release): what runs there is "available"; see lib/wisp-editorial.ts for the
 * same rule. `wisps` point at the drafts by
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
  b("core", "base", "Ghost core", "available", ["01-ghost-core"], "Find a peer through small signed records on Pkarr / Mainline DHT.", "Encontrar um peer por pequenos registros assinados no Pkarr / DHT Mainline."),
  b("keys", "base", "Peer keys", "available", ["02-peer-keys"], "A fresh participation key per connection; every chat pins the other side's key.", "Uma chave de participação nova por conexão; todo chat fixa a chave do outro lado."),
  b("invite", "base", "Invitations", "available", ["800-invite-join", "801-invitation-profiles"], "Turn a private link or code into a mutually admitted connection.", "Transformar um link ou código privado numa conexão admitida pelos dois lados."),
  b("qrinvite", "base", "QR invitations", "available", ["801-invitation-profiles"], "The invitation as a QR code to scan: the same code as the one you copy.", "O convite como um QR code para escanear: o mesmo código que você copia."),
  b("ghostly1", "base", "ghostly1 invite", "available", ["800-invite-join", "801-invitation-profiles"], "One invite code, ghostly1…, checked for typos, and a ghostly.tools link that opens the app.", "Um único código de convite, ghostly1…, que detecta erros de digitação, e um link em ghostly.tools que abre o app."),
  b("caps", "base", "Capabilities", "available", ["03-capabilities"], "Both sides offer versioned abilities (chat/1, files/2, payments-cashu/1, hold/1 …) and use only the ones they share.", "Os dois lados oferecem capacidades versionadas (chat/1, files/2, payments-cashu/1, hold/1 …) e usam só as que têm em comum."),

  // Transports
  b("webrtc", "transport", "WebRTC", "available", ["100-transports", "101-webrtc"], "A data channel in the browser, the extension and the desktop app, except on Linux, whose webview has no WebRTC.", "Um canal de dados no navegador, na extensão e no app desktop, menos no Linux, cujo webview não tem WebRTC."),
  b("iroh", "transport", "Iroh", "available", ["100-transports", "102-iroh"], "QUIC bound to Ghostly authentication: direct between desktop apps, and relay only in the web app and extension, through n0's public relays unless you set others.", "QUIC amarrado à autenticação do Ghostly: direto entre apps desktop, e só por relay no app web e na extensão, pelos relays públicos da n0 a menos que você defina outros."),
  b("hyperdht", "transport", "HyperDHT", "available", ["100-transports", "103-hyperdht"], "An authenticated Noise stream found through HyperDHT, between desktop apps. The web app and extension reach it only through a relay you set: none runs by default.", "Um fluxo Noise autenticado encontrado pela HyperDHT, entre apps desktop. O app web e a extensão só chegam nela por um relay que você define: nenhum roda por padrão."),
  b("dhttext", "transport", "DHT text", "available", ["403-dht-text"], "The floor of every chat: very short text in DHT records when no live link is up. Bounded, not a mailbox.", "O piso de todo chat: textos bem curtos em registros da DHT quando não há link direto. Limitado, não é caixa postal."),
  b("tor", "transport", "Tor", "research", [], "Reaching peers over Tor. An open question, not a plan yet.", "Alcançar peers pelo Tor. Uma pergunta em aberto, ainda não um plano.", ["adapter-roadmap"]),

  // Chat, files & media
  b("chat", "talk", "Chat", "available", ["400-chat"], "One kind of chat: messages with storage receipts and retries, over a live link or through the DHT.", "Um só tipo de chat: mensagens com confirmação de armazenamento e novas tentativas, por um link direto ou pela DHT."),
  b("paired", "talk", "Chat sessions", "available", ["401-paired-chat", "501-paired-files"], "The live session of every chat: pinned keys, a durable outbox, names and pictures, negotiated files, calls and shared apps.", "A sessão ao vivo de todo chat: chaves fixadas, caixa de saída durável, nomes e fotos, arquivos negociados, chamadas e apps compartilhados."),
  b("compat", "talk", "Compatibility chats", "available", ["402-legacy-chat", "502-legacy-files"], "Chats with Ghostly 0.4 contacts and the CLI keep their older wire: DHT text and, on a live link, files and calls. Never created for a new chat.", "Chats com contatos no Ghostly 0.4 e a CLI mantêm o formato antigo: texto pela DHT e, num link direto, arquivos e chamadas. Nunca criados para um chat novo."),
  b("onechat", "talk", "DHT fallback and upgrade", "available", ["400-chat", "403-dht-text", "100-transports"], "A first pairing with no direct path starts on the DHT, and every chat moves to a live link by itself when one connects.", "Um primeiro pareamento sem caminho direto começa na DHT, e todo chat passa sozinho para um link direto quando algum conecta."),
  b("callsall", "talk", "Calls in every chat", "available", ["600-media", "401-paired-chat"], "Voice, video and screen sharing in the chat session while it is live, not only with Ghostly 0.4 contacts.", "Voz, vídeo e tela compartilhada na sessão do chat enquanto ela está ao vivo, não só com contatos no Ghostly 0.4."),
  b("hold", "talk", "Held messages", "available", ["4xx-store-and-forward"], "Text, a file up to 8 MiB or a Cashu/Lightning request, held for an away contact in your own S3 bucket and found through a DHT pointer. Opt-in per chat; up to seven days after you were last online.", "Texto, um arquivo de até 8 MiB ou um pedido Cashu/Lightning, guardados para um contato ausente no seu próprio bucket S3 e achados por um ponteiro na DHT. Opcional por chat; até sete dias depois da sua última vez online."),
  b("files", "talk", "Files", "available", ["500-files", "501-paired-files"], "Verified transfers of any size while both peers are online, picked up where they stopped; above 25 MB the receiver accepts first. A voice message is a file too.", "Transferências verificadas de qualquer tamanho com os dois peers online, retomadas de onde pararam; acima de 25 MB quem recebe aceita antes. Uma mensagem de voz também é um arquivo."),
  b("media", "talk", "Voice & video", "available", ["600-media", "601-webrtc-media"], "One-to-one calls and screen sharing over WebRTC media, in every chat while it is live. Not on Linux desktops, which have no WebRTC.", "Chamadas um a um e compartilhamento de tela por mídia WebRTC, em todo chat enquanto ele está ao vivo. Não no desktop Linux, que não tem WebRTC."),

  // Payments
  b("cashu", "pay", "Cashu", "available", ["200-payments", "201-cashu"], "Ecash tokens in the chat; a mint you choose holds the funds.", "Tokens de ecash no chat; um mint escolhido por você guarda os fundos."),
  b("lightning", "pay", "Lightning", "available", ["203-lightning"], "Invoices in the chat, paid and received through your Cashu mint or your own Lightning source.", "Faturas no chat, pagas e recebidas pelo seu mint Cashu ou pela sua própria fonte Lightning."),
  b("lnproviders", "pay", "Lightning sources", "available", ["203-lightning"], "Your own node or wallet as the Lightning source: NWC, LND, Core Lightning, a browser wallet (WebLN, web app only), Breez (regtest only) or a Fedimint federation (test networks only).", "Seu próprio nó ou carteira como fonte Lightning: NWC, LND, Core Lightning, uma carteira do navegador (WebLN, só no app web), Breez (só regtest) ou uma federação Fedimint (só redes de teste)."),
  b("lnurl", "pay", "Lightning addresses", "available", ["205-lnurl"], "Pay name@domain or an LNURL through your Lightning source, from the wallet or from a chat. Paying only: receiving on an address needs a server.", "Pagar nome@domínio ou um LNURL pela sua fonte Lightning, da carteira ou de um chat. Só pagar: receber num endereço exige um servidor."),
  b("external", "pay", "Pay from any wallet", "available", ["200-payments"], "A request paid by a wallet that is not Ghostly: QR, text or a lightning:/bitcoin: link. The payee's own source confirms it, never the payer's word.", "Um pedido pago por uma carteira que não é o Ghostly: QR, texto ou um link lightning:/bitcoin:. Quem confirma é a fonte de quem recebe, nunca a palavra de quem paga."),
  b("onchain", "pay", `On-chain${D}BDK${D}Bitcoin Core`, "available", [], "Plain bitcoin in a chat, through a BDK wallet (test networks) or your own Bitcoin Core node (desktop).", "Bitcoin on-chain no chat, por uma carteira BDK (redes de teste) ou pelo seu próprio nó Bitcoin Core (desktop).", ["adapter-roadmap"]),
  b("arkade", "pay", `Ark${D}Arkade`, "available", ["202-arkade"], "Exact Ark payments through a pinned operator, on Bitcoin mainnet by default. Experimental: payments were tested on regtest only, and there is no unilateral exit yet.", "Pagamentos Ark exatos por um operador fixado, na mainnet do Bitcoin por padrão. Experimental: os pagamentos foram testados só em regtest, e ainda não há saída unilateral."),
  b("bark", "pay", `Ark${D}Bark`, "available", ["204-bark"], "A second Ark provider (Second's Bark), test networks only. Its own method and capability, not interchangeable with Arkade.", "Um segundo provedor de Ark (o Bark, da Second), só em redes de teste. Método e capacidade próprios, não é intercambiável com o Arkade."),
  b("spark", "pay", "Spark", "available", ["2xx-spark"], "Spark to Spark, wallet to wallet, on the same seed as the Breez Lightning source. Testnet opens a regtest wallet; Mainnet needs your own Breez API key.", "Spark para Spark, de carteira para carteira, na mesma seed da fonte Lightning Breez. A Testnet abre uma carteira regtest; a Mainnet exige a sua própria chave de API da Breez."),
  b("fedimint", "pay", "Fedimint", "available", ["2xx-fedimint"], "Ecash from a federation you join by invite code, in a chat and as a Lightning source through its gateway. Test networks only: Mainnet joins nothing yet.", "Ecash de uma federação em que você entra por código de convite, no chat e como fonte Lightning pelo gateway dela. Só redes de teste: a Mainnet ainda não entra em nenhuma."),
  b("usdt", "pay", `USDT${D}WDK`, "available", [], "USDT on Ethereum through Tether WDK, signed locally. Experimental; no WISP number.", "USDT na Ethereum via Tether WDK, assinado localmente. Experimental; sem número de WISP.", ["usdt-integration"]),
  b("testnet", "pay", "Testnet mode", "available", [], "Every wallet on test networks together, with nothing real at stake. Mainnet and Testnet keep separate sources.", "Todas as carteiras em redes de teste, juntas, sem nada real em jogo. Mainnet e Testnet guardam fontes separadas."),

  // Identity proofs & social
  b("proofs", "identity", "Identity proofs", "available", ["300-peer-proofs"], "Optionally prove to one contact that you control an outside identity: made once, shared per chat, revocable.", "Provar, se quiser, a um contato que você controla uma identidade externa: feita uma vez, compartilhada por chat, revogável."),
  b("nostr", "identity", "Nostr", "available", ["301-nostr"], "A Nostr proof through a NIP-07 extension or a NIP-46 signer: a proof, not a transport.", "Uma prova Nostr por uma extensão NIP-07 ou um signer NIP-46: uma prova, não um transporte."),
  b("proofkinds", "identity", `Domain${D}OpenPGP${D}SSH${D}Bitcoin`, "available", ["3xx-domain", "3xx-openpgp", "3xx-ssh", "3xx-bitcoin"], "Self-custodied proofs made once with your own tools: a DNS record, gpg, ssh-keygen, a wallet's BIP-322 signature.", "Provas sob seu controle, feitas uma vez com as suas ferramentas: um registro DNS, gpg, ssh-keygen, uma assinatura BIP-322 da carteira."),
  b("oidc", "identity", "OpenID accounts", "planned", ["3xx-oidc-proofs"], "An account at Google, Microsoft, Apple, GitLab or Twitch, attested by that provider. Built, and offered once Ghostly's OAuth clients are registered.", "Uma conta no Google, Microsoft, Apple, GitLab ou Twitch, atestada por esse provedor. Pronta, e oferecida quando os clientes OAuth do Ghostly forem registrados."),
  b("social", "identity", "Nostr social", "available", ["3xx-nostr-social"], "Behind a verified Nostr proof: a contact's profile, follows and notes, loaded when you ask. Publishing is off until you turn it on, and each post is confirmed.", "Atrás de uma prova Nostr verificada: perfil, quem segue e notas de um contato, carregados quando você pede. Publicar fica desligado até você ligar, e cada post é confirmado."),
  b("did", "identity", "DIDs", "available", ["3xx-did-dht", "3xx-did"], "Every profile has a did:dht of its own, listing an identity only if you switch it on; and a DID you control (did:key, did:jwk, did:dht, did:web) is proven like any identity.", "Todo perfil tem um did:dht próprio, com uma identidade listada só se você ligar; e um DID que você controla (did:key, did:jwk, did:dht, did:web) é provado como qualquer identidade."),
  b("pubky", "identity", "Pubky", "planned", ["302-pubky"], "A Pubky identity approved in Pubky Ring or Passport, in implementation (#246). Using Pkarr alone is not a Pubky integration.", "Uma identidade Pubky aprovada no Pubky Ring ou no Passport, em implementação (#246). Usar Pkarr, sozinho, não é integração com Pubky."),
  b("keet", "identity", "Keet", "planned", ["303-keet"], "A Keet relationship; blocked on a signer API for existing accounts.", "Uma relação com o Keet; depende de uma API de assinatura para contas existentes."),

  // Local services
  b("http", "services", "Local HTTP apps", "available", ["700-local-services", "701-http-services"], "A contact opens a web app running on your computer; you choose who sees each app and can take it back. Desktop and extension.", "Um contato abre um app web que roda no seu computador; você escolhe quem vê cada app e pode retirar o acesso. Desktop e extensão."),

  // Profiles, backup & storage
  b("profiles", "keep", "Local profiles", "available", ["04-profiles"], "Separate lives on one device, never announced to contacts.", "Vidas separadas no mesmo aparelho, sem anunciar isso aos contatos."),
  b("backups", "keep", "Backups", "available", ["05-backups"], "A whole profile in one passphrase-sealed bundle; a restore always creates a new profile.", "Um perfil inteiro num pacote selado por senha; uma restauração sempre cria um perfil novo."),
  b("storage", "keep", `Storage: file${D}S3`, "available", ["1000-storage", "1001-local-storage", "1002-s3-storage"], "Where sealed bundles wait: a file you keep or an S3-compatible bucket, which also holds messages for an away contact.", "Onde os pacotes selados esperam: um arquivo seu ou um bucket compatível com S3, que também guarda mensagens para um contato ausente."),

  // Groups
  b("groups", "groups", "Groups", "available", ["900-group-sessions", "9xx-group-mesh", "9xx-group-community"], "Two kinds: a private group of up to eight, and a community of up to 256 whose link anyone can open, let in by any member through hubs the members elect. Text, a picture and payments between members; no files or calls. Keys change whenever someone leaves, so whoever is out reads nothing after. Web, extension and desktop.", "Dois tipos: um grupo privado de até oito, e uma comunidade de até 256 cujo link qualquer um abre, admitida por qualquer membro por hubs que os membros elegem. Texto, uma foto e pagamentos entre membros; sem arquivos nem chamadas. As chaves mudam quando alguém sai, então quem está fora não lê mais nada. Web, extensão e desktop."),
  b("gossipsub", "groups", "GossipSub", "planned", ["901-gossipsub"], "A candidate distribution layer for larger groups, off the DHT.", "Uma camada candidata de distribuição para grupos maiores, fora da DHT."),

  // SDK, apps & catalogs
  b("sdk", "ecosystem", "@ghostly/sdk", "available", [], "Write a wallet source or an identity proof outside the app, test it with the contract suites, and it joins the pickers as a plugin: no registry line. Not on npm yet.", "Escreva uma fonte de carteira ou uma prova de identidade fora do app, teste com as suítes de contrato, e ela entra nos seletores como plugin: sem linha no registro. Ainda fora do npm.", ["sdk"]),
  b("apps", "ecosystem", "Apps & catalogs", "planned", [], "Mini-apps, games and independent catalogs, possibly with indexers.", "Miniapps, jogos e catálogos independentes, talvez com indexadores.", ["adapter-roadmap"]),
  b("os", "ecosystem", "Self-hosted runtime", "planned", [], "An always-on personal node, even a Raspberry Pi, running your Ghostly.", "Um nó pessoal sempre ligado, até um Raspberry Pi, rodando o seu Ghostly.", ["adapter-roadmap"]),
];

export type PresetId = "cli" | "minimal" | "today" | "horizon";

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
    blocks: (bl) => ["core", "keys", "invite", "compat"].includes(bl.id),
    title: { en: "The CLI today", "pt-br": "A CLI hoje" },
    blurb: {
      en: "The real command-line client: short text over DHT records, no live transport. Its invitations don't open in the app.",
      "pt-br": "O cliente de linha de comando real: textos curtos por registros na DHT, sem transporte ao vivo. Os convites dela não abrem no app.",
    },
  },
  {
    id: "today",
    blocks: (bl) => bl.level === "available",
    title: { en: "Ghostly today", "pt-br": "O Ghostly hoje" },
    blurb: {
      en: "Everything the app runs: one-to-one chats, groups and communities, held messages, profiles and backups, many ways to pay, identity proofs with Nostr social, local apps and the SDK.",
      "pt-br": "Tudo o que o app roda: chats um a um, grupos e comunidades, mensagens guardadas, perfis e backups, muitas formas de pagar, provas de identidade com o social do Nostr, apps locais e o SDK.",
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
