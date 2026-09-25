import type { Localized } from "@/lib/i18n";
import type { Level } from "@/lib/status";

/**
 * The public roadmap: tracks in dependency order, never dates. "Now" lists
 * what already exists (released or merged), so finished work is not presented
 * as a future step.
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
      "Where Ghostly is going, in order and with dependencies: polish, more ways to pay, optional identities, groups, storage, SDKs and plugins, independent apps and a self-hosted runtime. No invented dates.",
  },
  eyebrow: "Public roadmap",
  title: "The ghost keeps learning.",
  lead: "It started small, learned to find someone, then new ways to talk and to trade value. What comes next is ordered by what it depends on — not by dates we'd have to invent.",
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
      id: "polish",
      n: "01",
      title: "Consolidate what exists",
      why: "Paired chats, native transports and the new wallets are merged. They need to become a release people can rely on.",
      now: [
        { text: "Paired chats with pinned keys, negotiated files and payments", level: "development" },
        { text: "Iroh and HyperDHT between desktop apps", level: "development" },
        { text: "Calls, screen sharing and local app sharing in WebRTC chats", level: "released" },
      ],
      next: [
        { text: "Calls and local services inside paired chats", level: "planned" },
        { text: "Release 0.5.0 with the merged work", level: "development" },
      ],
      gate: "Accurate client-by-client scope, reproducible tests, and a public release.",
      after: [],
    },
    {
      id: "pay",
      n: "02",
      title: "More ways to pay",
      why: "One payment agreement, many wallets. Each method keeps its own rules and its own risks.",
      now: [
        { text: "Cashu, with Lightning through the mint", level: "released" },
        { text: "Ark via Arkade and USDT via Tether WDK, experimental", level: "development" },
        { text: "Your own Lightning source: NWC, LND, Core Lightning, a browser wallet (WebLN), Breez on a local regtest", level: "development" },
        { text: "Ark via Bark, test networks only", level: "development" },
        { text: "Spark to Spark, wallet to wallet: Breez's regtest in Testnet, Mainnet with a Breez API key", level: "development" },
        { text: "On-chain bitcoin in a chat: a BDK wallet (test networks) or Bitcoin Core (desktop)", level: "development" },
        { text: "Pay a request from any other wallet (QR code or link), and pay Lightning addresses and LNURLs", level: "development" },
      ],
      next: [
        { text: "Mainnet for Bark, Breez and BDK once reviewed with real money in mind", level: "planned" },
        { text: "Fedimint, Liquid and other rails", level: "planned" },
      ],
      gate: "Disposable-network settlement, fee limits, unknown-result reconciliation, and recovery or exit tested before any mainnet claim.",
      after: ["polish"],
    },
    {
      id: "reach",
      n: "03",
      title: "Reach each other in more places",
      why: "New transports widen where two people can meet — each one an adapter both sides must support, never a silent bridge.",
      now: [
        { text: "WebRTC everywhere; Iroh and HyperDHT on desktop", level: "development" },
      ],
      next: [
        { text: "Local network discovery, generic QUIC and WebSocket relay profiles", level: "planned" },
        { text: "Tor, libp2p, Pear / Holepunch components", level: "research" },
      ],
      gate: "Each adapter tested on its own platforms, with its relays and privacy trade-offs stated.",
      after: ["polish"],
    },
    {
      id: "keep",
      n: "04",
      title: "Keep things, bring them back",
      why: "Backups, storage and held messages already exist in the merged build; next is making recovery routine.",
      now: [
        { text: "Local profiles", level: "development" },
        { text: "Sealed backups to a file or any S3-compatible bucket", level: "development" },
        { text: "Messages held for an away contact in your own S3 bucket (store-and-forward, hold/1)", level: "development" },
      ],
      next: [
        { text: "Scheduled backups and retention", level: "planned" },
        { text: "More storage places (WebDAV, Blossom and others), for backups and held messages", level: "planned" },
      ],
      gate: "Restore drills across devices and versions, without overwriting anything.",
      after: ["polish"],
    },
    {
      id: "identity",
      n: "05",
      title: "Bring an identity — only if you want",
      why: "Nobody needs a public identity to talk. Proofs are optional, several can coexist, and you choose what each contact sees.",
      now: [
        { text: "Proofs made once and shared per chat: Nostr, a domain, an OpenPGP or SSH key, a Bitcoin address", level: "development" },
        { text: "Accounts at Google, Microsoft, Apple, GitLab or Twitch, attested by the provider — merged, not offered until clients are registered", level: "development" },
        { text: "Nostr social layer: a proven key's profile, follows and notes on request; posting through your own signer, off by default", level: "development" },
      ],
      next: [
        { text: "Hardware signers and passkeys", level: "planned" },
        { text: "Pubky and Keet, and their profiles and content", level: "research" },
      ],
      gate: "Sessions without any proof still work. Proving a key never implies importing a graph or permission to publish.",
      after: ["polish"],
    },
    {
      id: "groups",
      n: "06",
      title: "From a conversation to a community",
      why: "Groups need membership, roles and distribution designed together, off the DHT.",
      now: [
        { text: "Private groups of up to eight: text only, one admin, a fresh key whenever membership changes (group-mesh/1)", level: "development" },
      ],
      next: [
        { text: "Files, calls and payments in groups, each a capability of its own", level: "planned" },
        { text: "More than one admin, member key updates", level: "planned" },
        { text: "Larger groups (GossipSub), channels, topics and gated access", level: "planned" },
        { text: "Group encryption beyond the epoch-key scheme (MLS)", level: "research" },
      ],
      gate: "Membership authority, removal, partitions, abuse limits and recovery tested.",
      after: ["polish", "identity"],
    },
    {
      id: "sdk",
      n: "07",
      title: "SDKs, adapters and plugins",
      why: "Let others build pieces without forking the app. A plugin is packaging; the contract stays a WISP.",
      now: [
        { text: "Contracts published as WISP drafts; a CLI for scripts and bots", level: "released" },
        { text: "@ghostly/sdk: contracts, fakes and contract suites; an adapter registers as a plugin, without a registry line", level: "development" },
      ],
      next: [
        { text: "Adapter manifests, and the SDK published on npm", level: "planned" },
        { text: "A permissioned plugin host", level: "research" },
        { text: "Package authenticity and updates", level: "planned" },
      ],
      gate: "Malicious-plugin tests, provenance and an update policy.",
      after: ["polish"],
    },
    {
      id: "apps",
      n: "08",
      title: "Apps and catalogs",
      why: "Mini-apps, peer-to-peer games, commerce, interfaces for specific contracts — found through independent catalogs.",
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
      why: "An always-on runtime — even a Raspberry Pi at home — so services and presence don't depend on an open tab.",
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
      "Para onde o Ghostly vai, em ordem e com dependências: polimento, mais formas de pagar, identidades opcionais, grupos, armazenamento, SDKs e plugins, apps independentes e um runtime auto-hospedado. Sem datas inventadas.",
  },
  eyebrow: "Roadmap público",
  title: "O fantasma continua aprendendo.",
  lead: "Ele começou pequeno, aprendeu a encontrar alguém, depois ganhou novas formas de conversar e de trocar valor. O que vem a seguir está ordenado pelo que depende de quê — não por datas que teríamos de inventar.",
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
      id: "polish",
      n: "01",
      title: "Consolidar o que existe",
      why: "Chats pareados, transportes nativos e as novas carteiras estão integrados. Precisam virar uma versão em que as pessoas possam confiar.",
      now: [
        { text: "Chats pareados com chaves fixadas, arquivos e pagamentos negociados", level: "development" },
        { text: "Iroh e HyperDHT entre apps desktop", level: "development" },
        { text: "Chamadas, compartilhamento de tela e de apps locais em chats WebRTC", level: "released" },
      ],
      next: [
        { text: "Chamadas e serviços locais dentro dos chats pareados", level: "planned" },
        { text: "Lançar a 0.5.0 com o trabalho integrado", level: "development" },
      ],
      gate: "Escopo exato por cliente, testes reproduzíveis e uma versão pública.",
      after: [],
    },
    {
      id: "pay",
      n: "02",
      title: "Mais formas de pagar",
      why: "Um acordo de pagamento, muitas carteiras. Cada método mantém as próprias regras e os próprios riscos.",
      now: [
        { text: "Cashu, com Lightning pelo mint", level: "released" },
        { text: "Ark via Arkade e USDT via Tether WDK, experimentais", level: "development" },
        { text: "Sua própria fonte Lightning: NWC, LND, Core Lightning, uma carteira do navegador (WebLN), Breez num regtest local", level: "development" },
        { text: "Ark via Bark, só em redes de teste", level: "development" },
        { text: "Spark para Spark, de carteira para carteira: regtest da Breez na Testnet, Mainnet com uma chave de API da Breez", level: "development" },
        { text: "Bitcoin on-chain no chat: uma carteira BDK (redes de teste) ou o Bitcoin Core (desktop)", level: "development" },
        { text: "Pagar um pedido com qualquer outra carteira (QR code ou link), e pagar Lightning addresses e LNURLs", level: "development" },
      ],
      next: [
        { text: "Mainnet para Bark, Breez e BDK depois de revisados pensando em dinheiro de verdade", level: "planned" },
        { text: "Fedimint, Liquid e outros trilhos", level: "planned" },
      ],
      gate: "Liquidação em rede descartável, limites de taxa, reconciliação de resultado desconhecido e recuperação ou saída testadas antes de qualquer promessa em mainnet.",
      after: ["polish"],
    },
    {
      id: "reach",
      n: "03",
      title: "Encontrar-se em mais lugares",
      why: "Novos transportes ampliam onde duas pessoas podem se encontrar — cada um é um adapter que os dois lados precisam suportar, nunca uma ponte silenciosa.",
      now: [
        { text: "WebRTC em todo lugar; Iroh e HyperDHT no desktop", level: "development" },
      ],
      next: [
        { text: "Descoberta na rede local, perfis QUIC genérico e relay WebSocket", level: "planned" },
        { text: "Tor, libp2p, componentes Pear / Holepunch", level: "research" },
      ],
      gate: "Cada adapter testado nas próprias plataformas, com relays e trade-offs de privacidade declarados.",
      after: ["polish"],
    },
    {
      id: "keep",
      n: "04",
      title: "Guardar e trazer de volta",
      why: "Backups, armazenamento e mensagens guardadas já existem na build integrada; o próximo passo é tornar a recuperação rotina.",
      now: [
        { text: "Perfis locais", level: "development" },
        { text: "Backups selados num arquivo ou em qualquer bucket compatível com S3", level: "development" },
        { text: "Mensagens guardadas para um contato ausente no seu próprio bucket S3 (store-and-forward, hold/1)", level: "development" },
      ],
      next: [
        { text: "Backups agendados e retenção", level: "planned" },
        { text: "Mais lugares de armazenamento (WebDAV, Blossom e outros), para backups e mensagens guardadas", level: "planned" },
      ],
      gate: "Testes de restauração entre aparelhos e versões, sem sobrescrever nada.",
      after: ["polish"],
    },
    {
      id: "identity",
      n: "05",
      title: "Traga uma identidade — só se quiser",
      why: "Ninguém precisa de identidade pública para conversar. Provas são opcionais, várias podem coexistir e você escolhe o que cada contato vê.",
      now: [
        { text: "Provas feitas uma vez e compartilhadas por chat: Nostr, um domínio, uma chave OpenPGP ou SSH, um endereço Bitcoin", level: "development" },
        { text: "Contas no Google, Microsoft, Apple, GitLab ou Twitch, atestadas pelo provedor — integradas, mas só oferecidas quando os clientes forem registrados", level: "development" },
        { text: "Camada social do Nostr: perfil, quem segue e notas de uma chave provada, sob pedido; publicar pelo seu próprio signer, desligado por padrão", level: "development" },
      ],
      next: [
        { text: "Signers de hardware e passkeys", level: "planned" },
        { text: "Pubky e Keet, com os perfis e conteúdos deles", level: "research" },
      ],
      gate: "Sessões sem nenhuma prova continuam funcionando. Provar uma chave nunca implica importar um grafo nem permissão para publicar.",
      after: ["polish"],
    },
    {
      id: "groups",
      n: "06",
      title: "De uma conversa a uma comunidade",
      why: "Grupos precisam de membros, papéis e distribuição desenhados juntos, fora da DHT.",
      now: [
        { text: "Grupos privados de até oito pessoas: só texto, um admin, chave nova sempre que os membros mudam (group-mesh/1)", level: "development" },
      ],
      next: [
        { text: "Arquivos, chamadas e pagamentos em grupos, cada um uma capacidade própria", level: "planned" },
        { text: "Mais de um admin, atualização de chaves dos membros", level: "planned" },
        { text: "Grupos maiores (GossipSub), canais, tópicos e acesso restrito", level: "planned" },
        { text: "Criptografia de grupo além do esquema de chaves por época (MLS)", level: "research" },
      ],
      gate: "Autoridade sobre membros, remoção, partições, limites contra abuso e recuperação testados.",
      after: ["polish", "identity"],
    },
    {
      id: "sdk",
      n: "07",
      title: "SDKs, adapters e plugins",
      why: "Deixar outras pessoas construírem peças sem fazer fork do app. Plugin é embalagem; o contrato continua sendo um WISP.",
      now: [
        { text: "Contratos publicados como rascunhos WISP; uma CLI para scripts e bots", level: "released" },
        { text: "@ghostly/sdk: contratos, fakes e suítes de contrato; um adapter se registra como plugin, sem linha no registro", level: "development" },
      ],
      next: [
        { text: "Manifestos de adapters, e o SDK publicado no npm", level: "planned" },
        { text: "Um host de plugins com permissões", level: "research" },
        { text: "Autenticidade de pacotes e atualizações", level: "planned" },
      ],
      gate: "Testes com plugins maliciosos, procedência e uma política de atualização.",
      after: ["polish"],
    },
    {
      id: "apps",
      n: "08",
      title: "Apps e catálogos",
      why: "Miniapps, jogos P2P, comércio, interfaces para contratos específicos — encontrados por catálogos independentes.",
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
      why: "Um runtime sempre ligado — até um Raspberry Pi em casa — para serviços e presença não dependerem de uma aba aberta.",
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
 * lags the work merged on dev (wallet sources and identity proofs on
 * 2026-09-23; groups, the SDK, the Nostr social layer, paying from another
 * wallet and store-and-forward on 2026-09-24), so those candidates are pinned
 * to "development" here; nothing is being built outside dev at the time of
 * writing.
 */
