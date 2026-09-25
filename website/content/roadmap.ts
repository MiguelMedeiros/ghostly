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
      why: "Every new chat is the same kind: it comes from one ghostly1 invite, starts on the DHT when no direct path exists and goes live by itself. Next is what a chat shows about the other person, and more clients.",
      now: [
        { text: "One ghostly1 invite code, a QR and a ghostly.tools link", level: "available" },
        { text: "Chats with pinned keys, files of any size, payments and local apps", level: "available" },
        { text: "A chat with no direct path starts on the DHT and goes live by itself; short texts over the DHT when the live link drops", level: "available" },
        { text: "Calls and screen sharing in every chat, while it is live", level: "available" },
        { text: "Pairing progress you can watch while two apps find each other", level: "available" },
        { text: "Voice messages", level: "available" },
      ],
      next: [
        { text: "Typing and presence, each a capability of its own that you can keep private", level: "planned" },
        { text: "Mobile apps, and a CLI that joins the same chats", level: "planned" },
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
        { text: "WebRTC (not on Linux desktops); Iroh and HyperDHT between desktop apps", level: "available" },
        { text: "Iroh in the browser through n0's relays; HyperDHT there only through a relay you set", level: "available" },
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
        { text: "Proofs made once, shared per chat: Nostr, Pubky (approved in Pubky Ring or Passport), a domain, an OpenPGP or SSH key, a Bitcoin address, a DID", level: "available" },
        { text: "Nostr social layer: profile, follows and notes; posting off by default", level: "available" },
        { text: "A did:dht for every profile, listing only the identities you switch on", level: "available" },
      ],
      next: [
        { text: "Bluesky / AT Protocol accounts: built, blocked until the website's OAuth client document is live on ghostly.tools", level: "planned" },
        { text: "OpenID accounts (Google, Microsoft, Apple, GitLab, Twitch): built, blocked until Ghostly's OAuth clients are registered", level: "planned" },
        { text: "Hardware wallets as signers, and passkeys", level: "planned" },
        { text: "Keet, blocked until it offers a supported signing API", level: "planned" },
        { text: "Pubky profiles and content", level: "research" },
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
        { text: "Contracts as WISP drafts, a compatibility CLI for scripts and bots, and @ghostly/sdk in the repository: an adapter registers as a plugin", level: "available" },
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
    /** The source's statuses that the three levels don't name; shown before the source's note. */
    states: { "In implementation": "In implementation", Blocked: "Blocked" },
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
      why: "Todo chat novo é do mesmo tipo: vem de um único convite ghostly1, começa na DHT quando não há caminho direto e passa sozinho ao link direto. Em seguida vem o que o chat mostra sobre a outra pessoa, e mais clientes.",
      now: [
        { text: "Um único código de convite ghostly1, um QR e um link em ghostly.tools", level: "available" },
        { text: "Chats com chaves fixadas, arquivos de qualquer tamanho, pagamentos e apps locais", level: "available" },
        { text: "Um chat sem caminho direto começa na DHT e passa sozinho ao link direto; textos curtos pela DHT quando o link direto cai", level: "available" },
        { text: "Chamadas e compartilhamento de tela em todo chat, enquanto ele está ao vivo", level: "available" },
        { text: "Ver o progresso do pareamento enquanto os dois apps se encontram", level: "available" },
        { text: "Mensagens de voz", level: "available" },
      ],
      next: [
        { text: "Digitando e presença, cada um uma capacidade própria que você pode manter privada", level: "planned" },
        { text: "Apps para celular, e uma CLI que entra nos mesmos chats", level: "planned" },
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
        { text: "WebRTC (não no desktop Linux); Iroh e HyperDHT entre apps desktop", level: "available" },
        { text: "Iroh no navegador pelos relays da n0; HyperDHT lá só por um relay que você define", level: "available" },
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
        { text: "Provas feitas uma vez, compartilhadas por chat: Nostr, Pubky (aprovada no Pubky Ring ou no Passport), um domínio, uma chave OpenPGP ou SSH, um endereço Bitcoin, um DID", level: "available" },
        { text: "Camada social do Nostr: perfil, quem segue e notas; publicar desligado por padrão", level: "available" },
        { text: "Um did:dht para cada perfil, que lista só as identidades que você ligar", level: "available" },
      ],
      next: [
        { text: "Contas Bluesky / AT Protocol: prontas, bloqueadas até o documento de cliente OAuth do site estar no ar em ghostly.tools", level: "planned" },
        { text: "Contas OpenID (Google, Microsoft, Apple, GitLab, Twitch): prontas, bloqueadas até os clientes OAuth do Ghostly serem registrados", level: "planned" },
        { text: "Carteiras de hardware como signers, e passkeys", level: "planned" },
        { text: "Keet, bloqueado até oferecer uma API de assinatura suportada", level: "planned" },
        { text: "Perfis e conteúdos do Pubky", level: "research" },
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
        { text: "Contratos como rascunhos WISP, uma CLI de compatibilidade para scripts e bots, e o @ghostly/sdk no repositório: um adapter se registra como plugin", level: "available" },
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
    states: { "In implementation": "Em implementação", Blocked: "Bloqueado" },
  },
};

export const roadmap: Localized<RoadmapCopy> = { en, "pt-br": ptBr };

