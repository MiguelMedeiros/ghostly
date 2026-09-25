import type { Level } from "./status";
import type { Localized } from "./i18n";

/**
 * Editorial layer over the WISP drafts: the family a draft is presented in, a
 * one-line benefit, and its availability as checked in the code on `dev` (the
 * 0.5.0 release): "available" when the app runs it. Numbers, titles, status
 * and dependencies come from the documents, never from here.
 */
export type GroupId =
  | "meet"
  | "connect"
  | "talk"
  | "files"
  | "calls"
  | "pay"
  | "services"
  | "identity"
  | "keep"
  | "together";

export const GROUPS: {
  id: GroupId;
  ranges: [number, number][];
  order?: string[];
  title: Localized<string>;
  blurb: Localized<string>;
  icon: string;
}[] = [
  {
    id: "meet",
    ranges: [[0, 3], [6, 99], [800, 899]],
    order: ["00", "01", "02", "03", "800", "801"],
    icon: "spark",
    title: { en: "Meet", "pt-br": "Encontro" },
    blurb: {
      en: "The small core: rendezvous records, keys, invitations and agreeing on what both sides support.",
      "pt-br": "O núcleo pequeno: registros de encontro, chaves, convites e o acordo sobre o que os dois lados suportam.",
    },
  },
  {
    id: "connect",
    ranges: [[100, 199]],
    icon: "route",
    title: { en: "Connect", "pt-br": "Conexão" },
    blurb: {
      en: "Choosing a data path both peers share, and the adapters that provide one.",
      "pt-br": "A escolha de um caminho de dados que os dois peers compartilham, e os adapters que o oferecem.",
    },
  },
  {
    id: "talk",
    ranges: [[400, 499]],
    icon: "chat",
    title: { en: "Chat", "pt-br": "Conversa" },
    blurb: {
      en: "Messages with explicit receipts and retries: over a live link, the bounded DHT path, or held in your own storage for a contact who is away.",
      "pt-br": "Mensagens com confirmações e novas tentativas explícitas: por um link ao vivo, pelo caminho limitado da DHT ou guardadas no seu próprio armazenamento para um contato ausente.",
    },
  },
  {
    id: "files",
    ranges: [[500, 599]],
    icon: "file",
    title: { en: "Files", "pt-br": "Arquivos" },
    blurb: {
      en: "Bounded, verified file transfer while both people are online.",
      "pt-br": "Transferência de arquivos limitada e verificada, com as duas pessoas online.",
    },
  },
  {
    id: "calls",
    ranges: [[600, 699]],
    icon: "video",
    title: { en: "Voice & video", "pt-br": "Voz e vídeo" },
    blurb: {
      en: "Real-time media coordinated separately from the data stream.",
      "pt-br": "Mídia em tempo real, coordenada separadamente do fluxo de dados.",
    },
  },
  {
    id: "pay",
    ranges: [[200, 299]],
    icon: "bolt",
    title: { en: "Payments", "pt-br": "Pagamentos" },
    blurb: {
      en: "Negotiate a payment method, carry the request, let a wallet adapter do the rest.",
      "pt-br": "Negociar um método de pagamento, levar o pedido e deixar um adapter de carteira fazer o resto.",
    },
  },
  {
    id: "services",
    ranges: [[700, 799]],
    icon: "window",
    title: { en: "Local services", "pt-br": "Serviços locais" },
    blurb: {
      en: "Let a contact open something running on your computer, and take it back.",
      "pt-br": "Deixar um contato abrir algo que roda no seu computador, e retirar o acesso.",
    },
  },
  {
    id: "identity",
    ranges: [[300, 399]],
    icon: "badge",
    title: { en: "Identity proofs", "pt-br": "Provas de identidade" },
    blurb: {
      en: "Optional proofs that you control an outside identity. Never required to talk.",
      "pt-br": "Provas opcionais de que você controla uma identidade externa. Nunca exigidas para conversar.",
    },
  },
  {
    id: "keep",
    ranges: [[4, 5], [1000, 1099]],
    order: ["04", "05", "1000", "1001", "1002"],
    icon: "box",
    title: { en: "Profiles & storage", "pt-br": "Perfis e armazenamento" },
    blurb: {
      en: "Separate lives on one device, sealed backups, and where those backups are kept.",
      "pt-br": "Vidas separadas no mesmo aparelho, backups selados e onde esses backups ficam guardados.",
    },
  },
  {
    id: "together",
    ranges: [[900, 999]],
    order: ["900", "902", "901"],
    icon: "group",
    title: { en: "Groups", "pt-br": "Grupos" },
    blurb: {
      en: "Private groups of up to eight and communities of up to 256: text, a picture and payments between members.",
      "pt-br": "Grupos privados de até oito pessoas e comunidades de até 256: texto, uma foto e pagamentos entre membros.",
    },
  },
];

