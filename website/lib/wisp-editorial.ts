import type { Level } from "./status";
import type { Localized } from "./i18n";

/**
 * Editorial layer over the WISP drafts: the family a draft is presented in, a
 * one-line benefit, and its availability as checked in the code (v0.4.0 on
 * `main` = released; merged on `dev` = development). Numbers, titles, status
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
      en: "Messages with explicit receipts and retries, over a live link or the bounded DHT path.",
      "pt-br": "Mensagens com confirmações e novas tentativas explícitas, por um link ao vivo ou pelo caminho limitado da DHT.",
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
    icon: "group",
    title: { en: "Groups", "pt-br": "Grupos" },
    blurb: {
      en: "Proposals for sessions with more than two people.",
      "pt-br": "Propostas para sessões com mais de duas pessoas.",
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
    level: "released",
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
    level: "released",
    note: {
      en: "Per-connection keys are released; key pinning in paired chats is in development.",
      "pt-br": "Chaves por conexão já saíram; a fixação de chave nos chats pareados está em desenvolvimento.",
    },
  },
  "03-capabilities": {
    benefit: {
      en: "Both sides announce versioned abilities and only use what they have in common.",
      "pt-br": "Os dois lados anunciam capacidades versionadas e usam só o que têm em comum.",
    },
    level: "development",
    note: {
      en: "Negotiated offers are part of paired chats, merged for the next release.",
      "pt-br": "As ofertas negociadas fazem parte dos chats pareados, já integrados para a próxima versão.",
    },
    feature: inApp("agree", "The agreement", "O acordo"),
  },
  "04-profiles": {
    benefit: {
      en: "Keep separate lives on one device — chats, wallets, services and settings — never announced to contacts.",
      "pt-br": "Manter vidas separadas num aparelho — chats, carteiras, serviços e ajustes — sem anunciar isso aos contatos.",
    },
    level: "development",
    note: {
      en: "Web and desktop. The browser extension runs a single profile.",
      "pt-br": "Web e desktop. A extensão do navegador roda um único perfil.",
    },
    feature: inApp("space", "Your space", "Seu espaço"),
  },
  "05-backups": {
    benefit: {
      en: "Bring a whole profile back from one passphrase-sealed bundle.",
      "pt-br": "Trazer um perfil inteiro de volta a partir de um pacote selado por senha.",
    },
    level: "development",
    note: {
      en: "Web and desktop. A restore always creates a new profile; nothing is overwritten.",
      "pt-br": "Web e desktop. Uma restauração sempre cria um perfil novo; nada é sobrescrito.",
    },
    feature: inApp("space", "Your space", "Seu espaço"),
  },
  "100-transports": {
    benefit: {
      en: "Pick a data path both peers support, in order of preference; fall back only when both allow it.",
      "pt-br": "Escolher um caminho de dados que os dois suportam, por ordem de preferência; trocar só quando os dois permitem.",
    },
    level: "development",
    feature: inApp("alive", "The connection comes alive", "A conexão ganha vida"),
  },
  "101-webrtc": {
    benefit: {
      en: "Carry a session over a WebRTC data channel — the path every Ghostly app has today.",
      "pt-br": "Levar a sessão por um canal de dados WebRTC — o caminho que todo app Ghostly tem hoje.",
    },
    level: "released",
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
    level: "development",
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
    level: "development",
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
    level: "released",
    note: {
      en: "Payment requests exist in the release; negotiated methods in paired chats are in development.",
      "pt-br": "Pedidos de pagamento existem na versão pública; métodos negociados em chats pareados estão em desenvolvimento.",
    },
    feature: inApp("next", "Send sats", "Enviar sats"),
  },
  "201-cashu": {
    benefit: {
      en: "Send and receive ecash tokens in the conversation; a mint you choose holds the funds.",
      "pt-br": "Enviar e receber tokens de ecash na conversa; um mint que você escolhe guarda os fundos.",
    },
    level: "released",
    feature: inApp("wallets", "Wallets", "Carteiras"),
  },
  "202-arkade": {
    benefit: {
      en: "Review and approve an exact Ark payment through a pinned operator.",
      "pt-br": "Revisar e aprovar um pagamento Ark exato por um operador fixado.",
    },
    level: "development",
    note: {
      en: "Experimental. New profiles get a Bitcoin mainnet wallet automatically; payment flows were exercised only on a local regtest network. Unilateral exit is still a release gate.",
      "pt-br": "Experimental. Perfis novos ganham automaticamente uma carteira na mainnet do Bitcoin; os pagamentos foram exercitados só numa rede regtest local. A saída unilateral ainda é requisito de lançamento.",
    },
    feature: inApp("wallets", "Wallets", "Carteiras"),
  },
  "203-lightning": {
    benefit: {
      en: "Carry a Lightning invoice in the chat and pay or receive it through the wallet.",
      "pt-br": "Levar uma fatura Lightning no chat e pagá-la ou recebê-la pela carteira.",
    },
    level: "released",
    note: {
      en: "Through the Cashu mints in the current release. In the next one the Lightning source can also be your own node or wallet: NWC, LND, Core Lightning, a browser wallet (WebLN, web app only) or Breez on a local regtest.",
      "pt-br": "Pelos mints Cashu na versão atual. Na próxima, a fonte Lightning também pode ser seu próprio nó ou carteira: NWC, LND, Core Lightning, uma carteira do navegador (WebLN, só no app web) ou Breez num regtest local.",
    },
    feature: inApp("wallets", "Wallets", "Carteiras"),
  },
  "204-bark": {
    benefit: {
      en: "A second Ark provider — Second's Bark — beside Arkade, so Ark isn't tied to one implementation.",
      "pt-br": "Um segundo provedor de Ark — o Bark, da Second — ao lado do Arkade, para o Ark não depender de uma implementação.",
    },
    level: "development",
    note: {
      en: "Experimental, test networks only (Second's signet server or a local regtest); Mainnet makes no Bark wallet yet. Not interchangeable with Arkade: its own payment method and capability.",
      "pt-br": "Experimental, só em redes de teste (o servidor signet da Second ou um regtest local); a Mainnet ainda não cria carteira Bark. Não é intercambiável com o Arkade: método e capacidade próprios.",
    },
    feature: inApp("wallets", "Wallets", "Carteiras"),
  },
  "300-peer-proofs": {
    benefit: {
      en: "Optionally prove to one contact that you control an outside identity — never required.",
      "pt-br": "Provar, se quiser, a um contato que você controla uma identidade externa — nunca obrigatório.",
    },
    level: "development",
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
    level: "development",
    note: {
      en: "Signed once with a NIP-07 browser extension (web app, desktop) or a NIP-46 remote signer. A proof, not a transport, and not permission to publish.",
      "pt-br": "Assinada uma vez com uma extensão NIP-07 (app web, desktop) ou um signer remoto NIP-46. Uma prova, não um transporte, nem permissão para publicar.",
    },
  },
  "3xx-domain": {
    group: "identity",
    benefit: {
      en: "Show a contact that you control a domain, with a DNS record or a file on your site.",
      "pt-br": "Mostrar a um contato que você controla um domínio, com um registro DNS ou um arquivo no seu site.",
    },
    level: "development",
    note: {
      en: "Experimental. Looked up through a DNS-over-HTTPS resolver the contact chooses and re-checked after a day, so removing the record withdraws the proof. Number not yet assigned.",
      "pt-br": "Experimental. Consultada por um resolvedor DNS-over-HTTPS que o contato escolhe e reverificada depois de um dia, então remover o registro retira a prova. Número ainda não atribuído.",
    },
  },
  "3xx-openpgp": {
    group: "identity",
    benefit: {
      en: "Sign the statement once with your own gpg — a YubiKey works unchanged — and the contact verifies it locally.",
      "pt-br": "Assinar a declaração uma vez com o seu próprio gpg — uma YubiKey funciona igual — e o contato verifica localmente.",
    },
    level: "development",
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
    level: "development",
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
    level: "development",
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
    level: "development",
    note: {
      en: "Attested by the provider, not a key you hold; the contact trusts that company. Merged, but not offered until the maintainer registers Ghostly's OAuth clients. Number not yet assigned.",
      "pt-br": "Atestada pelo provedor, não por uma chave sua; o contato confia nessa empresa. Integrada, mas só oferecida quando o mantenedor registrar os clientes OAuth do Ghostly. Número ainda não atribuído.",
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
    level: "released",
    feature: inApp("next", "Chat", "Conversar"),
  },
  "401-paired-chat": {
    benefit: {
      en: "Authenticated one-to-one chats with pinned keys, a durable outbox, names and pictures.",
      "pt-br": "Chats um a um autenticados, com chaves fixadas, caixa de saída durável, nomes e fotos.",
    },
    level: "development",
    note: {
      en: "The default for new chats on web, desktop and extension in the next release.",
      "pt-br": "O padrão para novos chats na web, no desktop e na extensão na próxima versão.",
    },
    feature: inApp("next", "Chat", "Conversar"),
  },
  "402-legacy-chat": {
    benefit: {
      en: "The chat profile of every public release so far; older contacts keep working.",
      "pt-br": "O perfil de chat de todas as versões públicas até agora; contatos antigos continuam funcionando.",
    },
    level: "released",
  },
  "403-dht-text": {
    benefit: {
      en: "Very short text through DHT records when no live link is up — bounded, not a mailbox.",
      "pt-br": "Textos bem curtos por registros na DHT quando não há link ao vivo — limitado, não é caixa postal.",
    },
    level: "released",
    note: {
      en: "Legacy chats: up to 500 bytes. Paired chats (in development): 256 bytes, retried for five minutes.",
      "pt-br": "Chats legados: até 500 bytes. Chats pareados (em desenvolvimento): 256 bytes, com novas tentativas por cinco minutos.",
    },
  },
  "500-files": {
    benefit: {
      en: "Send a file straight to a contact, checked and acknowledged on arrival.",
      "pt-br": "Enviar um arquivo direto a um contato, verificado e confirmado na chegada.",
    },
    level: "released",
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
    level: "development",
  },
  "502-legacy-files": {
    benefit: {
      en: "File frames of the released chats, so older contacts can still receive files.",
      "pt-br": "Os frames de arquivo dos chats já lançados, para contatos antigos ainda receberem arquivos.",
    },
    level: "released",
  },
  "600-media": {
    benefit: {
      en: "Voice, video and screen sharing, coordinated apart from the data stream.",
      "pt-br": "Voz, vídeo e compartilhamento de tela, coordenados à parte do fluxo de dados.",
    },
    level: "released",
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
    level: "released",
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
    level: "released",
    note: {
      en: "Desktop app and extension, at both ends; not the web app. Access per contact is in development.",
      "pt-br": "App desktop e extensão, nas duas pontas; não no app web. O acesso por contato está em desenvolvimento.",
    },
    feature: inApp("next", "Share a local app", "Compartilhar um app local"),
  },
  "701-http-services": {
    benefit: {
      en: "HTTP requests and responses carried over the chat's data link.",
      "pt-br": "Pedidos e respostas HTTP levados pelo link de dados do chat.",
    },
    level: "released",
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
    level: "released",
    feature: inApp("invite", "The invitation", "O convite"),
  },
  "801-invitation-profiles": {
    benefit: {
      en: "The invitation formats clients actually produce: links, QR codes and connection strings.",
      "pt-br": "Os formatos de convite que os clientes realmente geram: links, QR codes e strings de conexão.",
    },
    level: "released",
    note: {
      en: "Released: invite links. In development: paired invitations with a QR code you can scan.",
      "pt-br": "Lançado: links de convite. Em desenvolvimento: convites pareados com QR code que dá para escanear.",
    },
    feature: inApp("invite", "The invitation", "O convite"),
  },
  "900-group-sessions": {
    benefit: {
      en: "A candidate architecture for groups that keeps fanout and membership off the DHT.",
      "pt-br": "Uma arquitetura candidata para grupos que mantém a distribuição e os membros fora da DHT.",
    },
    level: "planned",
    note: { en: "Proposal; no implementation.", "pt-br": "Proposta; sem implementação." },
  },
  "901-gossipsub": {
    benefit: {
      en: "Evaluate GossipSub as a distribution layer for groups.",
      "pt-br": "Avaliar o GossipSub como camada de distribuição para grupos.",
    },
    level: "planned",
    note: {
      en: "Proposal; no adapter. Number not yet assigned.",
      "pt-br": "Proposta; sem adapter. Número ainda não atribuído.",
    },
  },
  "1000-storage": {
    benefit: {
      en: "Where sealed bundles are kept — separate from what goes into a backup.",
      "pt-br": "Onde os pacotes selados ficam guardados — separado do que entra num backup.",
    },
    level: "development",
    feature: inApp("space", "Your space", "Seu espaço"),
  },
  "1001-local-storage": {
    benefit: {
      en: "The simplest place: a file you keep. No account, no network.",
      "pt-br": "O lugar mais simples: um arquivo que você guarda. Sem conta, sem rede.",
    },
    level: "development",
  },
  "1002-s3-storage": {
    benefit: {
      en: "Any S3-compatible bucket — AWS, R2, B2, MinIO, Garage — holding only encrypted bundles.",
      "pt-br": "Qualquer bucket compatível com S3 — AWS, R2, B2, MinIO, Garage — guardando só pacotes criptografados.",
    },
    level: "development",
    note: {
      en: "Web and desktop. The bucket must allow the app in its CORS rules.",
      "pt-br": "Web e desktop. O bucket precisa liberar o app nas regras de CORS.",
    },
  },
};