const BUILDING = new Set<string>([]);
const DEVELOPMENT = new Set([
  // Wallet sources merged on dev (2026-09-23)
  "candidate-ark-via-bark",
  "candidate-bitcoin-on-chain",
  "candidate-lnd",
  "candidate-core-lightning",
  "candidate-nwc",
  "candidate-webln",
  "candidate-bitcoin-core-rpc",
  "candidate-bdk",
  "candidate-esplora",
  // Identity proofs merged on dev (2026-09-23)
  "candidate-proof",
  "candidate-nostr",
  "candidate-openpgp-pgp",
  "candidate-ssh",
  "candidate-bitcoin-address-proof",
  "candidate-github",
  "candidate-domain",
  // OpenID proofs are merged but not offered until the OAuth clients are registered
  "candidate-openid-connect-providers-google-microsoft-entra-work-school-and-personal-apple-gitlab-com-twitch",
  // Backups merged on dev (#72): sealed bundles to a file or an S3-compatible bucket
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
  // Private groups (#102, #106): group-mesh/1, text only, up to eight members;
  // its epoch-key scheme is the group crypto decided for this first profile
  "candidate-private-groups",
  "candidate-group-crypto",
  // Store-and-forward (#108): hold/1 in the sender's own S3 storage
  "candidate-store-forward-offline-sync",
  // @ghostly/sdk (#105): the SDK and plugin registration; manifests with
  // publisher identity and permissions are not built yet
  "candidate-sdk-and-manifests",
]);
const RELEASED = new Set([
  "candidate-pkarr-mainline-dht",
  "candidate-webrtc",
  "candidate-cashu",
  "candidate-lightning-bolt11",
]);
export function candidateLevel(id: string, status: string): Level {
  if (BUILDING.has(id)) return "building";
  if (DEVELOPMENT.has(id)) return "development";
  if (RELEASED.has(id)) return "released";
  if (status.startsWith("Current") || status.startsWith("In development")) return "development";
  if (/research/i.test(status)) return "research";
  return "planned";
}