type Entry = {
  group?: GroupId;
  benefit: Localized<string>;
  level: Level | null;
  note?: Localized<string>;
  feature?: Localized<{ label: string; href: string }>;
  video?: { src: string; poster?: string; chapters?: { at: number; title: string }[] };
};

const inApp = (anchor: string, en: string, pt: string): Localized<{ label: string; href: string }> => ({
  en: { label: en, href: `/#${anchor}` },
  "pt-br": { label: pt, href: `/pt-br#${anchor}` },
});

export const editorial: Record<string, Entry> = {
  "00-process": {
    benefit: {
      en: "How a WISP is written, reviewed and numbered, and what Draft, Proposed and Final mean.",
      "pt-br": "Como um WISP é escrito, revisado e numerado, e o que significam Draft, Proposed e Final.",
    },
    level: null,
  },
  "01-ghost-core": {
    benefit: {
      en: "Find a peer through small signed records on the Mainline DHT, without turning discovery into storage.",
      "pt-br": "Encontrar um peer por pequenos registros assinados na DHT Mainline, sem transformar a descoberta em armazenamento.",
    },
    level: "available",
    note: {
      en: "The rendezvous exists since the first release; the modular boundary is a proposal.",
      "pt-br": "O encontro existe desde a primeira versão; a fronteira modular é uma proposta.",
    },
    feature: inApp("dht", "The meeting on the DHT", "O encontro na DHT"),
  },
  "02-peer-keys": {
    benefit: {
      en: "A fresh identity for every connection, and pinning the key of the person you paired with.",
      "pt-br": "Uma identidade nova para cada conexão, e fixar a chave da pessoa com quem você pareou.",
    },
    level: "available",
  },
  "03-capabilities": {
    benefit: {
      en: "Both sides announce versioned abilities and only use what they have in common.",
      "pt-br": "Os dois lados anunciam capacidades versionadas e usam só o que têm em comum.",
    },
    level: "available",
    note: {
      en: "Negotiated offers are part of paired chats. Chats started with an older version keep a fixed set.",
      "pt-br": "As ofertas negociadas fazem parte dos chats pareados. Chats iniciados numa versão anterior mantêm um conjunto fixo.",
    },
    feature: inApp("agree", "The agreement", "O acordo"),
  },
  "04-profiles": {
    benefit: {
      en: "Keep separate lives on one device (chats, wallets, services and settings), never announced to contacts.",
      "pt-br": "Manter vidas separadas num aparelho (chats, carteiras, serviços e ajustes), sem anunciar isso aos contatos.",
    },
    level: "available",
    note: {
      en: "Web, desktop and extension. Switch from the account bar in one tap.",
      "pt-br": "Web, desktop e extensão. Troque pela barra da conta com um toque.",
    },
    feature: inApp("space", "Your space", "Seu espaço"),
  },
  "05-backups": {
    benefit: {
      en: "Bring a whole profile back from one passphrase-sealed bundle.",
      "pt-br": "Trazer um perfil inteiro de volta a partir de um pacote selado por senha.",
    },
    level: "available",
    note: {
      en: "Web, desktop and extension. A restore always creates a new profile; nothing is overwritten.",
      "pt-br": "Web, desktop e extensão. Uma restauração sempre cria um perfil novo; nada é sobrescrito.",
    },
    feature: inApp("space", "Your space", "Seu espaço"),
  },
  "100-transports": {
    benefit: {
      en: "Pick a data path both peers support, in order of preference; fall back only when both allow it.",
      "pt-br": "Escolher um caminho de dados que os dois suportam, por ordem de preferência; trocar só quando os dois permitem.",
    },
    level: "available",
    feature: inApp("alive", "The connection comes alive", "A conexão ganha vida"),
  },
  "101-webrtc": {
    benefit: {
      en: "Carry a session over a WebRTC data channel, the path every Ghostly app has today.",
      "pt-br": "Levar a sessão por um canal de dados WebRTC, o caminho que todo app Ghostly tem hoje.",
    },
    level: "available",
    note: {
      en: "Browser, extension and desktop. May use STUN/TURN servers to get through networks.",
      "pt-br": "Navegador, extensão e desktop. Pode usar servidores STUN/TURN para atravessar redes.",
    },
  },
  "102-iroh": {
    benefit: {
      en: "Use an Iroh QUIC endpoint, with Ghostly authentication bound to the connection.",
      "pt-br": "Usar um endpoint QUIC do Iroh, com a autenticação do Ghostly amarrada à conexão.",
    },
    level: "available",
    note: {
      en: "Desktop app only, in paired chats, after a first WebRTC pairing.",
      "pt-br": "Só no app desktop, em chats pareados, depois de um primeiro pareamento por WebRTC.",
    },
  },
  "103-hyperdht": {
    benefit: {
      en: "Use an authenticated Noise stream found through HyperDHT.",
      "pt-br": "Usar um fluxo Noise autenticado, encontrado pela HyperDHT.",
    },
    level: "available",
    note: {
      en: "Desktop app only, in paired chats, after a first WebRTC pairing.",
      "pt-br": "Só no app desktop, em chats pareados, depois de um primeiro pareamento por WebRTC.",
    },
  },
  "200-payments": {
    benefit: {
      en: "Agree on a payment method and carry the request; the wallet adapter moves the value.",
      "pt-br": "Combinar um método de pagamento e levar o pedido; o adapter da carteira movimenta o valor.",
    },
    level: "available",
    note: {
      en: "Methods are negotiated in paired chats, and in groups between two members. Any wallet can pay a request from its QR code or link; it is settled only when the payee's own wallet sees the money.",
      "pt-br": "Os métodos são negociados nos chats pareados, e nos grupos entre dois membros. Qualquer carteira paga um pedido pelo QR code ou link; ele só é liquidado quando a carteira de quem recebe vê o dinheiro.",
    },
    feature: inApp("next", "Send sats", "Enviar sats"),
  },
  "201-cashu": {
    benefit: {
      en: "Send and receive ecash tokens in the conversation; a mint you choose holds the funds.",
      "pt-br": "Enviar e receber tokens de ecash na conversa; um mint que você escolhe guarda os fundos.",
    },
    level: "available",
    feature: inApp("wallets", "Wallets", "Carteiras"),
  },
  "202-arkade": {
    benefit: {
      en: "Review and approve an exact Ark payment through a pinned operator.",
      "pt-br": "Revisar e aprovar um pagamento Ark exato por um operador fixado.",
    },
    level: "available",
    note: {
      en: "Experimental. New profiles get a Bitcoin mainnet wallet automatically; payment flows were exercised only on a local regtest network. There is no unilateral exit yet.",
      "pt-br": "Experimental. Perfis novos ganham automaticamente uma carteira na mainnet do Bitcoin; os pagamentos foram exercitados só numa rede regtest local. Ainda não há saída unilateral.",
    },
    feature: inApp("wallets", "Wallets", "Carteiras"),
  },
  "203-lightning": {
    benefit: {
      en: "Carry a Lightning invoice in the chat and pay or receive it through the wallet.",
      "pt-br": "Levar uma fatura Lightning no chat e pagá-la ou recebê-la pela carteira.",
    },
    level: "available",
    note: {
      en: "The Lightning source is your Cashu mint or your own node or wallet: NWC, LND, Core Lightning, WebLN in the web app, Breez (regtest only) or a Fedimint federation (test networks only). Any other wallet can pay the invoice from its QR code.",
      "pt-br": "A fonte Lightning é o seu mint Cashu ou seu próprio nó ou carteira: NWC, LND, Core Lightning, WebLN no app web, Breez (só regtest) ou uma federação Fedimint (só redes de teste). Qualquer outra carteira paga a fatura pelo QR code.",
    },
    feature: inApp("wallets", "Wallets", "Carteiras"),
  },
  "204-bark": {
    benefit: {
      en: "A second Ark provider (Second's Bark) beside Arkade, so Ark isn't tied to one implementation.",
      "pt-br": "Um segundo provedor de Ark (o Bark, da Second) ao lado do Arkade, para o Ark não depender de uma implementação.",
    },
    level: "available",
    note: {
      en: "Experimental, test networks only (Second's signet server or a local regtest); Mainnet makes no Bark wallet yet. Not interchangeable with Arkade: its own payment method and capability.",
      "pt-br": "Experimental, só em redes de teste (o servidor signet da Second ou um regtest local); a Mainnet ainda não cria carteira Bark. Não é intercambiável com o Arkade: método e capacidade próprios.",
    },
    feature: inApp("wallets", "Wallets", "Carteiras"),
  },
  "205-lnurl": {
    benefit: {
      en: "Pay a Lightning address (name@domain) or an LNURL from the wallet or straight from a chat, through your Lightning source.",
      "pt-br": "Pagar um Lightning address (nome@domínio) ou um LNURL pela carteira ou direto do chat, pela sua fonte Lightning.",
    },
    level: "available",
    note: {
      en: "Paying only: receiving on an address needs a server you run. The domain is named before anything is fetched, and the service must allow cross-origin reads.",
      "pt-br": "Só pagar: receber num endereço exige um servidor seu. O domínio é mostrado antes de qualquer consulta, e o serviço precisa liberar leituras de outra origem (CORS).",
    },
    feature: inApp("wallets", "Wallets", "Carteiras"),
  },
  "2xx-spark": {
    benefit: {
      en: "Pay a contact who also has Spark straight from wallet to wallet: instant, off-chain, no Lightning hop.",
      "pt-br": "Pagar um contato que também tem Spark direto de carteira para carteira: instantâneo, fora da cadeia, sem passar pela Lightning.",
    },
    level: "available",
    note: {
      en: "Experimental. Testnet runs on Breez's hosted regtest with no key; Mainnet needs a Breez API key and moves real bitcoin. The same wallet can be your Lightning source.",
      "pt-br": "Experimental. A Testnet roda no regtest hospedado da Breez, sem chave; a Mainnet precisa de uma chave de API da Breez e movimenta bitcoin de verdade. A mesma carteira pode ser sua fonte Lightning.",
    },
    feature: inApp("wallets", "Wallets", "Carteiras"),
  },
  "2xx-fedimint": {
    benefit: {
      en: "Ecash from a federation of guardians you choose: in a chat, and Lightning through the federation's gateway.",
      "pt-br": "Ecash de uma federação de guardiões que você escolhe: no chat, e Lightning pelo gateway da federação.",
    },
    level: "available",
    note: {
      en: "Experimental, test networks only: Mainnet joins no federation yet. You see a federation's name, guardians and network before joining. Number not yet assigned.",
      "pt-br": "Experimental, só em redes de teste: a Mainnet ainda não entra em nenhuma federação. Você vê o nome, os guardiões e a rede de uma federação antes de entrar. Número ainda não atribuído.",
    },
    feature: inApp("wallets", "Wallets", "Carteiras"),
  },
  "300-peer-proofs": {
    benefit: {
      en: "Optionally prove to one contact that you control an outside identity. Never required.",
      "pt-br": "Provar, se quiser, a um contato que você controla uma identidade externa. Nunca é obrigatório.",
    },
    level: "available",
    note: {
      en: "Rebuilt on 2026-09-23: a proof is made once in Profile → Identities, shared per chat only when you choose, withdrawable and revocable through a DHT record. Web, desktop and extension; not the CLI.",
      "pt-br": "Refeito em 23/09/2026: a prova é feita uma vez em Perfil → Identidades, compartilhada por chat só quando você quiser, retirável e revogável por um registro na DHT. Web, desktop e extensão; não a CLI.",
    },
  },
  "301-nostr": {
    benefit: {
      en: "An optional Nostr proof, and where a signer's authority ends.",
      "pt-br": "Uma prova Nostr opcional, e onde termina a autoridade de um signer.",
    },
    level: "available",
    note: {
      en: "Signed once with a NIP-07 browser extension (web app, desktop) or a NIP-46 remote signer. A proof, not a transport, and not permission to publish.",
      "pt-br": "Assinada uma vez com uma extensão NIP-07 (app web, desktop) ou um signer remoto NIP-46. Uma prova, não um transporte, nem permissão para publicar.",
    },
  },
  "3xx-nostr-social": {
    group: "identity",
    benefit: {
      en: "What a proven Nostr key lets a contact see (profile, follows, notes) and, if you turn it on, posting through your own signer.",
      "pt-br": "O que uma chave Nostr provada deixa um contato ver (perfil, quem segue, notas) e, se você ligar, publicar pelo seu próprio signer.",
    },
    level: "available",
    note: {
      en: "Experimental. Loaded only on request, from relays you choose; publishing is off by default and each post is confirmed. Web, desktop and extension (NIP-46 only there). Number not yet assigned.",
      "pt-br": "Experimental. Carregado só quando você pede, dos relays que você escolhe; publicar vem desligado e cada post é confirmado. Web, desktop e extensão (lá só NIP-46). Número ainda não atribuído.",
    },
  },
  "3xx-domain": {
    group: "identity",
    benefit: {
      en: "Show a contact that you control a domain, with a DNS record or a file on your site.",
      "pt-br": "Mostrar a um contato que você controla um domínio, com um registro DNS ou um arquivo no seu site.",
    },
    level: "available",
    note: {
      en: "Experimental. Looked up through a DNS-over-HTTPS resolver the contact chooses and re-checked after a day, so removing the record withdraws the proof. Number not yet assigned.",
      "pt-br": "Experimental. Consultada por um resolvedor DNS-over-HTTPS que o contato escolhe e reverificada depois de um dia, então remover o registro retira a prova. Número ainda não atribuído.",
    },
  },
  "3xx-openpgp": {
    group: "identity",
    benefit: {
      en: "Sign the statement once with your own gpg (a YubiKey works unchanged), and the contact verifies it locally.",
      "pt-br": "Assinar a declaração uma vez com o seu próprio gpg (uma YubiKey funciona igual), e o contato verifica localmente.",
    },
    level: "available",
    note: {
      en: "Holding a key proves nothing about the name or email in its user ID, and the app says so. Number not yet assigned.",
      "pt-br": "Ter a chave não prova nada sobre o nome ou e-mail do user ID, e o app diz isso. Número ainda não atribuído.",
    },
  },
  "3xx-bitcoin": {
    group: "identity",
    benefit: {
      en: "Prove you hold the key behind a Bitcoin address with one BIP-322 signature from your wallet.",
      "pt-br": "Provar que você tem a chave de um endereço Bitcoin com uma assinatura BIP-322 da sua carteira.",
    },
    level: "available",
    note: {
      en: "Experimental. Checked on the device with no blockchain lookup; proves no balance, past payment or willingness to pay. Number not yet assigned.",
      "pt-br": "Experimental. Verificada no aparelho, sem consultar a blockchain; não prova saldo, pagamento passado nem disposição para pagar. Número ainda não atribuído.",
    },
  },
  "3xx-ssh": {
    group: "identity",
    benefit: {
      en: "An SSH key signs once with ssh-keygen; a GitHub or GitLab account counts through the keys it publishes.",
      "pt-br": "Uma chave SSH assina uma vez com ssh-keygen; uma conta GitHub ou GitLab conta pelas chaves que publica.",
    },
    level: "available",
    note: {
      en: "Experimental. Never grants a server login. Number not yet assigned.",
      "pt-br": "Experimental. Nunca dá acesso a servidor nenhum. Número ainda não atribuído.",
    },
  },
  "3xx-oidc-proofs": {
    group: "identity",
    benefit: {
      en: "Show a contact that an account at Google, Microsoft, Apple, GitLab or Twitch signed in for this conversation.",
      "pt-br": "Mostrar a um contato que uma conta no Google, Microsoft, Apple, GitLab ou Twitch fez login para esta conversa.",
    },
    level: "planned",
    note: {
      en: "Attested by the provider, not a key you hold; the contact trusts that company. Built, but not offered until the maintainer registers Ghostly's OAuth clients. Number not yet assigned.",
      "pt-br": "Atestada pelo provedor, não por uma chave sua; o contato confia nessa empresa. Pronta, mas só oferecida quando o mantenedor registrar os clientes OAuth do Ghostly. Número ainda não atribuído.",
    },
  },
  "302-pubky": {
    benefit: {
      en: "Explore a Pubky identity binding. Using Pkarr is not, by itself, a Pubky integration.",
      "pt-br": "Explorar um vínculo com identidade Pubky. Usar Pkarr não é, por si só, uma integração Pubky.",
    },
    level: "research",
    note: {
      en: "Deferred; number not yet assigned.",
      "pt-br": "Adiado; número ainda não atribuído.",
    },
  },
  "303-keet": {
    benefit: {
      en: "Investigate an optional relationship with a Keet identity.",
      "pt-br": "Investigar uma relação opcional com uma identidade Keet.",
    },
    level: "research",
    note: {
      en: "Blocked on a signer API for existing accounts; number not yet assigned.",
      "pt-br": "Depende de uma API de assinatura para contas existentes; número ainda não atribuído.",
    },
  },
  "400-chat": {
    benefit: {
      en: "Exchange messages with explicit storage receipts and retries.",
      "pt-br": "Trocar mensagens com confirmação de armazenamento e novas tentativas explícitas.",
    },
    level: "available",
    feature: inApp("next", "Chat", "Conversar"),
  },
  "401-paired-chat": {
    benefit: {
      en: "Authenticated one-to-one chats with pinned keys, a durable outbox, names and pictures.",
      "pt-br": "Chats um a um autenticados, com chaves fixadas, caixa de saída durável, nomes e fotos.",
    },
    level: "available",
    note: {
      en: "The default for new chats on web, desktop and extension. No calls in them yet.",
      "pt-br": "O padrão para novos chats na web, no desktop e na extensão. Ainda sem chamadas neles.",
    },
    feature: inApp("next", "Chat", "Conversar"),
  },
  "402-legacy-chat": {
    benefit: {
      en: "The chat profile of every public release so far; older contacts keep working.",
      "pt-br": "O perfil de chat de todas as versões públicas até agora; contatos antigos continuam funcionando.",
    },
    level: "available",
  },
  "403-dht-text": {
    benefit: {
      en: "Very short text through DHT records when no live link is up. Bounded, not a mailbox.",
      "pt-br": "Textos bem curtos por registros na DHT quando não há link ao vivo. É limitado, não é caixa postal.",
    },
    level: "available",
    note: {
      en: "Legacy chats: up to 500 bytes. Paired chats: 256 bytes, retried for five minutes.",
      "pt-br": "Chats legados: até 500 bytes. Chats pareados: 256 bytes, com novas tentativas por cinco minutos.",
    },
  },
  "4xx-store-and-forward": {
    group: "talk",
    benefit: {
      en: "Text, a picture or a payment request sent while a contact is away waits, sealed, in your own S3 bucket and reaches them when they are back.",
      "pt-br": "Texto, uma imagem ou um pedido de pagamento enviados com o contato ausente esperam, selados, no seu próprio bucket S3 e chegam quando ele volta.",
    },
    level: "available",
    note: {
      en: "Experimental, paired chats with the switch on at both ends; web, desktop and extension. Picked up until seven days after you were last online. Ecash is never held. Number not yet assigned.",
      "pt-br": "Experimental, chats pareados com a opção ligada nas duas pontas; web, desktop e extensão. Pode ser buscado até sete dias depois da última vez que você esteve online. Ecash nunca fica guardado. Número ainda não atribuído.",
    },
  },
  "500-files": {
    benefit: {
      en: "Send a file straight to a contact, checked and acknowledged on arrival.",
      "pt-br": "Enviar um arquivo direto a um contato, verificado e confirmado na chegada.",
    },
    level: "available",
    note: {
      en: "Up to 100 MiB per file; both people online. A retry sends the whole file again.",
      "pt-br": "Até 100 MiB por arquivo; as duas pessoas online. Uma nova tentativa reenvia o arquivo inteiro.",
    },
    feature: inApp("next", "Send files", "Enviar arquivos"),
  },
  "501-paired-files": {
    benefit: {
      en: "Negotiated file transfer in paired chats, chunk by chunk with integrity checks.",
      "pt-br": "Transferência negociada nos chats pareados, pedaço por pedaço, com verificação de integridade.",
    },
    level: "available",
  },
  "502-legacy-files": {
    benefit: {
      en: "File frames of the released chats, so older contacts can still receive files.",
      "pt-br": "Os frames de arquivo dos chats já lançados, para contatos antigos ainda receberem arquivos.",
    },
    level: "available",
  },
  "600-media": {
    benefit: {
      en: "Voice, video and screen sharing, coordinated apart from the data stream.",
      "pt-br": "Voz, vídeo e compartilhamento de tela, coordenados à parte do fluxo de dados.",
    },
    level: "available",
    note: {
      en: "In chats over WebRTC (legacy profile). Paired chats do not have calls yet.",
      "pt-br": "Em chats sobre WebRTC (perfil legado). Os chats pareados ainda não têm chamadas.",
    },
    feature: inApp("next", "Calls", "Chamadas"),
  },
  "601-webrtc-media": {
    benefit: {
      en: "One-to-one calls over WebRTC media, with compact call signaling.",
      "pt-br": "Chamadas um a um por mídia WebRTC, com sinalização compacta.",
    },
    level: "available",
    note: {
      en: "Screen sharing needs a computer; phone browsers can't share a screen.",
      "pt-br": "Compartilhar a tela exige um computador; navegadores de celular não compartilham tela.",
    },
  },
  "700-local-services": {
    benefit: {
      en: "Let chosen contacts open an app or site running on your computer, while you are online.",
      "pt-br": "Deixar contatos escolhidos abrirem um app ou site que roda no seu computador, enquanto você está online.",
    },
    level: "available",
    note: {
      en: "Desktop app and extension, at both ends; not the web app. You choose which contacts see each app, in paired chats too.",
      "pt-br": "App desktop e extensão, nas duas pontas; não no app web. Você escolhe quais contatos veem cada app, também nos chats pareados.",
    },
    feature: inApp("next", "Share a local app", "Compartilhar um app local"),
  },
  "701-http-services": {
    benefit: {
      en: "HTTP requests and responses carried over the chat's data link.",
      "pt-br": "Pedidos e respostas HTTP levados pelo link de dados do chat.",
    },
    level: "available",
    note: {
      en: "Plain request/response. No WebSockets or streaming.",
      "pt-br": "Pedido e resposta simples. Sem WebSockets nem streaming.",
    },
  },
  "800-invite-join": {
    benefit: {
      en: "Turn a private invitation into a mutually admitted connection.",
      "pt-br": "Transformar um convite privado numa conexão admitida pelos dois lados.",
    },
    level: "available",
    feature: inApp("invite", "The invitation", "O convite"),
  },
  "801-invitation-profiles": {
    benefit: {
      en: "The invitation formats clients actually produce: links, QR codes and connection strings.",
      "pt-br": "Os formatos de convite que os clientes realmente geram: links, QR codes e strings de conexão.",
    },
    level: "available",
    note: {
      en: "Invite links, and paired invitations as a QR code you scan with a camera or from an image.",
      "pt-br": "Links de convite, e convites pareados como QR code lido pela câmera ou de uma imagem.",
    },
    feature: inApp("invite", "The invitation", "O convite"),
  },
  "900-group-sessions": {
    benefit: {
      en: "How a group agrees on who is in it, locks out whoever left, and moves messages between members, never through the DHT.",
      "pt-br": "Como um grupo combina quem faz parte dele, tranca para fora quem saiu e leva as mensagens entre os membros, nunca pela DHT.",
    },
    level: "available",
    note: {
      en: "Two profiles implemented: group-mesh/1 (private, up to eight members, one admin) and group-community/1 (a link anyone can open, up to 256). Text, a picture and payments between members; web, desktop and extension.",
      "pt-br": "Dois perfis implementados: group-mesh/1 (privado, até oito membros, um admin) e group-community/1 (um link que qualquer um abre, até 256). Texto, uma foto e pagamentos entre membros; web, desktop e extensão.",
    },
  },
  "9xx-group-mesh": {
    group: "together",
    benefit: {
      en: "Up to eight people, each pair on its own authenticated link, with a fresh group key whenever someone joins or leaves.",
      "pt-br": "Até oito pessoas, cada par num link autenticado próprio, com uma chave de grupo nova sempre que alguém entra ou sai.",
    },
    level: "available",
    note: {
      en: "Text, a picture set by the admin, and payments between two members over their own link; files and calls are refused in groups. A member who was away catches up from each author's recent messages. Number not yet assigned.",
      "pt-br": "Texto, uma foto definida pelo admin, e pagamentos entre dois membros pelo link deles; arquivos e chamadas são recusados em grupos. Quem estava fora recupera as mensagens recentes de cada autor. Número ainda não atribuído.",
    },
  },
  "9xx-group-community": {
    group: "together",
    benefit: {
      en: "A group whose link is the way in: anyone who opens it joins, any member lets them in while the admin is away, up to 256 members.",
      "pt-br": "Um grupo em que o link é a porta: quem abre entra, qualquer membro deixa entrar mesmo com o admin fora, até 256 membros.",
    },
    level: "available",
    note: {
      en: "Text, a picture and payments, sealed to the two members and carried by the hubs. Online members elect a few hubs that relay; whoever was away is caught up by whoever is there. The cap is what a headless load test measured. Number not yet assigned.",
      "pt-br": "Texto, uma foto e pagamentos, selados para os dois membros e levados pelos hubs. Os membros online elegem alguns hubs que repassam; quem estava fora recebe de quem estiver lá. O limite é o que um teste de carga sem interface mediu. Número ainda não atribuído.",
    },
  },
  "901-gossipsub": {
    benefit: {
      en: "Evaluate GossipSub as a distribution layer for groups larger than the mesh.",
      "pt-br": "Avaliar o GossipSub como camada de distribuição para grupos maiores que a malha.",
    },
    level: "planned",
    note: {
      en: "A later profile, after the mesh is measured; no adapter. Number not yet assigned.",
      "pt-br": "Um perfil posterior, depois de medir a malha; sem adapter. Número ainda não atribuído.",
    },
  },
  "1000-storage": {
    benefit: {
      en: "Where sealed bundles are kept, separate from what goes into a backup.",
      "pt-br": "Onde os pacotes selados ficam guardados, separados do que entra num backup.",
    },
    level: "available",
    note: {
      en: "Holds backups and, since store-and-forward, items sealed for an away contact.",
      "pt-br": "Guarda backups e, desde o store-and-forward, itens selados para um contato ausente.",
    },
    feature: inApp("space", "Your space", "Seu espaço"),
  },
  "1001-local-storage": {
    benefit: {
      en: "The simplest place: a file you keep. No account, no network.",
      "pt-br": "O lugar mais simples: um arquivo que você guarda. Sem conta, sem rede.",
    },
    level: "available",
    note: {
      en: "Backups only: a file has no address to hand a contact, so it cannot hold messages.",
      "pt-br": "Só backups: um arquivo não tem endereço para entregar a um contato, então não guarda mensagens.",
    },
  },
  "1002-s3-storage": {
    benefit: {
      en: "Any S3-compatible bucket (AWS, R2, B2, MinIO, Garage) holding only encrypted bundles.",
      "pt-br": "Qualquer bucket compatível com S3 (AWS, R2, B2, MinIO, Garage) guardando só pacotes criptografados.",
    },
    level: "available",
    note: {
      en: "Backups and held messages on every client. The bucket's CORS rules must allow the app (and GET from your contacts' apps, to hold).",
      "pt-br": "Backups e mensagens guardadas em todos os clientes. As regras de CORS do bucket precisam liberar o app (e GET dos apps dos contatos, para guardar mensagens).",
    },
  },
};
