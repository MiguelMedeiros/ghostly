import type { UsdtCreate } from "../engine/paymentAdapters/usdtWallet";
import type { GroupMention, LnurlSuccessAction, PaymentReview, PaymentTarget } from "@ghostly/core";
import type { LnurlView } from "../engine/paymentAdapters/providers/lightningService";
import type { ArkConfig } from "../engine/paymentAdapters/arkade";
import type { ArkCreate } from "../engine/paymentAdapters/arkWallet";
import type { BarkCreate } from "../engine/paymentAdapters/barkWallet";
import type { BarkConfig } from "../engine/paymentAdapters/bark";
import type { FedimintFederationView } from "../engine/paymentAdapters/fedimintWallet";
import type { FederationInfo } from "../engine/paymentAdapters/fedimintSdk";
import type { SparkCreate } from "../engine/paymentAdapters/sparkWallet";
import type { SparkNetwork, WalletNetwork } from "@ghostly/core";
import type { ProfileChoice } from '../profiles/public';
import type { ProofChallenge, ProofEvidence, ProofAdapter } from "@ghostly/core";
import type { LinkParams, LinkPreview, PairedTransport, DeliveryMode } from "@ghostly/core";
import type { CashuInspection, EngineState, MessageDetailsView, MessageFile, SettingsPatch, StoredMessage, WalletCreate, WalletInstanceView, WalletRemove } from "./types";
import type { NostrDraft, NostrDraftRequest, NostrLookupRequest, NostrLookupResult, NostrPublishResult } from "../nostr/types";

/** UI → engine calls. The extension carries them over a runtime port, the web app calls the peer in the same page. */
export interface EngineApi {
  usdtCreate(params:UsdtCreate):void;
  usdtUnlock(params:{password:string;network?:WalletNetwork}):void;
  usdtReveal(params:{password?:string;network?:WalletNetwork}):string;
  usdtLock(params?:{network?:WalletNetwork}):void;
  usdtRefresh(params?:{network?:WalletNetwork}):void;
  /** Sepolia only: test USDT from a public faucet; returns the transaction hash. */
  usdtGetTestTokens(params?:{network?:WalletNetwork}):string;
  usdtExportBackup(params:{password:string;network?:WalletNetwork}):string;
  usdtRestoreBackup(params:{text:string;password:string;network?:WalletNetwork}):void;
  arkCreate(params: ArkCreate): void;
  arkUnlock(params: {password:string;network?:WalletNetwork}): void;
  arkLock(params?: {network?:WalletNetwork}): void;
  arkBackup(params: {password?:string;network?:WalletNetwork}): {mnemonic:string;config:ArkConfig};
  arkExportBackup(params:{password:string;network?:WalletNetwork}):string;
  arkRestoreBackup(params:{text:string;password:string;network?:WalletNetwork}):void;
  arkRefresh(params?: {network?:WalletNetwork}): void;
  /** Expired Ark outputs back into the balance; returns the settlement txid. */
  arkRecover(params?: {network?:WalletNetwork}): string;
  barkCreate(params: BarkCreate): void;
  barkBackup(params?: {network?:WalletNetwork}): {mnemonic:string;config:BarkConfig};
  barkExportBackup(params:{password:string;network?:WalletNetwork}):string;
  barkRestoreBackup(params:{text:string;password:string;network?:WalletNetwork}):void;
  barkRefresh(params?: {network?:WalletNetwork}): void;
  /** On-chain coins of the Bark wallet into Ark; returns the board txid. */
  barkBoard(params?: {network?:WalletNetwork}): string;
  /** What an invite code leads to, before joining: the federation's name, guardians, version, network, modules. */
  fedimintPreview(params: { invite: string; network?:WalletNetwork }): FederationInfo;
  fedimintJoin(params: { invite: string; recover?: boolean; network?:WalletNetwork }): FedimintFederationView;
  fedimintLeave(params: { federation: string }): void;
  fedimintRefresh(params?: { network?:WalletNetwork }): void;
  /** Out-of-band notes of that federation, to hand over. They come back by themselves if nobody redeems them in a week. */
  fedimintSpendNotes(params: { federation: string; amount: number }): { notes: string; operation: string };
  fedimintReceiveNotes(params: { notes: string; network?:WalletNetwork }): { federation: string; amount: number };
  fedimintInvoice(params: { federation: string; amount: number; memo?: string }): { invoice: string };
  fedimintTakeBack(params: { federation: string; operation: string }): "canceled" | "taken" | "pending";
  fedimintBackup(params?: { network?:WalletNetwork }): { mnemonic: string; federations: { id: string; name?: string; invite: string }[] };
  fedimintExportBackup(params: { password: string; network?:WalletNetwork }): string;
  fedimintRestoreBackup(params: { text: string; password: string; network?:WalletNetwork }): { joined: number; failed: string[] };
  fedimintRestorePhrase(params: { mnemonic: string; invites: string[]; network?:WalletNetwork }): { joined: number; failed: string[] };
  /** A Spark wallet on the chain named (Mainnet with a Breez API key), or a wallet restored from a phrase. */
  sparkCreate(params: SparkCreate): void;
  sparkBackup(params?: { network?:WalletNetwork }): { mnemonic: string; network: SparkNetwork };
  sparkExportBackup(params: { password: string; network?:WalletNetwork }): string;
  /** `apiKey`: Mainnet's Breez key, not in the file. */
  sparkRestoreBackup(params: { text: string; password: string; apiKey?: string; network?:WalletNetwork }): void;
  sparkRefresh(params?: { network?:WalletNetwork }): void;
  /** A network's Spark wallet becomes its Breez Lightning source too: one seed, one wallet, one balance. */
  sparkUseForLightning(params?: { network?:WalletNetwork }): void;
  /** `network`: the card chosen; a target of the other network is refused before anything is prepared. */
  preparePayment(params: {target:PaymentTarget;amount:number;feeCap:number;payee:string;linkId?:string;requestId?:string;memo?:string;network?:WalletNetwork}): PaymentReview;
  approvePayment(params: {id:string}): PaymentReview;
  reconcilePayment(params: {id:string}): PaymentReview;
  cancelPayment(params: {id:string}): PaymentReview;

