import type { Localized } from "@/lib/i18n";
import type { Level } from "@/lib/status";

/**
 * The public roadmap: tracks in dependency order, never dates. It starts after
 * 0.5.0: "Now" is a short baseline of what the app already does, and "Next" is
 * only work that is not built. Checked against the code on `dev`.
 */
type Track = {
  id: string;
  n: string;
  title: string;
  why: string;
  now: { text: string; level: Level }[];
  next: { text: string; level: Level }[];
  gate: string;
  after: string[];
};

const en = {
  meta: {
    title: "Roadmap",
    description:
      "Where Ghostly goes after 0.5.0, in order and with dependencies: richer chats, more ways to pay, optional identities, groups, storage, SDKs and plugins, independent apps and a self-hosted runtime. No invented dates.",
  },
  eyebrow: "Public roadmap",
  title: "The ghost keeps learning.",
  lead: "It started small, learned to find someone, then new ways to talk and to trade value. What comes next is ordered by what it depends on, not by dates we'd have to invent.",
  rules: [
    "No dates. Order and dependencies only.",
    "What already exists is marked as such, not listed as future work.",
    "A candidate is not a commitment. Crediting a technology is not a partnership.",
  ],
  now: "Where it stands",
  next: "Next",
  gate: "Before it's called done",
  after: "Builds on",
  tracks: [
    {
      id: "talk",
      n: "01",
      title: "Talk in more ways",
      why: "Paired chats are the default now. Next they get what the older WebRTC chats still do better, and a few new things.",
      now: [
        { text: "Paired chats with pinned keys, files, payments and local apps", level: "available" },
        { text: "Calls and screen sharing in WebRTC chats", level: "available" },
      ],
      next: [
        { text: "Calls inside paired chats", level: "planned" },
        { text: "Voice messages", level: "planned" },
        { text: "Pairing progress you can watch while two apps find each other", level: "planned" },
      ],
      gate: "Every client tested against every other one, on each transport it offers.",
      after: [],
    },
    {
      id: "pay",
      n: "02",
      title: "More ways to pay",
      why: "One payment agreement, many wallets. Each method keeps its own rules and its own risks.",
      now: [
        { text: "Cashu and Lightning, through the mint or your own source (NWC, LND, Core Lightning, WebLN)", level: "available" },
        { text: "Lightning addresses, and paying a request from any wallet", level: "available" },
        { text: "Ark, Spark, Fedimint, USDT and on-chain bitcoin, experimental; several on test networks only", level: "available" },
      ],
      next: [
        { text: "Mainnet for Bark, Breez, BDK and Fedimint, once reviewed with real money in mind", level: "planned" },
        { text: "Unilateral exit for Ark", level: "planned" },
        { text: "Liquid and other rails", level: "planned" },
      ],
      gate: "Disposable-network settlement, fee limits, unknown-result reconciliation, and recovery or exit tested before any mainnet claim.",
      after: ["talk"],
    },
    {
      id: "reach",
      n: "03",
      title: "Reach each other in more places",
      why: "New transports widen where two people can meet. Each one is an adapter both sides must support, never a silent bridge.",
      now: [
        { text: "WebRTC everywhere; Iroh and HyperDHT between desktop apps", level: "available" },
      ],
      next: [
        { text: "Local network discovery, generic QUIC and WebSocket relay profiles", level: "planned" },
        { text: "Tor, libp2p, Pear / Holepunch components", level: "research" },
      ],
      gate: "Each adapter tested on its own platforms, with its relays and privacy trade-offs stated.",
      after: ["talk"],
    },
    {
      id: "keep",
      n: "04",
      title: "Keep things, bring them back",
      why: "Profiles, backups and held messages exist. Next is making recovery routine.",
      now: [
        { text: "Local profiles, sealed backups to a file or S3, messages held for an away contact", level: "available" },
      ],
      next: [
        { text: "Scheduled backups and retention", level: "planned" },
        { text: "More storage places (WebDAV, Blossom and others), for backups and held messages", level: "planned" },
      ],
      gate: "Restore drills across devices and versions, without overwriting anything.",
      after: ["talk"],
    },
    {
      id: "identity",
      n: "05",
      title: "Bring an identity, only if you want",
      why: "Nobody needs a public identity to talk. Proofs are optional, several can coexist, and you choose what each contact sees.",
      now: [
        { text: "Proofs made once, shared per chat: Nostr, a domain, an OpenPGP or SSH key, a Bitcoin address", level: "available" },
        { text: "Nostr social layer: profile, follows and notes; posting off by default", level: "available" },
      ],
      next: [
        { text: "OpenID accounts (Google, Microsoft, Apple, GitLab, Twitch): built, offered once Ghostly's OAuth clients are registered", level: "planned" },
        { text: "Hardware signers and passkeys", level: "planned" },
        { text: "Pubky and Keet, and their profiles and content", level: "research" },
      ],
      gate: "Sessions without any proof still work. Proving a key never implies importing a graph or permission to publish.",
      after: ["talk"],
    },
    {
      id: "groups",
      n: "06",
      title: "From a conversation to a community",
      why: "Groups need membership, roles and distribution designed together, off the DHT.",
      now: [
        { text: "Private groups of up to eight and communities of up to 256: text, a picture and payments between members", level: "available" },
      ],
      next: [
        { text: "Files and calls in groups, each a capability of its own", level: "planned" },
        { text: "More than one admin, member key updates", level: "planned" },
        { text: "Channels, topics and gated access", level: "planned" },
        { text: "Group encryption beyond the epoch-key scheme (MLS)", level: "research" },
      ],
      gate: "Membership authority, removal, partitions, abuse limits and recovery tested.",
      after: ["talk", "identity"],
    },
    {
      id: "sdk",
      n: "07",
      title: "SDKs, adapters and plugins",
      why: "Let others build pieces without forking the app. A plugin is packaging; the contract stays a WISP.",
      now: [
        { text: "Contracts as WISP drafts, a CLI for scripts and bots, and @ghostly/sdk: an adapter registers as a plugin", level: "available" },
      ],
      next: [
        { text: "Adapter manifests, and the SDK published on npm", level: "planned" },
        { text: "Package authenticity and updates", level: "planned" },
        { text: "A permissioned plugin host", level: "research" },
      ],
      gate: "Malicious-plugin tests, provenance and an update policy.",
      after: ["talk"],
    },
    {
      id: "apps",
      n: "08",
      title: "Apps and catalogs",
      why: "Mini-apps, peer-to-peer games, commerce, interfaces for specific contracts, all found through independent catalogs.",
      now: [{ text: "Nothing yet", level: "planned" }],
      next: [
        { text: "Mini-apps and games", level: "planned" },
        { text: "Independent catalogs, several indexers, perhaps an indexer contract", level: "planned" },
        { text: "Reputation and optional paid apps", level: "planned" },
      ],
      gate: "No single catalog becomes mandatory.",
      after: ["sdk", "pay"],
    },
    {
      id: "os",
      n: "09",
      title: "A Ghostly you can host",
      why: "An always-on runtime (even a Raspberry Pi at home) so services and presence don't depend on an open tab.",
      now: [{ text: "Vision only", level: "planned" }],
      next: [
        { text: "Self-hosted 24h runtime", level: "planned" },
        { text: "Ghostly OS", level: "planned" },
      ],
      gate: "Measured hardware needs, secure administration, backup, reboot and upgrade tests.",
      after: ["keep", "sdk"],
    },
  ] as Track[],
  inventory: {
    title: "Every possibility, classified",
    lead: "From the adapter roadmap in the repository: transports, rails, providers, identities, hardware, storage and apps. Open any entry for the source notes.",
    source: "Read the full adapter roadmap",
    sourceStatus: "as written in the source",
  },
};

