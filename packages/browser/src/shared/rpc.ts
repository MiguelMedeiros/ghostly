import type { UsdtCreate } from "../engine/paymentAdapters/usdtWallet";
import type { LnurlSuccessAction, PaymentReview, PaymentTarget } from "@ghostly/core";
import type { LnurlView } from "../engine/paymentAdapters/providers/lightningService";
import type { ArkConfig } from "../engine/paymentAdapters/arkade";
import type { ArkCreate } from "../engine/paymentAdapters/arkWallet";
import type { BarkCreate } from "../engine/paymentAdapters/barkWallet";
import type { BarkConfig } from "../engine/paymentAdapters/bark";
import type { ProfileChoice } from '../profiles/public';
import type { ProofChallenge, ProofEvidence, ProofAdapter } from "@ghostly/core";
import type { LinkParams, PairedTransport, DeliveryMode } from "@ghostly/core";
import type { CashuInspection, EngineState, MessageFile, Settings, StoredMessage } from "./types";
import type { NostrDraft, NostrDraftRequest, NostrPublishResult } from "../nostr/types";

/** UI → engine calls. The extension carries them over a runtime port, the web app calls the peer in the same page. */
export interface EngineApi {
  usdtCreate(params:UsdtCreate):void;
  usdtUnlock(params:{password:string}):void;
  usdtReveal(params:{password?:string}):string;
  usdtLock():void;
  usdtRefresh():void;
  /** Sepolia only: test USDT from a public faucet; returns the transaction hash. */
  usdtGetTestTokens():string;
  usdtExportBackup(params:{password:string}):string;
  usdtRestoreBackup(params:{text:string;password:string}):void;
  arkCreate(params: ArkCreate): void;
  arkUnlock(params: {password:string}): void;
  arkLock(): void;
  arkBackup(params: {password?:string}): {mnemonic:string;config:ArkConfig};
  arkExportBackup(params:{password:string}):string;
  arkRestoreBackup(params:{text:string;password:string}):void;
  arkRefresh(): void;
  /** Expired Ark outputs back into the balance; returns the settlement txid. */
  arkRecover(): string;
  barkCreate(params: BarkCreate): void;
  barkBackup(): {mnemonic:string;config:BarkConfig};
  barkExportBackup(params:{password:string}):string;
  barkRestoreBackup(params:{text:string;password:string}):void;
  barkRefresh(): void;
  /** On-chain coins of the Bark wallet into Ark; returns the board txid. */
  barkBoard(): string;
  preparePayment(params: {target:PaymentTarget;amount:number;feeCap:number;payee:string;linkId?:string;requestId?:string;memo?:string}): PaymentReview;
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
  /** Nostr social layer, per contact: their profile (kind 0), follows (kind 3) or notes (kind 1), from the person's relays. Refused without a verified Nostr proof from that contact. */
  nostrLoadContact(params: { linkId: string; subject: string; what: "profile" | "follows" | "notes"; more?: boolean }): void;
  /** Forgets what was loaded about a contact's key. */
  nostrForgetContact(params: { linkId: string; subject: string }): void;
  /** The person's own profile, follows and mute list for one of their proven keys. */
  nostrLoadOwn(params: { subject: string }): void;
  /** Publication, step 1: the unsigned event and the notice to confirm. Refused unless publication is on. */
  nostrDraft(params: NostrDraftRequest): NostrDraft;
  /** Publication, step 2: the draft, signed by the person's own signer, sent to their relays. */
  nostrPublish(params: { draftId: string; event: unknown }): NostrPublishResult;
  createLink(): { linkId: string; inviteCode: string };
  joinLink(params: { inviteCode: string }): { linkId: string };
  /** Makes sure a link with these parameters runs; used by UIs that keep their own session list. */
  ensureLink(params: LinkParams): { linkId: string };
  confirmPair(params: { linkId: string; code: string }): void;
  pollNow(params: { linkId: string }): void;
  removeLink(params: { linkId: string }): void;
  renameLink(params: { linkId: string; label: string }): void;
  setActiveLink(params: { linkId: string | null }): void;
  /** `refused`: the text was not kept (it cannot be sent this way); any other error leaves it to be sent later. */
  sendMessage(params: { linkId: string; text: string; timestamp?: number }): { error: string | null; refused?: boolean };
  retryMessage(params: { linkId: string; messageId: string }): void;
  /** Forgets one message and the bytes of the file it carried. Nothing is sent: the peer keeps its copy. */
  deleteMessage(params: { linkId: string; messageId: string }): void;
  /** Link secrets, for a UI that keeps its own session list in the same profile. */
  exportLinks(): { deliveryMode?: DeliveryMode; profile?: "paired-chat/1"; seedB64: string; peerPubKeyZ32: string; encKeyB64: string; createdAt: number; inviteCode?: string; label?: string }[];
  /** Sends a file whose bytes the caller already put in the `files` store. Progress shows up in `transfers`. */
  sendFile(params: { linkId: string; file: MessageFile; timestamp: number }): void;
  setDeliveryMode(params: { linkId: string; mode: DeliveryMode }): void;
  setTransportPreference(params: { linkId: string; preferred: PairedTransport; fallback: boolean }): void;
  setChatPaymentMethods(params: { linkId: string; methods: Partial<Record<import("@ghostly/core").PaymentMethodName, boolean>> }): void;
  /** Store-and-forward in one chat (WISP 4xx): accept held items from this contact, and hold items for it while it is away. */
  setChatHold(params: { linkId: string; enabled: boolean }): void;
  connect(params: { linkId: string }): void;
  walletAddMint(params: { url: string; primary?: boolean }): { url: string; name: string };
  /** Real money or test networks, for every wallet at once. */
  walletSetMode(params: { mode: "mainnet" | "testnet" }): void;
  /** The app is in front again: chats look now, and dropped ones reconnect at once. */
  wake(): void;
  /** The primary mint is where Lightning invoices are created. */
  walletSetPrimaryMint(params: { url: string }): void;
  walletRemoveMint(params: { url: string }): void;
  /** A Lightning invoice from the active source (`via: "cashu"`: from the mints, landing as ecash). */
  walletReceiveLightning(params: { amount: number; via?: "cashu" }): { quote: string; invoice: string; expiresAt: number | null; paymentHash?: string; source: string };
  walletQuoteInvoice(params: { invoice: string; via?: "cashu" }): { quote: string; mint: string; amount: number; feeReserve: number; source?: string };
  /** `note`: what the payment was for, kept with the wallet's own record of it (a Lightning address, for one). */
  walletPayQuote(params: { quote: string; mint: string; note?: string }): { paid: boolean };
  /** Reads a Lightning address or LNURL and fetches what it asks for. Its domain learns of the request. */
  lnurlResolve(params: { text: string }): LnurlView;
  /** The invoice for `amount` sats from a resolved address, checked before it is quoted. */
  lnurlInvoice(params: { id: string; amount: number; comment?: string }): { invoice: string; successAction?: LnurlSuccessAction; note: string };
  /** "I paid it from another wallet": the contact's app looks now. Only its wallet marks the request paid. */
  checkPayment(params: { linkId: string; paymentId: string }): void;
  /** Makes a provider this mode's Lightning source. `values`: its form; secret fields are sealed, never returned. */
  lightningSetSource(params: { providerId: string; values: Record<string, string> }): void;
  lightningClearSource(): void;
  /** Tries the mode's Lightning source again now, instead of after the wait between attempts. */
  lightningRetrySource(): void;
  /** Changes the server of the saved Lightning source (its `changeable` fields), keeping its secrets. */
  lightningReconfigureSource(params: { values: Record<string, string> }): void;
  lightningRefresh(): void;
  bitcoinSetSource(params: { providerId: string; values: Record<string, string> }): void;
  bitcoinClearSource(): void;
  bitcoinRetrySource(): void;
  /** Changes the server of the saved Bitcoin source (a BDK wallet's Esplora), keeping the wallet. */
  bitcoinReconfigureSource(params: { values: Record<string, string> }): void;
  bitcoinReceiveAddress(): string;
  bitcoinRefresh(): void;
  /** Redeems a token pasted by the user. Only mints the user added are accepted. */
  walletReceiveToken(params: { token: string }): { amount: number };
  walletInspectCashu(params: { text: string }): { inspection: CashuInspection | null };
  /** Everything held, as tokens: the only backup there is for now. */
  walletExport(): { mint: string; token: string; amount: number }[];
  sendPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number }): { paymentId: string };
  requestPayment(params: { linkId: string; amount: number; memo?: string; timestamp: number; method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin"; rail?: "cashu" | "lightning" }): { paymentId: string };
  /** A request any member of a group may pay, once (WISP 9xx § Payments). */
  requestGroupPayment(params: { groupId: string; amount: number; memo?: string; timestamp: number; rail: "cashu" | "lightning" }): { paymentId: string };
  /** The payment composer opened on a member of a community group: their app is asked what ways of paying it takes. */
  groupPaymentHello(params: { groupId: string; member: string }): void;
  /** Asks the contact for a way to pay it (Ark, USDT); its answer is a request carrying `askId`. */
  askToPay(params: { linkId: string; amount: number; method: "arkade" | "usdt" | "bark" | "bitcoin"; memo?: string; timestamp: number }): { askId: string };
  /** `via: "lightning"`: the Lightning payment the person reviewed, never ecash instead, within `maxFee`. */
  payRequest(params: { linkId: string; paymentId: string; via?: "lightning"; maxFee?: number }): void;
  reclaimPayment(params: { paymentId: string }): void;
  disconnect(params: { linkId: string }): void;
  addService(params: { name: string; target: string }): { serviceId: string };
  removeService(params: { serviceId: string }): void;
  setServiceEnabled(params: { serviceId: string; enabled: boolean }): void;
  setServiceShared(params: { serviceId: string; peerPubKeyZ32: string; shared: boolean }): void;
  updateSettings(params: { settings: Partial<Settings> }): void;
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
  sendGroupMessage(params: { groupId: string; text: string }): { error: string | null };
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
}
export type EngineEvent =
  | { kind: "attention"; event: AttentionEvent }
  | { kind: "state"; state: EngineState }
  | { kind: "messages"; linkId: string; messages: StoredMessage[] }
  | { kind: "call-signal"; linkId: string; signal: string };
