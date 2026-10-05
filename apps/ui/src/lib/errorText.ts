import { parseEngineError, type EngineErrorCode } from "@ghostly/core";
import type { Translate, TranslationKey } from "../contexts/I18nContext";
import { formatAmount } from "./amount";
import { english } from "./english";

/*
 * An error said in the app's language. The engine, the platform layer and the extension throw plain English (they
 * run outside the page, or in a CLI, and their messages go to logs and bots as they are), and the page used to show
 * that English as it came. Here the known ones are matched and said with the page's `t()`; one this table does not
 * know is shown as it came, so nothing is hidden. The English stays in the thrown error for logs and details.
 */

type Params = Record<string, string | number>;
interface Rule {
  match: RegExp;
  key: TranslationKey;
  /** What goes into the translation, from the match's named groups (all of them, as they are, by default). */
  params?: (groups: Record<string, string>, t: Translate) => Params;
}

const exact = (text: string, key: TranslationKey): Rule => ({ match: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), key });

/** A payment method as the engine names it ("on-chain Bitcoin", "USDT support", ...): a name, but for the words. */
const railName = (rail: string, t: Translate) =>
  rail === "on-chain Bitcoin" ? t("errors.pay.onchain")
    : rail === "USDT support" ? "USDT"
      : rail === "the Ark payment capability" ? "Ark"
        : rail;

const NETWORK = "(?<network>Mainnet|Testnet)";
const HOST = "(?<host>[^\\s:/]+(?::\\d+)?)";

