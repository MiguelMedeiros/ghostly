import type { Localized } from "@/lib/i18n";
import type { Level } from "@/lib/status";

/**
 * Homepage copy. Every capability claim was checked against the code:
 * "released" = v0.4.0 on `main`; "development" = merged on `dev` for 0.5.0.
 */
const en = {
  meta: {
    title: "Ghostly — Find each other. Talk peer to peer.",
    description:
      "Meet the people you choose through a private invitation, then chat, send files and sats, peer to peer. No account to create. Free and open source.",
  },
  hero: {
    badge: "Peer to peer · No account to create",
    title1: "Find your people.",
    title2: "Talk peer to peer.",
    lead: "Ghostly connects you straight to the people you invite — to chat, send files and sats, call, and share what runs on your computer.",
    open: "Open in your browser",
    download: "Download the app",
    micro: "Nothing to install. Free and open source.",
    follow: "Follow Boo",
    booSays: "Is anyone out there?",
    skip: "Skip the story",
  },
  invite: {
    eyebrow: "01 — The invitation",
    label: "How an invitation works",
    steps: [
      {
        title: "Create an invitation.",
        body: "Boo makes an invitation for one person. It holds the keys for this connection — nothing about a public account, because there isn't one.",
      },
      {
        title: "Share it your way.",
        body: "As a link, a QR code or a text code — in person, by message, however you like. Only share it with the person you want to meet.",
        note: "Links work in the current release. Scanning a QR code with the camera arrives with the next one.",
      },
      {
        title: "Connect.",
        body: "Casper opens it, both apps find each other, and the two of you confirm the connection. That's it. You're talking.",
      },
    ],
    card: { title: "Invitation", link: "Link", qr: "QR", code: "Code", forOne: "for one person" },
  },
  dht: {
    eyebrow: "02 — The meeting place",
    label: "How the two apps find each other on the DHT",
    steps: [
      {
        title: "A public network with no owner.",
        body: "To find each other, both apps use the Mainline DHT — millions of computers that already help BitTorrent users meet — through Pkarr. There is no Ghostly server in the middle.",
        note: "Browsers reach the DHT through public Pkarr relays; the desktop app and CLI can also reach it directly.",
      },
      {
        title: "Small, signed, sealed notes.",
        body: "Boo leaves a few tiny records at different places in the network. Each is signed, and what matters inside is encrypted. They are notes, not a mailbox: under a kilobyte each.",
      },
      {
        title: "Only the invitation opens them.",
        body: "Casper knows where to look and how to read, because the invitation says so. Anyone else passing by sees sealed records they can't interpret.",
      },
      {
        title: "Then they fade.",
        body: "Records are republished while you're online. When you stop, nothing refreshes them: they age out of the network and the apps stop accepting old ones. That doesn't erase copies someone may already have made, or the history on your own device.",
      },
    ],
    tags: { sealed: "sealed", ttl: "expires" },
  },
  agree: {
    eyebrow: "03 — The agreement",
    label: "How both sides agree on what to use",
    steps: [
      {
        title: "Each side says what it can do.",
        body: "Boo's desktop app and Casper's browser each list the abilities they support, with versions, and the paths they prefer.",
      },
      {
        title: "They keep what they share.",
        body: "Not a lottery, not magic: only what appears on both lists is used. What one side lacks simply stays off.",
      },
      {
        title: "A plan both agreed to.",
        body: "Chat, files and Cashu, over WebRTC — because that's what these two have in common. Change the apps, and the plan changes with them.",
        note: "Negotiated abilities come with paired chats, in the next release. Chats in the current release use a fixed set.",
      },
    ],
    boo: "Boo · desktop",
    casper: "Casper · browser",
    plan: "The plan",
  },
  alive: {
    eyebrow: "04 — The connection comes alive",
    label: "How the conversation leaves the DHT for a direct connection",
    steps: [
      {
        title: "The DHT only introduced them.",
        body: "Rendezvous records are small on purpose. Once Boo and Casper know how to reach each other, the conversation moves off them.",
      },
      {
        title: "A direct line for the real conversation.",
        body: "Messages, files and payments travel over a live connection between the two devices: WebRTC in the web app, extension and desktop, and Iroh or HyperDHT between desktop apps in the next release. Calls use WebRTC media.",
      },
      {
        title: "Honest about the route.",
        body: "Public STUN servers help the two devices find a route through home routers. If a direct path isn't possible, the connection can fail — you can add your own TURN relay in settings.",
        note: "Very short texts can still travel as DHT records when no live link is up — up to 500 bytes today, 256 bytes in paired chats.",
      },
    ],
    pipe: "live connection",
    thread: "rendezvous",
  },
  next: {
    eyebrow: "05 — What happens next",
    title: "Now that you're connected.",
    lead: "Start with a conversation, then use what your connection can do. Everything here is in the app you can open today, unless the badge says otherwise.",
    shot: "Screenshot of the Ghostly app",
    illustration: "Illustration",
    fromDev: "Development build, {n}",
    fromOld: "Earlier release, 0.3",
    items: [
      {
        id: "chat",
        icon: "chat",
        title: "Say it your way.",
        body: "Private one-to-one conversations with delivery receipts and local history. No phone number, no public profile.",
        level: "released" as Level,
        extra: "Paired chats — with pinned keys, names and pictures — are in development.",
        extraLevel: "development" as Level,
      },
      {
        id: "files",
        icon: "file",
        title: "Send the actual thing.",
        body: "Photos, documents, projects: straight from your device to theirs, checked on arrival.",
        level: "released" as Level,
        extra: "Up to 100 MiB per file, with both of you online.",
      },
      {
        id: "calls",
        icon: "video",
        title: "Be a little closer.",
        body: "Voice, video and screen sharing, one to one.",
        level: "released" as Level,
        extra: "In chats over WebRTC. Screen sharing needs a computer. Paired chats don't have calls yet.",
      },
      {
        id: "sats",
        icon: "bolt",
        title: "A little thank-you.",
        body: "Send or request sats right in the conversation, as Cashu ecash or a Lightning invoice.",
        level: "released" as Level,
        extra: "A Cashu mint you choose holds the funds and handles Lightning. Pick one you trust.",
      },
      {
        id: "services",
        icon: "window",
        title: "Made here. Open there.",
        body: "Let a contact open a web app running on your computer — a photo gallery, a dashboard, a prototype — while you're online.",
        level: "released" as Level,
        extra: "Desktop app or browser extension at both ends. Plain HTTP requests: no WebSockets or streaming. Choosing exactly which contacts see each app is in development.",
      },
      {
        id: "cli",
        icon: "terminal",
        title: "Give your code a voice.",
        body: "A command-line client for scripts, bots and agents: create invitations, send, receive and watch a chat as a JSON stream.",
        level: "released" as Level,
        extra: "Text messages only.",
        link: { label: "CLI guide", href: "/cli" },
      },
    ],
  },
  legend: {
    title: "How to read the badges",
    draft: "Specifications are all Drafts — a separate question from whether something works in the app.",
  },
  space: {
    eyebrow: "06 — Your space",
    title: "Everything stays yours, on your device.",
    lead: "Chats, keys, wallets and services live in the app, not on a server of ours. Keep separate lives apart, take your things with you, make it look like you.",
    profiles: {
      title: "Profiles for each part of your life",
      body: "Personal and Work, side by side on one device — each with its own chats, wallets, services, picture and color. Contacts never learn your other profiles exist.",
      level: "development" as Level,
      note: "Web and desktop. The extension runs a single profile.",
      names: ["Personal", "Work", "Club"],
    },
    backup: {
      title: "Backup is what. Storage is where.",
      body: "A backup seals a whole profile into one bundle with your passphrase. Storage is just where that bundle waits: a file you keep, or any S3-compatible bucket.",
      level: "development" as Level,
      what: "Backup",
      where: "Storage",
      whatItems: ["chats & keys", "wallets", "services", "settings"],
      whereItems: ["a file you keep", "S3 · R2 · B2 · MinIO"],
      note: "Restoring always creates a new profile, so nothing gets overwritten.",
    },
    look: {
      title: "Make it look like you",
      body: "Four color themes, light or dark, eight languages, and a lock for the app.",
      level: "released" as Level,
    },
  },
  wallets: {
    title: "One wallet, many ways to pay.",
    lead: "Each payment method is its own card, with its own rules. Pick one to see what it does and how ready it is.",
    hint: "Choose a card",
    testnet: "A Testnet switch moves every wallet to test networks at once — in development.",
    cards: [
      {
        id: "cashu",
        name: "Cashu",
        kind: "ecash",
        level: "released" as Level,
        body: "Private ecash tokens you can pass along in a chat. A mint you choose holds the funds.",
        limits: "Trust the mint you pick: it can see its own operations and holds the backing sats.",
      },
      {
        id: "lightning",
        name: "Lightning",
        kind: "invoices",
        level: "released" as Level,
        body: "Pay and receive Lightning invoices from the chat.",
        limits: "Today through your Cashu mint. Connecting your own node or wallet (NWC, LND, Core Lightning, WebLN, Breez) is being built.",
        more: "building" as Level,
      },
      {
        id: "ark",
        name: "Ark",
        kind: "via Arkade",
        level: "development" as Level,
        body: "Review and approve an exact Ark payment through a pinned operator.",
        limits: "Experimental. Payments were exercised on a local test network only; leaving Ark on your own is still a release gate. Ark via Bark is being built.",
      },
      {
        id: "usdt",
        name: "USDT",
        kind: "Tether WDK",
        level: "development" as Level,
        body: "Receive and send USDT on Ethereum, signed on your device.",
        limits: "Experimental. Payment flows were validated on a local test chain, not with real funds. Ethereum only; a Sepolia test mode exists.",
      },
      {
        id: "onchain",
        name: "Bitcoin",
        kind: "on-chain",
        level: "building" as Level,
        body: "Plain on-chain bitcoin, through wallet providers such as BDK or your own Bitcoin Core.",
        limits: "Being built. Not in any release yet.",
      },
    ],
  },
  open: {
    eyebrow: "07 — Under the ghosts",
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
    layers: ["Ghost · rendezvous & keys", "Transports", "Chat · files · calls", "Payments · services", "Your app"],
    cta: "Build with Ghostly",
    catalog: "Browse the WISPs",
  },
  finale: {
    eyebrow: "08 — Your turn",
    title1: "One little step.",
    title2: "You're a ghost.",
    lead: "Open Ghostly in your browser and invite someone you know. Or take it with you on your desktop.",
    browser: {
      title: "In your browser",
      body: "Nothing to install. Open a tab and create an invitation.",
      cta: "Open app.ghostly.tools",
    },
    desktop: {
      title: "On your desktop",
      body: "macOS, Windows and Linux.",
    },
    extension: {
      title: "Browser extension",
      body: "Chrome and Chromium browsers, as a .zip to load unpacked.",
      cta: "Download the .zip",
    },
    cli: { title: "Command line", body: "For scripts, bots and agents.", cta: "CLI guide" },
    note: "Downloads are the public release, v{v}. Features marked “in development” arrive with {n}.",
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
    title: "Ghostly — Encontre quem você quer. Converse direto, peer to peer.",
    description:
      "Encontre as pessoas que você escolher por um convite privado e converse, envie arquivos e sats, peer to peer. Sem criar conta. Gratuito e de código aberto.",
  },
  hero: {
    badge: "Peer to peer · Sem criar conta",
    title1: "Encontre sua gente.",
    title2: "Converse direto.",
    lead: "O Ghostly liga você diretamente às pessoas que você convida — para conversar, mandar arquivos e sats, fazer chamadas e compartilhar o que roda no seu computador.",
    open: "Abrir no navegador",
    download: "Baixar o app",
    micro: "Nada para instalar. Gratuito e de código aberto.",
    follow: "Siga o Boo",
    booSays: "Tem alguém aí?",
    skip: "Pular a história",
  },
  invite: {
    eyebrow: "01 — O convite",
    label: "Como funciona um convite",
    steps: [
      {
        title: "Crie um convite.",
        body: "O Boo cria um convite para uma pessoa. Ele guarda as chaves desta conexão — nada de conta pública, porque não existe uma.",
      },
      {
        title: "Compartilhe do seu jeito.",
        body: "Como link, QR code ou código de texto — pessoalmente, por mensagem, como preferir. Compartilhe só com quem você quer encontrar.",
        note: "Links funcionam na versão atual. Escanear um QR code com a câmera chega na próxima.",
      },
      {
        title: "Conecte.",
        body: "O Casper abre o convite, os dois apps se encontram e vocês confirmam a conexão. Pronto. Já estão conversando.",
      },
    ],
    card: { title: "Convite", link: "Link", qr: "QR", code: "Código", forOne: "para uma pessoa" },
  },
  dht: {
    eyebrow: "02 — O ponto de encontro",
    label: "Como os dois apps se encontram na DHT",
    steps: [
      {
        title: "Uma rede pública, sem dono.",
        body: "Para se acharem, os dois apps usam a DHT Mainline — milhões de computadores que já ajudam usuários de BitTorrent a se encontrar — por meio do Pkarr. Não há um servidor do Ghostly no meio.",
        note: "Navegadores chegam à DHT por relays públicos do Pkarr; o app desktop e a CLI também falam com ela diretamente.",
      },
      {
        title: "Bilhetes pequenos, assinados e selados.",
        body: "O Boo deixa alguns registros minúsculos em lugares diferentes da rede. Cada um é assinado, e o que importa lá dentro é criptografado. São bilhetes, não uma caixa postal: menos de um kilobyte cada.",
      },
      {
        title: "Só o convite abre.",
        body: "O Casper sabe onde procurar e como ler, porque o convite diz. Quem passar por ali vê registros selados que não consegue interpretar.",
      },
      {
        title: "Depois, eles somem.",
        body: "Os registros são republicados enquanto você está online. Quando você para, ninguém os renova: eles envelhecem para fora da rede e os apps deixam de aceitar os antigos. Isso não apaga cópias que alguém já tenha feito, nem o histórico no seu aparelho.",
      },
    ],
    tags: { sealed: "selado", ttl: "expira" },
  },
  agree: {
    eyebrow: "03 — O acordo",
    label: "Como os dois lados combinam o que usar",
    steps: [
      {
        title: "Cada lado diz o que sabe fazer.",
        body: "O app desktop do Boo e o navegador do Casper listam as capacidades que suportam, com versões, e os caminhos que preferem.",
      },
      {
        title: "Fica o que os dois têm.",
        body: "Não é sorteio nem mágica: só o que aparece nas duas listas é usado. O que falta de um lado simplesmente fica desligado.",
      },
      {
        title: "Um plano que os dois aceitaram.",
        body: "Chat, arquivos e Cashu, por WebRTC — porque é isso que esses dois têm em comum. Troque os apps, e o plano muda junto.",
        note: "Capacidades negociadas chegam com os chats pareados, na próxima versão. Os chats da versão atual usam um conjunto fixo.",
      },
    ],
    boo: "Boo · desktop",
    casper: "Casper · navegador",
    plan: "O plano",
  },
  alive: {
    eyebrow: "04 — A conexão ganha vida",
    label: "Como a conversa sai da DHT para uma conexão direta",
    steps: [
      {
        title: "A DHT só fez as apresentações.",
        body: "Os registros de encontro são pequenos de propósito. Quando Boo e Casper sabem como se alcançar, a conversa sai deles.",
      },
      {
        title: "Uma linha direta para a conversa de verdade.",
        body: "Mensagens, arquivos e pagamentos vão por uma conexão ao vivo entre os dois aparelhos: WebRTC no app web, na extensão e no desktop, e Iroh ou HyperDHT entre apps desktop na próxima versão. Chamadas usam mídia WebRTC.",
      },
      {
        title: "Sincero sobre o caminho.",
        body: "Servidores STUN públicos ajudam os aparelhos a achar uma rota através dos roteadores de casa. Se não houver caminho direto, a conexão pode falhar — dá para adicionar seu próprio relay TURN nos ajustes.",
        note: "Textos bem curtos ainda podem viajar como registros na DHT quando não há link ao vivo — até 500 bytes hoje, 256 bytes nos chats pareados.",
      },
    ],
    pipe: "conexão ao vivo",
    thread: "encontro",
  },
  next: {
    eyebrow: "05 — E depois",
    title: "Agora que vocês estão conectados.",
    lead: "Comece com uma conversa e use o que a sua conexão consegue fazer. Tudo aqui está no app que você pode abrir hoje, a menos que o selo diga outra coisa.",
    shot: "Captura de tela do app Ghostly",
    illustration: "Ilustração",
    fromDev: "Build de desenvolvimento, {n}",
    fromOld: "Versão anterior, 0.3",
    items: [
      {
        id: "chat",
        icon: "chat",
        title: "Diga do seu jeito.",
        body: "Conversas privadas um a um, com confirmação de entrega e histórico local. Sem número de telefone, sem perfil público.",
        level: "released",
        extra: "Chats pareados — com chaves fixadas, nomes e fotos — estão em desenvolvimento.",
        extraLevel: "development",
      },
      {
        id: "files",
        icon: "file",
        title: "Mande a coisa em si.",
        body: "Fotos, documentos, projetos: direto do seu aparelho para o da outra pessoa, verificados na chegada.",
        level: "released",
        extra: "Até 100 MiB por arquivo, com os dois online.",
      },
      {
        id: "calls",
        icon: "video",
        title: "Fique mais perto.",
        body: "Voz, vídeo e compartilhamento de tela, um a um.",
        level: "released",
        extra: "Em chats sobre WebRTC. Compartilhar a tela exige um computador. Os chats pareados ainda não têm chamadas.",
      },
      {
        id: "sats",
        icon: "bolt",
        title: "Um agradinho.",
        body: "Envie ou peça sats na própria conversa, como ecash Cashu ou uma fatura Lightning.",
        level: "released",
        extra: "Um mint Cashu que você escolhe guarda os fundos e cuida da Lightning. Escolha um em que você confia.",
      },
      {
        id: "services",
        icon: "window",
        title: "Feito aqui. Aberto lá.",
        body: "Deixe um contato abrir um app web que roda no seu computador — uma galeria de fotos, um painel, um protótipo — enquanto você está online.",
        level: "released",
        extra: "App desktop ou extensão nas duas pontas. Pedidos HTTP simples: sem WebSockets nem streaming. Escolher exatamente quais contatos veem cada app está em desenvolvimento.",
      },
      {
        id: "cli",
        icon: "terminal",
        title: "Dê voz ao seu código.",
        body: "Um cliente de linha de comando para scripts, bots e agentes: criar convites, enviar, receber e acompanhar um chat como um fluxo JSON.",
        level: "released",
        extra: "Só mensagens de texto.",
        link: { label: "Guia da CLI (em inglês)", href: "/cli" },
      },
    ],
  },
  legend: {
    title: "Como ler os selos",
    draft: "Todas as especificações são Drafts — uma pergunta diferente de o recurso funcionar ou não no app.",
  },
  space: {
    eyebrow: "06 — Seu espaço",
    title: "Tudo continua seu, no seu aparelho.",
    lead: "Chats, chaves, carteiras e serviços ficam no app, não num servidor nosso. Separe as partes da sua vida, leve suas coisas com você, deixe com a sua cara.",
    profiles: {
      title: "Perfis para cada parte da sua vida",
      body: "Pessoal e Trabalho, lado a lado no mesmo aparelho — cada um com seus chats, carteiras, serviços, foto e cor. Os contatos nunca ficam sabendo dos seus outros perfis.",
      level: "development",
      note: "Web e desktop. A extensão roda um único perfil.",
      names: ["Pessoal", "Trabalho", "Clube"],
    },
    backup: {
      title: "Backup é o quê. Armazenamento é onde.",
      body: "Um backup sela um perfil inteiro num pacote com a sua senha. O armazenamento é só onde esse pacote espera: um arquivo que você guarda, ou qualquer bucket compatível com S3.",
      level: "development",
      what: "Backup",
      where: "Armazenamento",
      whatItems: ["chats e chaves", "carteiras", "serviços", "ajustes"],
      whereItems: ["um arquivo seu", "S3 · R2 · B2 · MinIO"],
      note: "Restaurar sempre cria um perfil novo, então nada é sobrescrito.",
    },
    look: {
      title: "Deixe com a sua cara",
      body: "Quatro temas de cor, claro ou escuro, oito idiomas e uma trava para o app.",
      level: "released",
    },
  },
  wallets: {
    title: "Uma carteira, muitas formas de pagar.",
    lead: "Cada método de pagamento é um cartão, com as próprias regras. Escolha um para ver o que ele faz e o quanto está pronto.",
    hint: "Escolha um cartão",
    testnet: "Uma chave de Testnet leva todas as carteiras para redes de teste de uma vez — em desenvolvimento.",
    cards: [
      {
        id: "cashu",
        name: "Cashu",
        kind: "ecash",
        level: "released",
        body: "Tokens de ecash privados que você pode passar numa conversa. Um mint que você escolhe guarda os fundos.",
        limits: "Confie no mint que escolher: ele vê as próprias operações e guarda os sats que dão lastro.",
      },
      {
        id: "lightning",
        name: "Lightning",
        kind: "faturas",
        level: "released",
        body: "Pague e receba faturas Lightning pelo chat.",
        limits: "Hoje por meio do seu mint Cashu. Conectar seu próprio nó ou carteira (NWC, LND, Core Lightning, WebLN, Breez) está sendo construído.",
        more: "building",
      },
      {
        id: "ark",
        name: "Ark",
        kind: "via Arkade",
        level: "development",
        body: "Revise e aprove um pagamento Ark exato por um operador fixado.",
        limits: "Experimental. Os pagamentos foram exercitados só numa rede de teste local; sair do Ark por conta própria ainda é requisito de lançamento. Ark via Bark está sendo construído.",
      },
      {
        id: "usdt",
        name: "USDT",
        kind: "Tether WDK",
        level: "development",
        body: "Receba e envie USDT na Ethereum, assinado no seu aparelho.",
        limits: "Experimental. Os pagamentos foram validados numa rede de teste local, não com fundos reais. Só Ethereum; existe um modo de teste na Sepolia.",
      },
      {
        id: "onchain",
        name: "Bitcoin",
        kind: "on-chain",
        level: "building",
        body: "Bitcoin on-chain comum, por provedores de carteira como BDK ou o seu próprio Bitcoin Core.",
        limits: "Em construção. Ainda não está em nenhuma versão.",
      },
    ],
  },
  open: {
    eyebrow: "07 — Por baixo dos fantasmas",
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
    layers: ["Ghost · encontro e chaves", "Transportes", "Chat · arquivos · chamadas", "Pagamentos · serviços", "O seu app"],
    cta: "Construa com o Ghostly",
    catalog: "Ver os WISPs",
  },
  finale: {
    eyebrow: "08 — Sua vez",
    title1: "Um passinho.",
    title2: "Você já é um fantasma.",
    lead: "Abra o Ghostly no navegador e convide alguém que você conhece. Ou leve com você no desktop.",
    browser: {
      title: "No navegador",
      body: "Nada para instalar. Abra uma aba e crie um convite.",
      cta: "Abrir app.ghostly.tools",
    },
    desktop: {
      title: "No desktop",
      body: "macOS, Windows e Linux.",
    },
    extension: {
      title: "Extensão do navegador",
      body: "Chrome e navegadores Chromium, como .zip para carregar sem empacotar.",
      cta: "Baixar o .zip",
    },
    cli: { title: "Linha de comando", body: "Para scripts, bots e agentes.", cta: "Guia da CLI" },
    note: "Os downloads são a versão pública, v{v}. Recursos marcados “em desenvolvimento” chegam com a {n}.",
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
