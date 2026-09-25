import type { Localized } from "@/lib/i18n";

/**
 * Homepage copy. Every capability claim was checked against the code on `dev`,
 * the 0.5.0 release: the page says what the app does, and states each limit
 * (test networks, missing features) in the line it applies to.
 */

/** Where a wallet runs: Mainnet, test networks only, or Mainnet with a key of your own. */
type Net = "main" | "test" | "key";
const en = {
  meta: {
    title: "Ghostly: Find each other. Talk peer to peer.",
    description:
      "Meet the people you choose through a private invitation, then chat, send files and sats, peer to peer. No account to create. Free and open source.",
  },
  rail: "Where you are in the story",
  hero: {
    badge: "Peer to peer · No account to create",
    title1: "Find your people.",
    title2: "Talk peer to peer.",
    lead: "Ghostly connects you straight to the people you invite. Chat one to one or as a group, send files and sats, call, and share what runs on your computer.",
    open: "Open in your browser",
    download: "Download the app",
    micro: "Nothing to install · Free and open source",
    follow: "Follow Boo",
    booSays: "Is anyone out there?",
    skip: "Skip the story",
  },
  statement: {
    // The last sentence of dht.steps[0].body, given the whole screen between the acts.
    before: "There is ",
    accent: "no",
    after: " Ghostly server in the middle.",
  },
  invite: {
    eyebrow: "01 · The invitation",
    label: "How an invitation works",
    steps: [
      {
        title: "Create an invitation.",
        body: "Boo makes an invitation for one person. It holds the keys, not an account.",
      },
      {
        title: "Share it your way.",
        body: "A link, a QR code or a text code. Send it only to the person you want to meet.",
      },
      {
        title: "Connect.",
        body: "Casper opens it, both apps find each other and confirm. You're talking.",
      },
    ],
    card: { title: "Invitation", link: "Link", qr: "QR", code: "Code", forOne: "for one person" },
  },
  dht: {
    eyebrow: "02 · The meeting place",
    label: "How the two apps find each other on the DHT",
    steps: [
      {
        title: "A public network with no owner.",
        body: "The apps meet on the Mainline DHT, which millions of BitTorrent users already share. There is no Ghostly server in the middle.",
        note: "Browsers reach it through public Pkarr relays.",
      },
      {
        title: "Small, signed, sealed notes.",
        body: "Boo leaves a few tiny signed records in the network. What matters inside is encrypted.",
      },
      {
        title: "Only the invitation opens them.",
        body: "Casper knows where to look and how to read them. Anyone else sees sealed records.",
      },
      {
        title: "Then they fade.",
        body: "They are refreshed only while you're online. Stop, and they age out. Copies someone already made are not erased.",
      },
    ],
    tags: { sealed: "sealed", ttl: "expires" },
  },
  agree: {
    eyebrow: "03 · The agreement",
    label: "How both sides agree on what to use",
    steps: [
      {
        title: "Each side says what it can do.",
        body: "Boo's desktop app and Casper's browser each list what they support.",
      },
      {
        title: "They keep what they share.",
        body: "Only what is on both lists is used. The rest stays off.",
      },
      {
        title: "A plan both agreed to.",
        body: "Here: chat, files and Cashu over WebRTC. Other apps, another plan.",
        note: "Chats with Ghostly 0.4 contacts keep a fixed set.",
      },
    ],
    boo: "Boo · desktop",
    casper: "Casper · browser",
    plan: "The plan",
  },
  alive: {
    eyebrow: "04 · The connection comes alive",
    label: "How the conversation leaves the DHT for a direct connection",
    steps: [
      {
        title: "The DHT only introduced them.",
        body: "Once they know how to reach each other, the conversation moves off the DHT.",
      },
      {
        title: "A direct line.",
        body: "Messages, files and payments travel over a live connection between the two devices: WebRTC, Iroh or HyperDHT.",
      },
      {
        title: "Honest about the route.",
        body: "Public STUN servers help find a way through home routers. If the direct path drops, short texts keep going over the DHT.",
        note: "You can add your own TURN relay in settings.",
      },
    ],
    pipe: "live connection",
    thread: "rendezvous",
  },
  next: {
    eyebrow: "05 · What happens next",
    title: "Now that you're connected.",
    lead: "Here is what the app does.",
    shot: "Screenshot of the Ghostly app",
    illustration: "Illustration",
    fromDev: "Ghostly {n}",
    fromOld: "An earlier build",
    items: [
      {
        id: "chat",
        icon: "chat",
        title: "Say it your way.",
        body: "Private one-to-one conversations with delivery receipts and local history. No phone number, no public profile.",
        extra: "Voice messages, pinned keys, names and pictures, and messages held for a contact who is away.",
      },
      {
        id: "files",
        icon: "file",
        title: "Send the actual thing.",
        body: "Photos, documents, projects: straight from your device to theirs, checked on arrival.",
        extra: "Any size, with both of you online; a big file picks up where it stopped.",
      },
      {
        id: "calls",
        icon: "video",
        title: "Be a little closer.",
        body: "Voice, video and screen sharing, one to one. Turn the camera on or share your screen without calling again.",
        extra: "Screen sharing needs a computer. Calls ring in every chat while it is live (not on the DHT, and not on Linux desktop, whose webview has no WebRTC); groups don't ring yet.",
      },
      {
        id: "sats",
        icon: "bolt",
        title: "A little thank-you.",
        body: "Send or request sats right in the conversation: ecash, a Lightning invoice, or from the wallet you already use.",
        extra: "Your own Lightning node or wallet (NWC, LND, Core Lightning, WebLN, Breez), Lightning addresses, paying from any wallet, Ark, Spark, Fedimint, USDT and on-chain bitcoin. Some run on test networks only.",
      },
      {
        id: "groups",
        icon: "group",
        title: "Bring the whole group.",
        body: "A private group of up to eight, or a community of up to 256 that anyone with its link can join. Invite people from your chats or share the link.",
        extra: "Text, a group picture and payments between members. No files or calls in groups yet.",
      },
      {
        id: "identities",
        icon: "badge",
        title: "Prove who you are. Only to whom you choose.",
        body: "Attach an outside identity to your profile once (a Nostr or Pubky key, a domain, an OpenPGP or SSH key, a Bitcoin address) and share it with one contact at a time. Their app verifies it on the device.",
        extra: "Never required to talk. Withdraw it from one chat, or revoke it everywhere.",
      },
      {
        id: "services",
        icon: "window",
        title: "Made here. Open there.",
        body: "While you're online, let a contact open a web app running on your computer: a photo gallery, a dashboard, a prototype.",
        extra: "Desktop app or browser extension at both ends; plain HTTP, no WebSockets. You choose which contacts see each app.",
      },
      {
        id: "cli",
        icon: "terminal",
        title: "Give your code a voice.",
        body: "A command-line client for scripts, bots and agents: create an identity and invitations, send, receive and watch a chat as a JSON stream.",
        extra: "Text messages only. Its invitations are for other CLI peers; talking to the app means passing the keys by hand.",
        link: { label: "CLI guide", href: "/cli" },
      },
    ],
  },
  space: {
    eyebrow: "06 · Your space",
    title: "Everything stays yours, on your device.",
    lead: "Chats, keys, wallets and services live in the app. No server of ours.",
    profiles: {
      title: "Separate lives, one device.",
      note: "Contacts never learn the others exist · web, desktop and extension",
      names: ["Personal", "Work", "Club"],
    },
    backup: {
      title: "Backup is what. Storage is where.",
      what: "Backup",
      where: "Storage",
      whatItems: ["chats & keys", "wallets", "services", "settings"],
      whereItems: ["a file you keep", "S3 · R2 · B2 · MinIO"],
      note: "Sealed with your passphrase · restoring creates a new profile, nothing is overwritten",
    },
    look: {
      title: "Make it look like you.",
      note: "Four themes · light or dark · eight languages · app lock",
    },
  },
  wallets: {
    title: "One wallet, many ways to pay.",
    lead: "Each payment method is its own card, with its own rules. Pick one to see what it does and how ready it is.",
    testnet: "A Testnet switch moves every wallet to test networks at once.",
    cards: [
      {
        id: "cashu",
        name: "Cashu",
        kind: "ecash",
        net: "main" as Net,
        network: "Mainnet",
        body: "Private ecash tokens you can pass along in a chat. A mint you choose holds the funds.",
        limits: "Trust the mint you pick: it can see its own operations and holds the backing sats.",
      },
      {
        id: "lightning",
        name: "Lightning",
        kind: "invoices",
        net: "main" as Net,
        network: "Mainnet",
        body: "Pay and receive Lightning invoices from the chat, and pay Lightning addresses.",
        limits: "The source is your Cashu mint, or your own node or wallet: NWC, LND, Core Lightning, a browser wallet (WebLN, web app only), Breez (regtest only) or Fedimint (test networks only). Any other wallet can pay your invoice from its QR code.",
      },
      {
        id: "ark",
        name: "Ark",
        kind: "via Arkade",
        net: "main" as Net,
        network: "Mainnet · experimental",
        body: "Review and approve an exact Ark payment through a pinned operator.",
        limits: "Experimental. New profiles get a Bitcoin mainnet Ark wallet automatically, but payments were tested only on a local test network, and there is no unilateral exit yet.",
      },
      {
        id: "bark",
        name: "Bark",
        kind: "Second's Ark",
        net: "test" as Net,
        network: "Test networks only",
        body: "A second Ark provider beside Arkade: same idea, another server, its own way of paying.",
        limits: "Experimental, on Second's signet server or a local regtest; Mainnet makes no Bark wallet yet. Not interchangeable with Arkade: a Bark wallet cannot pay an Arkade address.",
      },
      {
        id: "spark",
        name: "Spark",
        kind: "wallet to wallet",
        net: "key" as Net,
        network: "Mainnet with your own key",
        body: "Bitcoin on Spark, from one Spark wallet to another in a chat. Each request carries a Spark invoice made for it.",
        limits: "Experimental. Testnet opens a regtest wallet by itself; Mainnet needs your own Breez API key and is labelled real money. The same wallet can be your Lightning source too.",
      },
      {
        id: "fedimint",
        name: "Fedimint",
        kind: "federation ecash",
        net: "test" as Net,
        network: "Test networks only",
        body: "Join a federation by its invite code, after seeing its name and guardians. Ecash in the chat, and Lightning through its gateway.",
        limits: "Experimental. Mainnet joins no federation yet. The federation's guardians, together, hold the funds.",
      },
      {
        id: "usdt",
        name: "USDT",
        kind: "Tether WDK",
        net: "main" as Net,
        network: "Mainnet · experimental",
        body: "Receive and send USDT on Ethereum, signed on your device.",
        limits: "Experimental. Payment flows were validated on a local test chain, not with real funds. Ethereum only; a Sepolia test mode exists.",
      },
      {
        id: "onchain",
        name: "Bitcoin",
        kind: "on-chain",
        net: "test" as Net,
        network: "BDK on test networks",
        body: "Plain on-chain bitcoin in a chat, through a BDK wallet or your own Bitcoin Core node.",
        limits: "Experimental. BDK on signet, Mutinynet or regtest only; Bitcoin Core needs the desktop app. On-chain payments are offered only inside an open paired session.",
      },
    ],
  },
  open: {
    eyebrow: "07 · Under the ghosts",
    label: "The pieces that make Ghostly",
    steps: [
      {
        title: "Everything you just saw…",
        body: "…is one app composing independent pieces: a small rendezvous core, transports, and abilities like chat, files and payments.",
      },
      {
        title: "…is built from open pieces.",
        body: "Each piece is described in a WISP, a public draft contract. Another app can implement only the pieces it needs and still meet Ghostly halfway.",
      },
    ],
    layers: ["Ghost · rendezvous & keys", "Transports", "Chat · files · calls", "Payments · services", "Identity proofs · optional", "Profiles · backup · storage", "Your app"],
    cta: "Build with Ghostly",
    catalog: "Browse the WISPs",
  },
  finale: {
    eyebrow: "08 · Your turn",
    title1: "One little step.",
    title2: "You're a ghost.",
    lead: "Open Ghostly in your browser and invite someone you know. Or take it with you on your desktop.",
    browser: {
      title: "In your browser",
      body: "Nothing to install. Open a tab and create an invitation.",
      cta: "Open app.ghostly.tools",
    },
    desktop: {
      title: "For your computer",
      platforms: {
        mac: "macOS",
        windows: "Windows",
        linux: "Linux",
      },
      installers: {
        macArm: "Apple silicon",
        macIntel: "Intel",
        windowsExe: "Setup",
        windowsMsi: "Package",
        linuxDeb: "Debian / Ubuntu",
        linuxAppImage: "Any distro",
      },
    },
    extension: {
      title: "Browser extension",
      body: "Chrome, Brave, Edge",
      cta: "Add to Chrome",
    },
    cli: { title: "Command line", body: "For scripts, bots and agents.", cta: "CLI guide" },
    all: "All release files",
    conversation: [
      { side: "boo", text: "Boo! 👻" },
      { side: "casper", text: "Found you." },
      { side: "boo", text: "Wanna see my app?" },
      { side: "casper", text: "It's on your localhost…" },
      { side: "boo", text: "Not anymore ✨" },
      { side: "casper", text: "Here, 21 sats ⚡" },
      { side: "boo", text: "See you around." },
      { side: "casper", text: "*poof* 👻" },
    ],
  },
};