  refreshPublicProfiles(params: { linkId: string; force?: boolean }): void;
  choosePublicProfile(params: { linkId: string; choice: ProfileChoice }): void;
  preparePeerProof(params: { linkId: string; externalKey: string; adapter?: ProofAdapter }): ProofChallenge;
  submitPeerProof(params: { linkId: string; challenge: ProofChallenge; event: ProofEvidence }): void;
  withdrawPeerProof(params: { linkId: string; adapter?: ProofAdapter }): void;
  /** Identities: a fresh proof key and the statement to sign. */
  beginIdentityProof(params: { provider: string; subject: string; validityDays?: number }): { draftId: string; binding: import("@ghostly/core").IdentityBinding };
  /** Verifies the evidence (as a contact would) and saves the proof. */
  completeIdentityProof(params: { draftId: string; evidence: unknown }): import("./types").IdentityProofView;
  cancelIdentityProof(params: { draftId: string }): void;
  /** Removes it from the profile and withdraws it from every chat. */
  removeIdentityProof(params: { id: string }): void;
  /** Shares it with this contact (now, or when it next connects). */
  shareIdentityProof(params: { linkId: string; id: string }): void;
  withdrawIdentityProof(params: { linkId: string; id: string }): void;
  /** Runs the provider's check again on what the contact shared. */
  recheckIdentityProof(params: { linkId: string; id: string }): void;
  /** Only on request: the public name/picture of what the contact shared. */
  lookupIdentityDisplay(params: { linkId: string; id: string }): void;
  /**
   * The public profile of one verified identity (the person's own or a contact's), asked for when its card is on
   * screen. Does nothing unless the proof is current and verified, Settings → Load public profiles is on and the
   * network is on; a copy younger than a day is not asked again (`force`: after five minutes).
   */
  loadPublicProfile(params: { provider: string; subject: string; force?: boolean }): void;
  /** Lists one of the profile's identities in its public DID document (`alsoKnownAs`), or takes it out. */
  setDidListed(params: { id: string; listed: boolean }): void;
  /** Nostr social layer, per contact: their profile (kind 0), follows (kind 3) or notes (kind 1), from the person's relays. Refused without a verified Nostr proof from that contact. */
  nostrLoadContact(params: { linkId: string; subject: string; what: "profile" | "follows" | "notes"; more?: boolean }): void;
  /** Forgets what was loaded about a contact's key. */
  nostrForgetContact(params: { linkId: string; subject: string }): void;
  /** The person's own profile, follows and mute list for one of their proven keys. */
  nostrLoadOwn(params: { subject: string }): void;
  /** A key's profile or a note that a message names, on the person's tap, from the person's relays. Not stored. */
  nostrLookup(params: NostrLookupRequest): NostrLookupResult;
  /** Publication, step 1: the unsigned event and the notice to confirm. Refused unless publication is on. */
  nostrDraft(params: NostrDraftRequest): NostrDraft;
  /** Publication, step 2: the draft, signed by the person's own signer, sent to their relays. */
  nostrPublish(params: { draftId: string; event: unknown }): NostrPublishResult;
  createLink(): { linkId: string; inviteCode: string };
  /**
   * The keys for a new chat, warmed on the network ahead of time when the engine could (see `GhostlyNode.
   * takeInvite`): the UI keeps `mine` as its side and hands `inviteCode` over, then `ensureLink`s it.
   */
  takeInvite(): { mine: LinkParams; inviteCode: string };
  joinLink(params: { inviteCode: string }): { linkId: string };
  /** Makes sure a link with these parameters runs; used by UIs that keep their own session list. */
  /** `inviteCode`: the invite this side made and holds (the inviter); absent on the side that joined. */
  ensureLink(params: LinkParams & { inviteCode?: string }): { linkId: string };
  confirmPair(params: { linkId: string; code: string }): void;
  pollNow(params: { linkId: string }): void;
  removeLink(params: { linkId: string }): void;
  renameLink(params: { linkId: string; label: string }): void;
  setActiveLink(params: { linkId: string | null }): void;
  /** `refused`: the text was not kept (it cannot be sent this way); any other error leaves it to be sent later. */
  /** `preview`: a link preview made by this app (WISP 401 § Link previews); checked against the text, dropped if off. */
  sendMessage(params: { linkId: string; text: string; timestamp?: number; preview?: LinkPreview }): { error: string | null; refused?: boolean };
  retryMessage(params: { linkId: string; messageId: string }): void;
  /** One message's details view (WISP 400 § Message details): how it travelled, as stored, plus what the engine knows around it now. */
  messageDetails(params: { linkId: string; messageId: string }): MessageDetailsView | null;
  /** Forgets one message and the bytes of the file it carried. Nothing is sent: the peer keeps its copy. */
  deleteMessage(params: { linkId: string; messageId: string }): void;
  /** Link secrets, for a UI that keeps its own session list in the same profile. */
  exportLinks(): { deliveryMode?: DeliveryMode; profile?: "paired-chat/1"; seedB64: string; peerPubKeyZ32: string; encKeyB64: string; createdAt: number; inviteCode?: string; label?: string }[];
  /** Sends a file whose bytes the caller already put in the `files` store. Progress shows up in `transfers`. */
  sendFile(params: { linkId: string; file: MessageFile; timestamp: number }): void;
  /** files/3: answers an offer (`accept`, `decline`), or pauses, resumes or cancels a transfer, either way. */
  fileAction(params: { linkId: string; fileId: string; action: "accept" | "decline" | "pause" | "resume" | "cancel" }): void;
  setDeliveryMode(params: { linkId: string; mode: DeliveryMode }): void;
  setTransportPreference(params: { linkId: string; preferred: PairedTransport; fallback: boolean }): void;
  /** One chat's connection from its menu: a transport both sides can use, `auto` for the app's rule, or `dht` for DHT only. */
  setChatTransport(params: { linkId: string; transport: PairedTransport | "auto" | "dht" }): void;
  setChatPaymentMethods(params: { linkId: string; methods: Partial<Record<import("@ghostly/core").PaymentMethodName, boolean>>; networks?: Partial<Record<import("@ghostly/core").PaymentMethodName, WalletNetwork[]>> }): void;
  /** Store-and-forward in one chat (WISP 4xx): accept held items from this contact, and hold items for it while it is away. */
  setChatHold(params: { linkId: string; enabled: boolean }): void;
  connect(params: { linkId: string }): void;
  walletAddMint(params: { url: string; primary?: boolean }): { url: string; name: string };
  /** New → a type → a network: made in one click and checked before its card appears; nothing saved on failure. */
  walletCreate(params: WalletCreate): WalletInstanceView;
  /** Removes one wallet, its keys and config; refused while it holds money on this device and `acceptLoss` is not set. */
  walletRemove(params: WalletRemove): void;
  /** The app is in front again: chats look now, and dropped ones reconnect at once. */
  wake(): void;
  /** The primary mint is where Lightning invoices are created. */
  walletSetPrimaryMint(params: { url: string }): void;
  walletRemoveMint(params: { url: string }): void;
  /** A Lightning invoice from the active source (`via: "cashu"`: from the mints, landing as ecash). */
  walletReceiveLightning(params: { amount: number; via?: "cashu"; network?:WalletNetwork }): { quote: string; invoice: string; expiresAt: number | null; paymentHash?: string; source: string };
  walletQuoteInvoice(params: { invoice: string; via?: "cashu"; network?:WalletNetwork }): { quote: string; mint: string; amount: number; feeReserve: number; source?: string };
  /** `note`: what the payment was for, kept with the wallet's own record of it (a Lightning address, for one). */
  walletPayQuote(params: { quote: string; mint: string; note?: string }): { paid: boolean };
  /** Reads a Lightning address or LNURL and fetches what it asks for. Its domain learns of the request. */
  lnurlResolve(params: { text: string; network?:WalletNetwork }): LnurlView;
  /** The invoice for `amount` sats from a resolved address, checked before it is quoted. */
  lnurlInvoice(params: { id: string; amount: number; comment?: string; network?:WalletNetwork }): { invoice: string; successAction?: LnurlSuccessAction; note: string };
  /** "I paid it from another wallet": the contact's app looks now. Only its wallet marks the request paid. */
  checkPayment(params: { linkId: string; paymentId: string }): void;
  /** Makes a provider a network's Lightning source. `values`: its form; secret fields are sealed, never returned. */
  lightningSetSource(params: { providerId: string; values: Record<string, string>; network?:WalletNetwork }): void;
  lightningClearSource(params?: { network?:WalletNetwork }): void;
  /** Tries a network's Lightning source again now, instead of after the wait between attempts. */
  lightningRetrySource(params?: { network?:WalletNetwork }): void;
  /** Changes the server of the saved Lightning source (its `changeable` fields), keeping its secrets. */
  lightningReconfigureSource(params: { values: Record<string, string>; network?:WalletNetwork }): void;
  lightningRefresh(params?: { network?:WalletNetwork }): void;
  bitcoinSetSource(params: { providerId: string; values: Record<string, string>; network?:WalletNetwork }): void;
  bitcoinClearSource(params?: { network?:WalletNetwork }): void;
  bitcoinRetrySource(params?: { network?:WalletNetwork }): void;
  /** Changes the server of the saved Bitcoin source (a BDK wallet's Esplora), keeping the wallet. */
  bitcoinReconfigureSource(params: { values: Record<string, string>; network?:WalletNetwork }): void;
  bitcoinReceiveAddress(params?: { network?:WalletNetwork }): string;
  bitcoinRefresh(params?: { network?:WalletNetwork }): void;
  /** Redeems a token pasted by the user. Only mints the user added are accepted. */
  walletReceiveToken(params: { token: string }): { amount: number };
  walletInspectCashu(params: { text: string }): { inspection: CashuInspection | null };
  /** Everything held, as tokens: the only backup there is for now. */
  walletExport(params?: { network?: WalletNetwork }): { mint: string; token: string; amount: number }[];
  sendPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number; network?:WalletNetwork }): { paymentId: string };
  requestPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number; method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark"; rail?: "cashu" | "lightning"; network?:WalletNetwork }): { paymentId: string };
  /** A request any member of a group may pay, once (WISP 9xx § Payments). */
  requestGroupPayment(params: { groupId: string; amount: number; memo?: string; timestamp: number; rail: "cashu" | "lightning"; network?:WalletNetwork }): { paymentId: string };
  /** The payment composer opened on a member of a community group: their app is asked what ways of paying it takes. */
  groupPaymentHello(params: { groupId: string; member: string }): void;
  /** Asks the contact for a way to pay it (Ark, USDT); its answer is a request carrying `askId`. */
  askToPay(params: { linkId: string; amount: number; method: "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark"; memo?: string; timestamp: number; network?:WalletNetwork }): { askId: string };
  /** `via: "lightning"`: the Lightning payment the person reviewed, never ecash instead, within `maxFee`. */
  payRequest(params: { linkId: string; paymentId: string; via?: "lightning"; maxFee?: number; network?:WalletNetwork }): void;
  reclaimPayment(params: { paymentId: string }): void;
  disconnect(params: { linkId: string }): void;
  addService(params: { name: string; target: string }): { serviceId: string };
  removeService(params: { serviceId: string }): void;
  setServiceEnabled(params: { serviceId: string; enabled: boolean }): void;
  setServiceShared(params: { serviceId: string; peerPubKeyZ32: string; shared: boolean }): void;
  updateSettings(params: { settings: SettingsPatch }): void;
  setCallSignal(params: { linkId: string; signal: string | null }): void;
  setFastPoll(params: { linkId: string; fast: boolean }): void;

  // Private groups (WISP 900, `group-mesh/1`). Group messages arrive as `messages` events under `group:<id>`.
  /** `profile`: a community (the default: the link is the way in, hundreds of members) or a private mesh of up to eight contacts. */
  createGroup(params: { name: string; profile?: "community" | "mesh" }): { groupId: string };
  /** Invites a contact (a paired chat whose app announced groups) to a group I administer. */
  inviteToGroup(params: { groupId: string; linkId: string }): void;
  acceptGroupInvitation(params: { groupId: string }): void;
  declineGroupInvitation(params: { groupId: string }): void;
  /** Turns the group's link on (or replaces it with a new one: the old one stops working). Admin only. */
  enableGroupLink(params: { groupId: string; reset?: boolean }): { link: string };
  disableGroupLink(params: { groupId: string }): void;
  /** Joins through a group's link (`group1/…`, or an address carrying it); resolves at once, admission follows. */
  joinGroupByLink(params: { link: string }): { groupId: string };
  /** `mentions`: places of the text that name members (WISP 9xx § Mentions); the session keeps only what holds. */
  sendGroupMessage(params: { groupId: string; text: string; mentions?: GroupMention[] }): { error: string | null };
  groupMessages(params: { groupId: string }): StoredMessage[];
  leaveGroup(params: { groupId: string }): void;
  removeGroupMember(params: { groupId: string; key: string }): void;
  makeGroupAdmin(params: { groupId: string; key: string }): void;
  /** A fresh epoch secret without a membership change. */
  rotateGroup(params: { groupId: string }): void;
  /** The admin sets the group's picture (a data URL as `avatarFromFile` makes it), or removes it with null. */
  setGroupPicture(params: { groupId: string; picture: string | null }): void;
  /** Forgets the group and its history on this device (leaving first when still in it). */
  forgetGroup(params: { groupId: string }): void;
}

/** What the engine implements: any call may be answered asynchronously. */
export type EngineImplementation = {
  [M in keyof EngineApi]: EngineApi[M] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : never;
};

export type EngineMethod = keyof EngineApi;
type Params<M extends EngineMethod> = Parameters<EngineApi[M]> extends [infer P] ? P : undefined;

export interface RpcRequest<M extends EngineMethod = EngineMethod> {
  kind: "request";
  id: number;
  method: M;
  params: Params<M>;
}

export interface RpcResponse {
  kind: "response";
  id: number;
  result?: unknown;
  error?: string;
}

/** Ephemeral UI feedback, never part of history or the initial snapshot. No private content. */
export interface AttentionEvent {
  id: string;
  type: "message" | "sent" | "coin" | "confirmed";
  at: number;
  /** The chat a message event belongs to (its link id, `group:<id>` for a group), so a page can mute one chat. */
  linkId?: string;
  /** A group message that names me (or everyone): it may still notify in a muted group. */
  mention?: true;
}
export type EngineEvent =
  | { kind: "attention"; event: AttentionEvent }
  | { kind: "state"; state: EngineState }
  | { kind: "messages"; linkId: string; messages: StoredMessage[] }
  | { kind: "call-signal"; linkId: string; signal: string };