export type RoadmapCopy = typeof en;

const ptBr: RoadmapCopy = {
  meta: {
    title: "Roadmap",
    description:
      "Para onde o Ghostly vai depois da 0.5.0, em ordem e com dependências: chats mais ricos, mais formas de pagar, identidades opcionais, grupos, armazenamento, SDKs e plugins, apps independentes e um runtime auto-hospedado. Sem datas inventadas.",
  },
  eyebrow: "Roadmap público",
  title: "O fantasma continua aprendendo.",
  lead: "Ele começou pequeno, aprendeu a encontrar alguém, depois ganhou novas formas de conversar e de trocar valor. O que vem a seguir está ordenado pelo que depende de quê, não por datas que teríamos de inventar.",
  rules: [
    "Sem datas. Só ordem e dependências.",
    "O que já existe aparece como existente, não como trabalho futuro.",
    "Candidato não é compromisso. Dar crédito a uma tecnologia não é parceria.",
  ],
  now: "Onde está",
  next: "Próximos passos",
  gate: "Antes de chamar de pronto",
  after: "Depende de",
  tracks: [
    {
      id: "talk",
      n: "01",
      title: "Conversar de mais jeitos",
      why: "Os chats pareados agora são o padrão. O próximo passo é dar a eles o que os chats WebRTC antigos ainda fazem melhor, e algumas novidades.",
      now: [
        { text: "Chats pareados com chaves fixadas, arquivos, pagamentos e apps locais", level: "available" },
        { text: "Chamadas e compartilhamento de tela em chats WebRTC", level: "available" },
      ],
      next: [
        { text: "Chamadas dentro dos chats pareados", level: "planned" },
        { text: "Mensagens de voz", level: "planned" },
        { text: "Ver o progresso do pareamento enquanto os dois apps se encontram", level: "planned" },
      ],
      gate: "Cada cliente testado contra cada outro, em cada transporte que oferece.",
      after: [],
    },
    {
      id: "pay",
      n: "02",
      title: "Mais formas de pagar",
      why: "Um acordo de pagamento, muitas carteiras. Cada método mantém as próprias regras e os próprios riscos.",
      now: [
        { text: "Cashu e Lightning, pelo mint ou pela sua própria fonte (NWC, LND, Core Lightning, WebLN)", level: "available" },
        { text: "Lightning addresses, e pagar um pedido com qualquer carteira", level: "available" },
        { text: "Ark, Spark, Fedimint, USDT e bitcoin on-chain, experimentais; vários só em redes de teste", level: "available" },
      ],
      next: [
        { text: "Mainnet para Bark, Breez, BDK e Fedimint, depois de revisados pensando em dinheiro de verdade", level: "planned" },
        { text: "Saída unilateral no Ark", level: "planned" },
        { text: "Liquid e outros trilhos", level: "planned" },
      ],
      gate: "Liquidação em rede descartável, limites de taxa, reconciliação de resultado desconhecido e recuperação ou saída testadas antes de qualquer promessa em mainnet.",
      after: ["talk"],
    },
    {
      id: "reach",
      n: "03",
      title: "Encontrar-se em mais lugares",
      why: "Novos transportes ampliam onde duas pessoas podem se encontrar. Cada um é um adapter que os dois lados precisam suportar, nunca uma ponte silenciosa.",
      now: [
        { text: "WebRTC em todo lugar; Iroh e HyperDHT entre apps desktop", level: "available" },
      ],
      next: [
        { text: "Descoberta na rede local, perfis QUIC genérico e relay WebSocket", level: "planned" },
        { text: "Tor, libp2p, componentes Pear / Holepunch", level: "research" },
      ],
      gate: "Cada adapter testado nas próprias plataformas, com relays e trade-offs de privacidade declarados.",
      after: ["talk"],
    },
    {
      id: "keep",
      n: "04",
      title: "Guardar e trazer de volta",
      why: "Perfis, backups e mensagens guardadas já existem. O próximo passo é tornar a recuperação rotina.",
      now: [
        { text: "Perfis locais, backups selados num arquivo ou S3, mensagens guardadas para um contato ausente", level: "available" },
      ],
      next: [
        { text: "Backups agendados e retenção", level: "planned" },
        { text: "Mais lugares de armazenamento (WebDAV, Blossom e outros), para backups e mensagens guardadas", level: "planned" },
      ],
      gate: "Testes de restauração entre aparelhos e versões, sem sobrescrever nada.",
      after: ["talk"],
    },
    {
      id: "identity",
      n: "05",
      title: "Traga uma identidade, só se quiser",
      why: "Ninguém precisa de identidade pública para conversar. Provas são opcionais, várias podem coexistir e você escolhe o que cada contato vê.",
      now: [
        { text: "Provas feitas uma vez, compartilhadas por chat: Nostr, um domínio, uma chave OpenPGP ou SSH, um endereço Bitcoin", level: "available" },
        { text: "Camada social do Nostr: perfil, quem segue e notas; publicar desligado por padrão", level: "available" },
      ],
      next: [
        { text: "Contas OpenID (Google, Microsoft, Apple, GitLab, Twitch): prontas, oferecidas quando os clientes OAuth do Ghostly forem registrados", level: "planned" },
        { text: "Signers de hardware e passkeys", level: "planned" },
        { text: "Pubky e Keet, com os perfis e conteúdos deles", level: "research" },
      ],
      gate: "Sessões sem nenhuma prova continuam funcionando. Provar uma chave nunca implica importar um grafo nem permissão para publicar.",
      after: ["talk"],
    },
    {
      id: "groups",
      n: "06",
      title: "De uma conversa a uma comunidade",
      why: "Grupos precisam de membros, papéis e distribuição desenhados juntos, fora da DHT.",
      now: [
        { text: "Grupos privados de até oito e comunidades de até 256: texto, uma foto e pagamentos entre membros", level: "available" },
      ],
      next: [
        { text: "Arquivos e chamadas em grupos, cada um uma capacidade própria", level: "planned" },
        { text: "Mais de um admin, atualização de chaves dos membros", level: "planned" },
        { text: "Canais, tópicos e acesso restrito", level: "planned" },
        { text: "Criptografia de grupo além do esquema de chaves por época (MLS)", level: "research" },
      ],
      gate: "Autoridade sobre membros, remoção, partições, limites contra abuso e recuperação testados.",
      after: ["talk", "identity"],
    },
    {
      id: "sdk",
      n: "07",
      title: "SDKs, adapters e plugins",
      why: "Deixar outras pessoas construírem peças sem fazer fork do app. Plugin é embalagem; o contrato continua sendo um WISP.",
      now: [
        { text: "Contratos como rascunhos WISP, uma CLI para scripts e bots, e o @ghostly/sdk: um adapter se registra como plugin", level: "available" },
      ],
      next: [
        { text: "Manifestos de adapters, e o SDK publicado no npm", level: "planned" },
        { text: "Autenticidade de pacotes e atualizações", level: "planned" },
        { text: "Um host de plugins com permissões", level: "research" },
      ],
      gate: "Testes com plugins maliciosos, procedência e uma política de atualização.",
      after: ["talk"],
    },
    {
      id: "apps",
      n: "08",
      title: "Apps e catálogos",
      why: "Miniapps, jogos P2P, comércio, interfaces para contratos específicos, todos encontrados por catálogos independentes.",
      now: [{ text: "Nada ainda", level: "planned" }],
      next: [
        { text: "Miniapps e jogos", level: "planned" },
        { text: "Catálogos independentes, vários indexadores, talvez um contrato para indexadores", level: "planned" },
        { text: "Reputação e apps pagos opcionais", level: "planned" },
      ],
      gate: "Nenhum catálogo se torna obrigatório.",
      after: ["sdk", "pay"],
    },
    {
      id: "os",
      n: "09",
      title: "Um Ghostly que você hospeda",
      why: "Um runtime sempre ligado (até um Raspberry Pi em casa) para serviços e presença não dependerem de uma aba aberta.",
      now: [{ text: "Só visão", level: "planned" }],
      next: [
        { text: "Runtime auto-hospedado 24h", level: "planned" },
        { text: "Ghostly OS", level: "planned" },
      ],
      gate: "Requisitos de hardware medidos, administração segura, backup, reinício e testes de atualização.",
      after: ["keep", "sdk"],
    },
  ],
  inventory: {
    title: "Todas as possibilidades, classificadas",
    lead: "Do roadmap de adapters no repositório: transportes, trilhos, provedores, identidades, hardware, armazenamento e apps. Abra qualquer item para ver as notas da fonte (em inglês).",
    source: "Ler o roadmap de adapters completo",
    sourceStatus: "como escrito na fonte",
  },
};