export type HomeCopy = typeof en;

const ptBr: HomeCopy = {
  meta: {
    title: "Ghostly: encontre quem você quer. Converse direto, peer to peer.",
    description:
      "Encontre as pessoas que você escolher por um convite privado e converse, envie arquivos e sats, peer to peer. Sem criar conta. Gratuito e de código aberto.",
  },
  rail: "Onde você está na história",
  hero: {
    badge: "Peer to peer · Sem criar conta",
    title1: "Encontre sua gente.",
    title2: "Converse direto.",
    lead: "O Ghostly liga você diretamente às pessoas que você convida, para conversar a dois ou em grupo, mandar arquivos e sats, fazer chamadas e compartilhar o que roda no seu computador.",
    open: "Abrir no navegador",
    download: "Baixar o app",
    micro: "Nada para instalar · Gratuito e de código aberto",
    follow: "Siga o Boo",
    booSays: "Tem alguém aí?",
    skip: "Pular a história",
  },
  statement: {
    before: "",
    accent: "Não há",
    after: " um servidor do Ghostly no meio.",
  },
  invite: {
    eyebrow: "01 · O convite",
    label: "Como funciona um convite",
    steps: [
      {
        title: "Crie um convite.",
        body: "O Boo cria um convite para uma pessoa. Ele guarda as chaves, não uma conta.",
      },
      {
        title: "Compartilhe do seu jeito.",
        body: "Link, QR code ou código de texto. Mande só para quem você quer encontrar.",
      },
      {
        title: "Conecte.",
        body: "O Casper abre, os dois apps se encontram e confirmam. Pronto, vocês estão conversando.",
      },
    ],
    card: { title: "Convite", link: "Link", qr: "QR", code: "Código", forOne: "para uma pessoa" },
  },
  dht: {
    eyebrow: "02 · O ponto de encontro",
    label: "Como os dois apps se encontram na DHT",
    steps: [
      {
        title: "Uma rede pública, sem dono.",
        body: "Os apps se encontram na DHT Mainline, que milhões de usuários de BitTorrent já compartilham. Não há um servidor do Ghostly no meio.",
        note: "Navegadores chegam a ela por relays públicos do Pkarr.",
      },
      {
        title: "Bilhetes pequenos, assinados e selados.",
        body: "O Boo deixa alguns registros minúsculos e assinados na rede. O que importa lá dentro é criptografado.",
      },
      {
        title: "Só o convite abre.",
        body: "O Casper sabe onde procurar e como ler. Quem mais passar vê só registros selados.",
      },
      {
        title: "Depois, eles somem.",
        body: "Só são renovados enquanto você está online. Parou, eles expiram. Cópias que alguém já fez não são apagadas.",
      },
    ],
    tags: { sealed: "selado", ttl: "expira" },
  },
  agree: {
    eyebrow: "03 · O acordo",
    label: "Como os dois lados combinam o que usar",
    steps: [
      {
        title: "Cada lado diz o que sabe fazer.",
        body: "O app desktop do Boo e o navegador do Casper listam o que suportam.",
      },
      {
        title: "Fica o que os dois têm.",
        body: "Só o que está nas duas listas é usado. O resto fica desligado.",
      },
      {
        title: "Um plano que os dois aceitaram.",
        body: "Aqui: chat, arquivos e Cashu por WebRTC. Outros apps, outro plano.",
        note: "Chats com contatos no Ghostly 0.4 mantêm um conjunto fixo.",
      },
    ],
    boo: "Boo · desktop",
    casper: "Casper · navegador",
    plan: "O plano",
  },
  alive: {
    eyebrow: "04 · A conexão ganha vida",
    label: "Como a conversa sai da DHT para uma conexão direta",
    steps: [
      {
        title: "A DHT só fez as apresentações.",
        body: "Quando eles sabem como se alcançar, a conversa sai da DHT.",
      },
      {
        title: "Uma linha direta.",
        body: "Mensagens, arquivos e pagamentos vão por uma conexão ao vivo entre os dois aparelhos: WebRTC, Iroh ou HyperDHT.",
      },
      {
        title: "Sincero sobre o caminho.",
        body: "Servidores STUN públicos ajudam a atravessar os roteadores de casa. Se o caminho direto cai, textos curtos seguem pela DHT.",
        note: "Dá para adicionar seu próprio relay TURN nos ajustes.",
      },
    ],
    pipe: "conexão ao vivo",
    thread: "encontro",
  },
  next: {
    eyebrow: "05 · E depois",
    title: "Agora que vocês estão conectados.",
    lead: "Veja o que o app faz.",
    shot: "Captura de tela do app Ghostly",
    illustration: "Ilustração",
    fromDev: "Ghostly {n}",
    fromOld: "Um build anterior",
    items: [
      {
        id: "chat",
        icon: "chat",
        title: "Diga do seu jeito.",
        body: "Conversas privadas um a um, com confirmação de entrega e histórico local. Sem número de telefone, sem perfil público.",
        extra: "Mensagens de voz, chaves fixadas, nomes e fotos, e mensagens guardadas para um contato ausente.",
      },
      {
        id: "files",
        icon: "file",
        title: "Mande a coisa em si.",
        body: "Fotos, documentos, projetos: direto do seu aparelho para o da outra pessoa, verificados na chegada.",
        extra: "Qualquer tamanho, com os dois online; um arquivo grande continua de onde parou.",
      },
      {
        id: "calls",
        icon: "video",
        title: "Fique mais perto.",
        body: "Voz, vídeo e compartilhamento de tela, um a um. Ligue a câmera ou mostre a tela sem ligar de novo.",
        extra: "Compartilhar a tela exige um computador. As chamadas tocam em todo chat enquanto ele está ao vivo (não pela DHT, nem no desktop Linux, cujo webview não tem WebRTC); grupos ainda não tocam.",
      },
      {
        id: "sats",
        icon: "bolt",
        title: "Um agradinho.",
        body: "Envie ou peça sats na própria conversa: ecash, uma fatura Lightning, ou da carteira que você já usa.",
        extra: "Seu próprio nó ou carteira Lightning (NWC, LND, Core Lightning, WebLN, Breez), Lightning addresses, pagar de qualquer carteira, Ark, Spark, Fedimint, USDT e bitcoin on-chain. Alguns só em redes de teste.",
      },
      {
        id: "groups",
        icon: "group",
        title: "Traga o grupo todo.",
        body: "Um grupo privado de até oito pessoas, ou uma comunidade de até 256 em que entra quem tiver o link. Convide pelos seus chats ou compartilhe o link.",
        extra: "Texto, uma foto do grupo e pagamentos entre membros. Ainda sem arquivos nem chamadas em grupos.",
      },
      {
        id: "identities",
        icon: "badge",
        title: "Prove quem você é. Só para quem você escolher.",
        body: "Vincule uma identidade externa ao seu perfil uma vez (uma chave Nostr ou Pubky, um domínio, uma chave OpenPGP ou SSH, um endereço Bitcoin) e compartilhe com um contato por vez. O app dele verifica no aparelho.",
        extra: "Nunca é exigido para conversar. Retire de um chat, ou revogue em todo lugar.",
      },
      {
        id: "services",
        icon: "window",
        title: "Feito aqui. Aberto lá.",
        body: "Enquanto você está online, deixe um contato abrir um app web que roda no seu computador, como uma galeria de fotos, um painel ou um protótipo.",
        extra: "App desktop ou extensão nas duas pontas; HTTP simples, sem WebSockets. Você escolhe quais contatos veem cada app.",
      },
      {
        id: "cli",
        icon: "terminal",
        title: "Dê voz ao seu código.",
        body: "Um cliente de linha de comando para scripts, bots e agentes: criar identidade e convites, enviar, receber e acompanhar um chat como um fluxo JSON.",
        extra: "Só mensagens de texto. Os convites dela são para outros peers da CLI; conversar com o app exige passar as chaves à mão.",
        link: { label: "Guia da CLI (em inglês)", href: "/cli" },
      },
    ],
  },
  space: {
    eyebrow: "06 · Seu espaço",
    title: "Tudo continua seu, no seu aparelho.",
    lead: "Chats, chaves, carteiras e serviços ficam no app. Nenhum servidor nosso.",
    profiles: {
      title: "Vidas separadas, um aparelho.",
      note: "Os contatos nunca sabem dos outros · web, desktop e extensão",
      names: ["Pessoal", "Trabalho", "Clube"],
    },
    backup: {
      title: "Backup é o quê. Armazenamento é onde.",
      what: "Backup",
      where: "Armazenamento",
      whatItems: ["chats e chaves", "carteiras", "serviços", "ajustes"],
      whereItems: ["um arquivo seu", "S3 · R2 · B2 · MinIO"],
      note: "Selado com a sua senha · restaurar cria um perfil novo, nada é sobrescrito",
    },
    look: {
      title: "Deixe com a sua cara.",
      note: "Quatro temas · claro ou escuro · oito idiomas · trava do app",
    },
  },
  wallets: {
    title: "Uma carteira, muitas formas de pagar.",
    lead: "Cada método de pagamento é um cartão, com as próprias regras. Escolha um para ver o que ele faz e o quanto está pronto.",
    testnet: "Uma chave de Testnet leva todas as carteiras para redes de teste de uma vez.",
    cards: [
      {
        id: "cashu",
        name: "Cashu",
        kind: "ecash",
        net: "main",
        network: "Mainnet",
        body: "Tokens de ecash privados que você pode passar numa conversa. Um mint que você escolhe guarda os fundos.",
        limits: "Confie no mint que escolher: ele vê as próprias operações e guarda os sats que dão lastro.",
      },
      {
        id: "lightning",
        name: "Lightning",
        kind: "faturas",
        net: "main",
        network: "Mainnet",
        body: "Pague e receba faturas Lightning pelo chat, e pague Lightning addresses.",
        limits: "A fonte é o seu mint Cashu, ou seu próprio nó ou carteira: NWC, LND, Core Lightning, uma carteira do navegador (WebLN, só no app web), Breez (só regtest) ou Fedimint (só redes de teste). Qualquer outra carteira paga a sua fatura pelo QR code.",
      },
      {
        id: "ark",
        name: "Ark",
        kind: "via Arkade",
        net: "main",
        network: "Mainnet · experimental",
        body: "Revise e aprove um pagamento Ark exato por um operador fixado.",
        limits: "Experimental. Perfis novos ganham automaticamente uma carteira Ark na mainnet do Bitcoin, mas os pagamentos foram testados só numa rede de teste local, e ainda não há saída unilateral.",
      },
      {
        id: "bark",
        name: "Bark",
        kind: "Ark da Second",
        net: "test",
        network: "Só redes de teste",
        body: "Um segundo provedor de Ark ao lado do Arkade: a mesma ideia, outro servidor, uma forma própria de pagar.",
        limits: "Experimental, no servidor signet da Second ou num regtest local; a Mainnet ainda não cria carteira Bark. Não é intercambiável com o Arkade: uma carteira Bark não paga um endereço Arkade.",
      },
      {
        id: "spark",
        name: "Spark",
        kind: "de carteira para carteira",
        net: "key",
        network: "Mainnet com sua própria chave",
        body: "Bitcoin no Spark, de uma carteira Spark para outra numa conversa. Cada pedido leva uma fatura Spark feita para ele.",
        limits: "Experimental. A Testnet abre sozinha uma carteira regtest; a Mainnet exige a sua própria chave de API da Breez e aparece marcada como dinheiro de verdade. A mesma carteira também pode ser a sua fonte Lightning.",
      },
      {
        id: "fedimint",
        name: "Fedimint",
        kind: "ecash de federação",
        net: "test",
        network: "Só redes de teste",
        body: "Entre numa federação pelo código de convite, depois de ver o nome e os guardiões. Ecash no chat, e Lightning pelo gateway dela.",
        limits: "Experimental. A Mainnet ainda não entra em nenhuma federação. Os guardiões da federação, juntos, guardam os fundos.",
      },
      {
        id: "usdt",
        name: "USDT",
        kind: "Tether WDK",
        net: "main",
        network: "Mainnet · experimental",
        body: "Receba e envie USDT na Ethereum, assinado no seu aparelho.",
        limits: "Experimental. Os pagamentos foram validados numa rede de teste local, não com fundos reais. Só Ethereum; existe um modo de teste na Sepolia.",
      },
      {
        id: "onchain",
        name: "Bitcoin",
        kind: "on-chain",
        net: "test",
        network: "BDK em redes de teste",
        body: "Bitcoin on-chain no chat, por uma carteira BDK ou pelo seu próprio nó Bitcoin Core.",
        limits: "Experimental. BDK só em signet, Mutinynet ou regtest; o Bitcoin Core exige o app desktop. Pagamentos on-chain só são oferecidos dentro de uma sessão pareada aberta.",
      },
    ],
  },
  open: {
    eyebrow: "07 · Por baixo dos fantasmas",
    label: "As peças que formam o Ghostly",
    steps: [
      {
        title: "Tudo o que você acabou de ver…",
        body: "…é um app compondo peças independentes: um núcleo pequeno de encontro, transportes e capacidades como chat, arquivos e pagamentos.",
      },
      {
        title: "…é feito de peças abertas.",
        body: "Cada peça é descrita num WISP, um contrato público em rascunho. Outro app pode implementar só as peças de que precisa e ainda assim encontrar o Ghostly no meio do caminho.",
      },
    ],
    layers: ["Ghost · encontro e chaves", "Transportes", "Chat · arquivos · chamadas", "Pagamentos · serviços", "Provas de identidade · opcional", "Perfis · backup · armazenamento", "O seu app"],
    cta: "Construa com o Ghostly",
    catalog: "Ver os WISPs",
  },
  finale: {
    eyebrow: "08 · Sua vez",
    title1: "Um passinho.",
    title2: "Você já é um fantasma.",
    lead: "Abra o Ghostly no navegador e convide alguém que você conhece. Ou leve com você no desktop.",
    browser: {
      title: "No navegador",
      body: "Nada para instalar. Abra uma aba e crie um convite.",
      cta: "Abrir app.ghostly.tools",
    },
    desktop: {
      title: "Para o seu computador",
      platforms: {
        mac: "macOS",
        windows: "Windows",
        linux: "Linux",
      },
      installers: {
        macArm: "Apple silicon",
        macIntel: "Intel",
        windowsExe: "Instalador",
        windowsMsi: "Pacote",
        linuxDeb: "Debian / Ubuntu",
        linuxAppImage: "Qualquer distro",
      },
    },
    extension: {
      title: "Extensão do navegador",
      body: "Chrome, Brave, Edge",
      cta: "Adicionar ao Chrome",
    },
    cli: { title: "Linha de comando", body: "Para scripts, bots e agentes.", cta: "Guia da CLI (em inglês)" },
    all: "Todos os arquivos da versão",
    conversation: [
      { side: "boo", text: "Buu! 👻" },
      { side: "casper", text: "Achei você." },
      { side: "boo", text: "Quer ver meu app?" },
      { side: "casper", text: "Ele tá no seu localhost…" },
      { side: "boo", text: "Não mais ✨" },
      { side: "casper", text: "Toma, 21 sats ⚡" },
      { side: "boo", text: "Até mais." },
      { side: "casper", text: "*puf* 👻" },
    ],
  },
};

export const home: Localized<HomeCopy> = { en, "pt-br": ptBr };