const RULES: readonly Rule[] = [
  // The extension's service worker and page (apps/extension/src).
  exact("The Ghostly peer did not start. Reopen the extension to retry.", "errors.extension.peerNotStarted"),
  exact("The Ghostly peer is unavailable. Reopen the extension to retry.", "errors.extension.peerUnavailable"),
  exact("Switching profiles…", "errors.extension.switchingProfiles"),
  exact("Ghostly needs the sign-in permission for this.", "errors.extension.signInPermission"),
  { match: /^Sign-in (?:was )?cancelled\.?$/, key: "errors.extension.signInCancelled" },
  exact("Could not open a wallet", "errors.extension.openWallet"),
  exact("Could not open the service", "errors.extension.openService"),
  exact("Could not open a tab", "errors.extension.openTab"),
  exact("Not a payment link", "errors.extension.notPaymentLink"),

  // The page's way to the peer and its services (packages/browser/src/platform).
  exact("Ghostly is starting…", "errors.app.starting"),
  exact("Ghostly is still starting. Try again in a moment.", "errors.app.stillStarting"),
  exact("Lost the Ghostly peer", "errors.app.lostPeer"),
  exact("Ghostly needs your permission to reach that local address", "errors.app.localAddress"),
  exact("Pick a Lightning card first", "errors.app.pickCard"),
  exact("This client cannot install updates", "errors.app.installUpdates"),
  exact("That update is no longer available", "errors.app.updateGone"),
  exact("This browser cannot wake Ghostly while it is closed.", "errors.app.wakeUnsupported"),
  exact("Your signer holds a different key than this identity. Nothing was published.", "errors.app.signerKey"),
  exact("Connect to an updated peer to send files", "errors.files.updatedPeerToSend"),
  exact("Connect to an updated peer first", "errors.files.updatedPeerFirst"),
  exact("That recording cannot be sent as a voice message", "errors.files.notVoice"),
  exact("This file cannot be retried", "errors.files.cannotRetry"),
  exact("This file is no longer here", "errors.files.gone"),
  { match: /^Not enough space on your contact's device for this file \((?<free>.+) free\)\.$/, key: "errors.files.noRoom" },
  { match: /^That file is too large for your contact's app \(max (?<max>.+)\)\. Larger files need an updated Ghostly on their side\.$/, key: "errors.files.tooLargeForContact" },
  { match: /^That file is too large \(max (?<size>.+)\)\.$/, key: "chat.fileTooLarge" },
  exact("That is too large to paste. Send it with + → Document.", "errors.files.pasteTooLarge"),
  exact("This device cannot decode the recording", "errors.files.cannotDecodeRecording"),
  exact("The video took too long", "errors.files.videoTooSlow"),

  // Cashu and Lightning in the wallet (packages/browser/src/engine/wallet.ts).
  exact("That is not a valid mint URL", "errors.cashu.badMintUrl"),
  exact("Mints must use https", "errors.cashu.mintHttps"),
  exact("Enter an amount in sats", "errors.cashu.enterAmount"),
  { match: /^Amounts above (?<max>[\d.,\s\u00a0\u202f]+) sats are not supported$/, key: "errors.cashu.amountTooHigh" },
  { match: new RegExp(`^Could not reach ${HOST}\\. Check the address: it should be a Cashu mint\\.$`), key: "errors.cashu.unreachable" },
  { match: new RegExp(`^${HOST} has not paid its test coins yet: they show up here once it does$`), key: "errors.cashu.testCoinsPending" },
  { match: new RegExp(`^Ecash from ${HOST} is not accepted$`), key: "errors.cashu.mintNotAccepted" },
  { match: new RegExp(`^${HOST} did not answer$`), key: "errors.cashu.noAnswer" },
  exact("No mint configured", "errors.cashu.noMint"),
  { match: /^No mint could create an invoice: (?<reason>[\s\S]+)$/, key: "errors.cashu.noInvoice", params: ({ reason }, t) => ({ reason: errorText(reason, t) }) },
  exact("This wallet has no test mint to ask for test coins", "errors.cashu.noTestMint"),
  exact("Select a configured mint", "errors.cashu.selectMint"),
  exact("That is not a valid ecash token", "errors.cashu.badToken"),
  exact("Add a mint in Settings first", "errors.cashu.addMint"),
  exact("Not enough sats in your wallet", "errors.cashu.notEnough"),
  exact("This invoice is already being paid", "errors.cashu.alreadyPaying"),
  exact("A Lightning payment from this wallet is still in flight: wait for it to settle, then remove the wallet.", "errors.cashu.inFlight"),
  // A failed payment and what came back: "<why> The sats are back in your wallet[, less N sats the mint kept as its fee]."
  { match: /^(?<reason>[\s\S]+?) The sats are back in your wallet, less (?<fee>\d+) sats? the mint kept as its fee\.$/, key: "errors.cashu.backInWalletLessFee", params: ({ reason, fee }, t) => ({ reason: errorText(reason, t), fee }) },
  { match: /^(?<reason>[\s\S]+?) The sats are back in your wallet\.$/, key: "errors.cashu.backInWallet", params: ({ reason }, t) => ({ reason: errorText(reason, t) }) },
  exact("The Lightning payment did not go through.", "errors.cashu.lightningFailed"),

  // Payments in a chat (packages/browser/src/engine/payments.ts, paymentAdapters/walletInstances.ts).
  exact("Cashu is off in this chat", "errors.pay.cashuOff"),
  { match: /^Both peers need (?<rail>USDT support|the Ark payment capability|Bark|Fedimint|Spark|on-chain Bitcoin) on a connected data link$/, key: "errors.pay.bothNeed", params: ({ rail }, t) => ({ rail: railName(rail, t) }) },
  { match: new RegExp(`^Join a federation first \\(Wallet → New → ${NETWORK} Fedimint\\)$`), key: "errors.pay.joinFederation" },
  { match: new RegExp(`^You have no ${NETWORK} (?<method>.+) wallet: create one in Wallet → New$`), key: "errors.pay.youHaveNone", params: ({ network, method }, t) => ({ network, method: railName(method, t) }) },
  { match: new RegExp(`^Your contact has no ${NETWORK} (?<method>.+) wallet$`), key: "errors.pay.contactHasNone", params: ({ network, method }, t) => ({ network, method: railName(method, t) }) },
  { match: new RegExp(`^${NETWORK} (?<method>.+) is off in this chat$`), key: "errors.pay.offHere", params: ({ network, method }, t) => ({ network, method: railName(method, t) }) },
  { match: /^(?<method>Cashu|Lightning) is not allowed by both of you here$/, key: "errors.pay.notBoth" },
  exact("Your contact allowed neither Cashu nor Lightning in this chat", "errors.pay.contactAllowsNeither"),
  exact("Your contact took no Cashu or Lightning last time. Try again once the chat is live", "errors.pay.contactTookNone"),
  exact("Cashu and Lightning are off in this chat", "errors.pay.bothOff"),
  exact("A request to the group is paid in Cashu or over Lightning", "errors.pay.groupRails"),
  exact("Unknown payment request", "errors.pay.unknownRequest"),
  exact("Review and explicitly approve this payment before sending", "errors.pay.reviewFirst"),
  exact("This request is no longer open", "errors.pay.requestClosed"),
  exact("A Lightning payment for this request is still pending", "errors.pay.lightningPending"),
  exact("You already paid this request", "errors.pay.alreadyPaid"),
  exact("Already paid by another member of the group", "errors.pay.paidByOther"),
  exact("The payment was refused", "errors.pay.refused"),
  // A refused send whose ecash came back (payments.ts refusedLine): why, and what came back, less the mint's fee.
  { match: /^Refused: (?<reason>[\s\S]+?)\. (?<amount>\d+) sats? came back; the mint kept (?<fee>\d+) as its fee\.$/, key: "errors.pay.refusedLessFee", params: ({ reason, amount, fee }, t) => ({ reason: errorText(reason, t).replace(/\.$/, ""), amount: formatAmount(Number(amount), t.language ?? "en"), fee: formatAmount(Number(fee), t.language ?? "en") }) },
  { match: /^Refused: (?<reason>[\s\S]+?)\. All (?<amount>\d+) sats? came back\.$/, key: "errors.pay.refusedAllBack", params: ({ reason, amount }, t) => ({ reason: errorText(reason, t).replace(/\.$/, ""), amount: formatAmount(Number(amount), t.language ?? "en") }) },
  { match: /^Refused: (?<reason>[\s\S]+?)\. The sats came back\.$/, key: "errors.pay.refusedBack", params: ({ reason }, t) => ({ reason: errorText(reason, t).replace(/\.$/, "") }) },
  exact("This request cannot be paid over Lightning in this chat", "errors.pay.noLightningHere"),
  exact("No way of paying this request is allowed in this chat", "errors.pay.noWayHere"),
  exact("The invoice does not match the requested amount", "errors.pay.invoiceMismatch"),
  { match: /^The Lightning fee \((?<fee>\d+) sats\) is too high$/, key: "errors.pay.feeTooHigh" },
  exact("Nothing to take back", "errors.pay.nothingToTakeBack"),
  exact("The federation has not answered yet: try again in a moment", "errors.pay.federationSilent"),
  exact("Nothing to reclaim", "errors.pay.nothingToReclaim"),
  { match: /^Your contact does not accept (?<method>.+) in this chat$/, key: "errors.pay.contactRefuses", params: ({ method }, t) => ({ method: railName(method, t) }) },
  exact("This request cannot be paid from another wallet", "errors.pay.notFromOtherWallet"),
  exact("You are offline", "errors.pay.offline"),
  exact("This is a Mainnet payment (real money): a Testnet wallet never pays it. Use a Mainnet wallet.", "errors.pay.wrongNetworkMainnet"),
  exact("This is a Testnet payment (test coins): a Mainnet wallet never pays it. Use a Testnet wallet.", "errors.pay.wrongNetworkTestnet"),
  { match: /^This pays with real money: confirm it with Send real money first\. Nothing was sent\.$/, key: "errors.pay.confirmRealFirst", params: (_, t) => ({ button: t("payments.confirmReal.send") }) },
  { match: /^Could not create the (?<label>.+?) wallet: (?<reason>[\s\S]+)\. Nothing was saved; try again\.$/, key: "errors.pay.createFailed", params: ({ label, reason }, t) => ({ label: railName(label, t), reason: errorText(reason, t).replace(/\.$/, "") }) },

  // Groups (packages/core/src/groupSession.ts and groupCommunity.ts, packages/browser/src/engine/groups.ts and
  // community.ts): why a group stopped (its notice, the line under its name, its row in the list), what a send or an
  // edit was refused for, and what the members panel, the leave dialog and a group's link answer.
  exact("You were removed from this group", "errors.group.removed"),
  exact("You left this group", "errors.group.left"),
  { match: /^Member (?<member>\S+) holds a different membership history for epoch (?<epoch>\d+)\. Membership changes are halted; the admin must re-form the group\.$/, key: "errors.group.forkedMember" },
  { match: /^The admin signed two different changes after epoch (?<epoch>\d+)\. Membership changes are halted; the admin must re-form the group\.$/, key: "errors.group.forkedAdminChanges" },
  { match: /^The admin signed changes on two branches after epoch (?<epoch>\d+)\. Membership changes are halted; the admin must re-form the group\.$/, key: "errors.group.forkedAdminBranches" },
  exact("Two members let people in at the same moment and yours did not count. Asking to be let in again…", "errors.group.lost"),
  exact("You are no longer in this group", "errors.group.noLonger"),
  exact("You are not in this group yet", "errors.group.notYet"),
  exact("You are not in this group", "errors.group.notIn"),
  exact("Nothing to send", "errors.group.nothingToSend"),
  exact("Message exceeds 16 KiB", "errors.group.tooLong"),
  exact("This epoch's key has not arrived yet. Wait for a member to catch you up.", "errors.group.keyNotHere"),
  exact("Only your own messages can be edited", "errors.group.editOwnOnly"),
  exact("This message was edited too many times", "errors.group.editTooMany"),
  exact("This message is too old to edit: its epoch's key is gone", "errors.group.editTooOld"),
  exact("An edit cannot be empty", "errors.group.editEmpty"),
  exact("Too long to edit in this group", "errors.group.editTooLong"),
  exact("Only the admin can invite", "errors.group.adminInvites"),
  exact("This contact is already a member", "errors.group.alreadyMember"),
  { match: /^A group holds (?<max>\d+) members at most$/, key: "errors.group.full" },
  exact("Connect to this contact first. Their app needs groups (an updated Ghostly).", "errors.group.connectFirst"),
  exact("The contact who invited you is not connected. Try again when they are.", "errors.group.inviterAway"),
  exact("You are the admin and nobody else in the group is online to take over. Try again when a member is, or make someone the admin first.", "errors.group.adminAlone"),
  exact("Nobody in the group is connected right now to take your leave. Try again in a moment.", "errors.group.nobodyForLeave"),
  exact("Only the admin can share a link to the group", "errors.group.adminShares"),
  exact("This is not a link to a group", "errors.group.notALink"),
  exact("You are already joining this group", "errors.group.alreadyJoining"),
  exact("This group is joined with its current link", "errors.group.currentLink"),
  exact("Only the admin can change the members of this group", "errors.group.adminMembers"),
  exact("Only the admin can do that", "errors.group.adminOnly"),
  exact("Make someone else the admin before leaving", "errors.group.adminFirst"),
  exact("Only the admin can change the group's picture", "errors.group.adminPicture"),
  exact("Only the admin can rename the group", "errors.group.adminRename"),
  exact("Only the admin can choose the group's hubs", "errors.group.adminHubs"),
  exact("Only the admin can replace or turn off the group's link", "errors.group.adminLink"),
  exact("This group has reached its membership history limit. Create a new group.", "errors.group.chainFull"),
  exact("This group runs through hubs, which their app does not take part in: they need an updated Ghostly first.", "errors.group.hubsNeedUpdate"),
  { match: /^Their app takes groups of (?<max>\d+) at most: they need an updated Ghostly first\.$/, key: "errors.group.legacyApp" },
  { match: /^A group grows past (?<max>\d+) only when everyone is on an updated Ghostly\. Not seen updated yet: (?<names>[\s\S]+)\.$/, key: "errors.group.growNeedsUpdates" },
  exact("Share the group's link with them: anyone who opens it joins", "errors.group.shareLinkInstead"),
  { match: /^At most (?<max>\d+) members can be pinned as hubs$/, key: "errors.group.hubsPinned" },
  exact("A community group chooses its hubs by itself", "errors.group.communityHubs"),

  // Profiles, backups and pictures (apps/ui/src/lib).
  exact("Give the profile a name", "errors.profile.giveName"),
  exact("That profile already exists", "errors.profile.exists"),
  { match: /^The first profile cannot be (?:removed|deleted)$/, key: "errors.profile.firstStays" },
  exact("Switch to another profile first", "errors.profile.switchFirst"),
  exact("Unknown profile", "errors.profile.unknown"),
  exact("This profile is open in another window. Close it, then try again.", "errors.profile.openElsewhere"),
  exact("Wrong lock password for that profile", "errors.profile.wrongPassword"),
  exact("This backup does not hold a profile", "errors.profile.notABackup"),
  exact("Wrong passphrase, or the backup was changed", "errors.profile.wrongPassphrase"),
  exact("This is not a Ghostly backup", "errors.profile.notGhostlyBackup"),
  { match: /^This backup(?: is damaged: it was changed or cut short|'s database is malformed)$/, key: "errors.profile.damagedBackup" },
  exact("This backup is too large to restore", "errors.profile.backupTooLarge"),
  exact("This backup comes from a newer Ghostly; update to restore it", "errors.profile.newerBackup"),
  { match: /^Unsupported backup (?:encryption|format)$/, key: "errors.profile.unsupportedBackup" },
  exact("Use at least 12 characters for the backup passphrase", "errors.profile.shortPassphrase"),
  exact("This device has no storage for files", "errors.profile.noFileStorage"),
  exact("This device has no room left for this backup. Free some space, then try again.", "errors.profile.noRoom"),
  { match: /^Could not read the Ark wallet for the backup: (?<reason>[\s\S]+)$/, key: "errors.profile.arkBackup", params: ({ reason }, t) => ({ reason: errorText(reason, t) }) },
  exact("This wallet has no recovery phrase to show", "errors.profile.noPhrase"),
  exact("This wallet has no backup file", "errors.profile.noBackupFile"),
  exact("Choose a picture", "errors.picture.choose"),
  exact("That picture is too large (max 20 MB)", "errors.picture.tooLarge"),
  exact("This picture cannot be read here. Try a JPEG or PNG.", "errors.picture.unreadableTryJpeg"),
  exact("This picture cannot be read here", "errors.picture.unreadable"),
  exact("This picture could not be made small enough", "errors.picture.cannotShrink"),
];

/**
 * The engine's known errors (@ghostly/core ENGINE_ERRORS) that no rule above says: read back into their code and
 * values, and said with `errors.engine.<code>`. A code a rule above already says is not here: the rule goes first.
 */
const ENGINE: Partial<Record<EngineErrorCode, TranslationKey>> = {
  lnurlUnreachable: "errors.engine.lnurlUnreachable",
  hostUnreachable: "errors.engine.hostUnreachable",
  networkUnreachable: "errors.engine.networkUnreachable",
  hostTimedOut: "errors.engine.hostTimedOut",
  networkTimedOut: "errors.engine.networkTimedOut",
  testMintOnMainnet: "errors.engine.testMintOnMainnet",
  realMintOnTestnet: "errors.engine.realMintOnTestnet",
  mintHoldsSats: "errors.engine.mintHoldsSats",
  lastMint: "errors.engine.lastMint",
  noSharedMint: "errors.engine.noSharedMint",
  reviewedSatsGone: "errors.engine.reviewedSatsGone",
  invoiceExpired: "errors.engine.invoiceExpired",
  feeAboveLimit: "errors.engine.feeAboveLimit",
  cashuFeeAboveLimit: "errors.engine.cashuFeeAboveLimit",
  invalidMaxFee: "errors.engine.invalidMaxFee",
  methodUnavailable: "errors.engine.methodUnavailable",
  unknownPaymentIntent: "errors.engine.unknownPaymentIntent",
  paymentExpired: "errors.engine.paymentExpired",
  requestHasPayment: "errors.engine.requestHasPayment",
  requestPaymentInFlight: "errors.engine.requestPaymentInFlight",
  requestNotAwaiting: "errors.engine.requestNotAwaiting",
  reconnectBeforeApprove: "errors.engine.reconnectBeforeApprove",
  cannotSubmitAgain: "errors.engine.cannotSubmitAgain",
  alreadySubmitted: "errors.engine.alreadySubmitted",
  sentAfterReview: "errors.engine.sentAfterReview",
  cannotCancelSubmitted: "errors.engine.cannotCancelSubmitted",
  outcomeUnknown: "errors.engine.outcomeUnknown",
  notYetConfirmed: "errors.engine.notYetConfirmed",
  couldNotVerify: "errors.engine.couldNotVerify",
  paymentTakenBack: "errors.engine.paymentTakenBack",
  parkedSigned: "errors.engine.parkedSigned",
  ecashAlreadySpent: "errors.engine.ecashAlreadySpent",
  reviewedEcashSpent: "errors.engine.reviewedEcashSpent",
  lnurlExactly: "errors.engine.lnurlExactly",
  lnurlRange: "errors.engine.lnurlRange",
  usdtRpcUnavailable: "errors.engine.usdtRpcUnavailable",
  usdtNotEnoughTokens: "errors.engine.usdtNotEnoughTokens",
  usdtNotEnoughGas: "errors.engine.usdtNotEnoughGas",
  usdtGasAboveLimit: "errors.engine.usdtGasAboveLimit",
  usdtNeedsSepoliaGas: "errors.engine.usdtNeedsSepoliaGas",
  fedimintNotInvite: "errors.engine.fedimintNotInvite",
  fedimintAlreadyJoined: "errors.engine.fedimintAlreadyJoined",
  fedimintConnecting: "errors.engine.fedimintConnecting",
  fedimintNotEnough: "errors.engine.fedimintNotEnough",
  fedimintRealOnTestnet: "errors.engine.fedimintRealOnTestnet",
  fedimintTestOnMainnet: "errors.engine.fedimintTestOnMainnet",
  walletAway: "errors.engine.walletAway",
  walletAwayUnnamed: "errors.engine.walletAwayUnnamed",
  groupTurnUnconfirmed: "errors.engine.groupTurnUnconfirmed",
};
/** The values that are amounts: written again the app's way (the engine wrote them its own way). */
const AMOUNTS = new Set(["amount", "fee", "min", "max"]);

/**
 * The English of an error as it was thrown. `String(error)` on the way through the extension's messages adds
 * "Error: " in front ("Error: The Ghostly peer did not start…"): that goes.
 */
export function rawError(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);
  return text.replace(/^(?:(?:[A-Z][A-Za-z]*)?Error: )+/, "").trim();
}

/** `cause` said in `t`'s language when it is a known error, else as it came (see above). */
export function errorText(cause: unknown, t: Translate = english): string {
  const raw = rawError(cause);
  for (const rule of RULES) {
    const found = raw.match(rule.match);
    if (!found) continue;
    const groups = { ...found.groups };
    return t(rule.key, rule.params ? rule.params(groups, t) : groups);
  }
  const known = parseEngineError(raw);
  const key = known && ENGINE[known.code];
  if (known && key) {
    const amount = (value: string) => { const digits = value.replace(/\D/g, ""); return digits ? formatAmount(Number(digits), t.language ?? "en") : value; };
    return t(key, Object.fromEntries(Object.entries(known.values).map(([name, value]) => [name, AMOUNTS.has(name) ? amount(value) : value])));
  }
  return raw;
}

/** Every rule's pattern, for the test that each still matches what its source throws. */
export const ERROR_RULES: readonly { match: RegExp; key: string }[] = RULES;