export const roadmap: Localized<RoadmapCopy> = { en, "pt-br": ptBr };

/**
 * Candidate status in the site's levels. The adapter roadmap's status column
 * lags the code on `dev`, so what the app already runs is pinned to
 * "available" here, with the PR that shipped it.
 */
const AVAILABLE = new Set([
  // Before 0.5.0
  "candidate-pkarr-mainline-dht",
  "candidate-webrtc",
  "candidate-cashu",
  "candidate-lightning-bolt11",
  "candidate-files-and-attachments",
  "candidate-voice-video-screenshare",
  "candidate-local-state",
  // Wallet sources and rails (#77, #78, #79, #82, #86, #88, #90, #188, #192)
  "candidate-ark-via-bark",
  "candidate-bitcoin-on-chain",
  "candidate-lnd",
  "candidate-core-lightning",
  "candidate-nwc",
  "candidate-webln",
  "candidate-bitcoin-core-rpc",
  "candidate-bdk",
  "candidate-esplora",
  "candidate-spark",
  "candidate-fedimint",
  // Identity proofs (#80, #81, #85, #89, #91, #93)
  "candidate-proof",
  "candidate-nostr",
  "candidate-openpgp-pgp",
  "candidate-ssh",
  "candidate-bitcoin-address-proof",
  "candidate-github",
  "candidate-domain",
  // Backups (#72): sealed bundles to a file or an S3-compatible bucket
  "candidate-backup-export-import-migration",
  "candidate-remote-encrypted-storage",
  // Paying from another wallet and Lightning addresses (#107, WISP 205)
  "candidate-manual-external-wallet",
  "candidate-lightning-address-lnurl-pay",
  // Nostr social layer (#103): profile, follows, notes, publication; Nostr only
  "candidate-profile",
  "candidate-social-graph",
  "candidate-content-read-search",
  "candidate-publication",
  // Private groups and communities (#102, #106, #153); the epoch-key scheme is
  // the group crypto decided for them
  "candidate-private-groups",
  "candidate-group-crypto",
  // Store-and-forward (#108): hold/1 in the sender's own S3 storage
  "candidate-store-forward-offline-sync",
  // @ghostly/sdk (#105): the SDK and plugin registration; manifests with
  // publisher identity and permissions are not built yet
  "candidate-sdk-and-manifests",
]);
/**
 * Built but not offered: OpenID proofs (#92) wait for Ghostly's OAuth clients
 * to be registered, so for the people using the app they are still planned.
 */
const NOT_OFFERED = new Set(["candidate-openid-connect-providers-google-microsoft-entra-work-school-and-personal-apple-gitlab-com-twitch"]);
export function candidateLevel(id: string, status: string): Level {
  if (NOT_OFFERED.has(id)) return "planned";
  if (AVAILABLE.has(id)) return "available";
  if (status.startsWith("Current") || status.startsWith("In development")) return "available";
  if (/research/i.test(status)) return "research";
  return "planned";
}
