
/**
 * Homepage copy. Every capability claim was checked against the code on `dev`
 * (the v1.0 release) and the statuses in docs/wisps/ADAPTER-ROADMAP.md: the page says what the app does, and states each limit
 * (test networks, missing features) in the line it applies to.
 */

/** Where a wallet runs: Mainnet, test networks only, or Mainnet with a key of your own. */
type Net = "main" | "test" | "key";
export const home = {
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
        note: "The desktop app reads it directly. Browsers use public Pkarr relays.",
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
        body: "Private one-to-one conversations. Reply to a message, edit what you sent, react with an emoji, see when they are typing or recording. No phone number, no public profile.",
        extra: "Voice messages you can lock, pause and play at 2x. Delivery marks beside the time, local history, and messages held for a contact who is away.",
      },
      {
        id: "messages",
        icon: "spark",
        title: "Paste it. See it.",
        body: "Rich text with lists, quotes and links, and a card for what you paste: an invite, a payment request, a Nostr profile, a link with its preview.",
        extra: "Your app makes the preview, so your contact's app never opens the link. A seed or a private key asks before it goes.",
      },
      {
        id: "files",
        icon: "file",
        title: "Send the actual thing.",
        body: "Paste a screenshot or drop a file into the chat. It goes straight from your device to theirs, checked on arrival.",
        extra: "Any size, with both of you online. Videos play right in the chat. A big file picks up where it stopped, and a stuck one can be sent again.",
      },
      {
        id: "calls",
        icon: "video",
        title: "Be a little closer.",
        body: "Voice, video and screen sharing, one to one. Turn the camera on or share your screen without calling again.",
        extra: "In the browser, the extension and the desktop app, Linux included. Screen sharing needs a computer, not Linux yet. A call rings while the chat is live, not over the DHT. No group calls yet.",
      },
      {
        id: "sats",
        icon: "bolt",
        title: "A little thank-you.",
        body: "Send or request sats right in the conversation: ecash, a Lightning invoice, or from the wallet you already use.",
        extra: "Real and test wallets side by side, one tab per network, test coins a tap away. Several Lightning cards (NWC, LND, Core Lightning, WebLN, Breez), Lightning addresses, Ark, Spark, Fedimint, USDT and on-chain bitcoin. The BDK on-chain wallet runs on test networks only.",
      },
      {
        id: "groups",
        icon: "group",
        title: "Bring the whole group.",
        body: "A private group of up to 32, or a community of up to 256 that anyone with its link can join. Invite people from your chats or share the link.",
        extra: "Text, @mentions, replies, edits, reactions, a group picture and payments between members. No files or calls in groups yet.",
      },
      {
        id: "identities",
        icon: "badge",
        title: "Prove who you are. Only to whom you choose.",
        body: "Attach an outside identity to your profile once (a Nostr or Pubky key, a domain, an OpenPGP or SSH key, a Bitcoin address, a DID) and share it with one contact at a time. Their app verifies it on the device.",
        extra: "A shared card lands in the chat with its public profile: picture, name, posts. Never required to talk. Withdraw it from one chat, or revoke it everywhere.",
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
        body: "The app's own engine without a screen, for scripts, bots and agents: chats, groups, files, payments and voice calls, with every event as a JSON line.",
        extra: "Needs Node. Built from source until the npm package is published.",
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
      note: "Four themes · light or dark · eight languages · sounds · app lock",
    },
  },
  wallets: {
    title: "One wallet, many ways to pay.",
    lead: "Each payment method is its own card, with its own rules. Pick one to see what it does and how ready it is.",
    testnet: "Real and test wallets live side by side, one tab per network. On Testnet, a button brings free test coins.",
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
        body: "Pay and receive Lightning invoices from the chat, and pay Lightning addresses. Keep several cards; one is the default for receiving.",
        limits: "The source is your Cashu mint, or your own node or wallet: NWC, LND, Core Lightning, a browser wallet (WebLN, web app only), Breez (Mainnet with your own Breez API key) or a Fedimint federation. Any other wallet can pay your invoice from its QR code.",
      },
      {
        id: "ark",
        name: "Ark",
        kind: "via Arkade",
        net: "main" as Net,
        network: "Mainnet · experimental",
        body: "Review and approve an exact Ark payment through a pinned operator.",
        limits: "Experimental. One click from New: Bitcoin mainnet, or Mutinynet on Testnet. Payments were tested only on a local test network, and there is no unilateral exit yet.",
      },
      {
        id: "bark",
        name: "Bark",
        kind: "Second's Ark",
        net: "main" as Net,
        network: "Mainnet · experimental",
        body: "A second Ark provider beside Arkade: same idea, another server, its own way of paying.",
        limits: "Experimental. Mainnet on Second's Bitcoin server, checked against a stand-in server so far; Testnet on its signet. No unilateral exit yet. A Bark wallet cannot pay an Arkade address.",
      },
      {
        id: "spark",
        name: "Spark",
        kind: "wallet to wallet",
        net: "key" as Net,
        network: "Mainnet with your own key",
        body: "Bitcoin on Spark, from one Spark wallet to another in a chat. Each request carries a Spark invoice made for it.",
        limits: "Experimental. Mainnet needs your own Breez API key (free); a Testnet wallet runs on regtest with none. The same wallet can be your Lightning source too.",
      },
      {
        id: "fedimint",
        name: "Fedimint",
        kind: "federation ecash",
        net: "main" as Net,
        network: "Mainnet · experimental",
        body: "Join a federation by its invite code, after seeing its name and guardians. Ecash in the chat, and Lightning through its gateway.",
        limits: "Experimental. Tested on a local test federation, not yet with real funds. The federation's guardians, together, hold the funds.",
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
    cli: { title: "Command line", body: "For bots and agents. Needs Node; built from source for now.", cta: "CLI guide" },
    all: "All release files",
    legal: {
      lead: "Free and open source (MIT). Using Ghostly means you accept the",
      terms: "Terms of Service",
      and: "and have read the",
      privacy: "Privacy Policy",
    },
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

export type HomeCopy = typeof home;
