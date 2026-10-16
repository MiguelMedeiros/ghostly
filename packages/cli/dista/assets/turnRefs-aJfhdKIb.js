import { f as node, g as state, i as chatOrGroup, s as findGroup } from "./apiKit-BeSsbld5.js";
import { createHash } from "node:crypto";
//#region src/engineMethods.ts
/**
* The engine's calls the daemon passes through as `engine.<method>` (WISP 1100 § Local control API): exactly the
* app's `EngineApi` (packages/browser/src/shared/rpc.ts; `engineMethods.test.ts` keeps the two equal), plus two
* reads every host has. Nothing else on the engine object is reachable.
*/
var ENGINE_METHODS = [
	"usdtCreate",
	"usdtUnlock",
	"usdtReveal",
	"usdtLock",
	"usdtRefresh",
	"usdtExportBackup",
	"usdtRestoreBackup",
	"arkCreate",
	"arkUnlock",
	"arkLock",
	"arkBackup",
	"arkExportBackup",
	"arkRestoreBackup",
	"arkRefresh",
	"arkRecover",
	"barkCreate",
	"barkBackup",
	"barkExportBackup",
	"barkRestoreBackup",
	"barkRefresh",
	"barkBoard",
	"fedimintPreview",
	"fedimintJoin",
	"fedimintLeave",
	"fedimintRefresh",
	"fedimintSpendNotes",
	"fedimintReceiveNotes",
	"fedimintInvoice",
	"fedimintTakeBack",
	"fedimintBackup",
	"fedimintExportBackup",
	"fedimintRestoreBackup",
	"fedimintRestorePhrase",
	"sparkCreate",
	"sparkBackup",
	"sparkExportBackup",
	"sparkRestoreBackup",
	"sparkRefresh",
	"sparkUseForLightning",
	"preparePayment",
	"approvePayment",
	"reconcilePayment",
	"cancelPayment",
	"refreshPublicProfiles",
	"choosePublicProfile",
	"preparePeerProof",
	"submitPeerProof",
	"withdrawPeerProof",
	"beginIdentityProof",
	"completeIdentityProof",
	"cancelIdentityProof",
	"removeIdentityProof",
	"shareIdentityProof",
	"withdrawIdentityProof",
	"recheckIdentityProof",
	"lookupIdentityDisplay",
	"loadPublicProfile",
	"loadPublicPosts",
	"loadPublicGraph",
	"loadPublicPostImage",
	"clearProfileData",
	"setDidListed",
	"nostrLoadContact",
	"nostrForgetContact",
	"nostrLoadOwn",
	"nostrLookup",
	"nostrDraft",
	"nostrPublish",
	"createLink",
	"takeInvite",
	"joinLink",
	"ensureLink",
	"confirmPair",
	"pollNow",
	"removeLink",
	"renameLink",
	"setActiveLink",
	"sendMessage",
	"editMessage",
	"retryMessage",
	"react",
	"pinMessage",
	"appId",
	"appOpen",
	"appClose",
	"appSend",
	"messageDetails",
	"deleteMessage",
	"exportLinks",
	"sendFile",
	"forwardMessages",
	"fileAction",
	"setDeliveryMode",
	"setTransportPreference",
	"setChatTransport",
	"setChatPaymentMethods",
	"setChatHold",
	"connect",
	"walletAddMint",
	"walletCreate",
	"walletRemove",
	"walletTestCoins",
	"walletSetupRetry",
	"walletSetupDismiss",
	"wake",
	"peekProfile",
	"walletSetPrimaryMint",
	"walletRemoveMint",
	"walletReceiveLightning",
	"walletQuoteInvoice",
	"walletPayQuote",
	"lnurlResolve",
	"lnurlInvoice",
	"checkPayment",
	"lightningSetSource",
	"lightningClearSource",
	"lightningRetrySource",
	"lightningReconfigureSource",
	"lightningRefresh",
	"lightningSetReceive",
	"lightningRename",
	"bitcoinSetSource",
	"bitcoinClearSource",
	"bitcoinRetrySource",
	"bitcoinReconfigureSource",
	"bitcoinReceiveAddress",
	"bitcoinRefresh",
	"walletReceiveToken",
	"walletInspectCashu",
	"walletExport",
	"walletBackupReminder",
	"sendPayment",
	"requestPayment",
	"requestGroupPayment",
	"groupPaymentHello",
	"askToPay",
	"payRequest",
	"reclaimPayment",
	"disconnect",
	"addService",
	"removeService",
	"setServiceEnabled",
	"setServiceShared",
	"updateSettings",
	"setCallSignal",
	"setTyping",
	"setWakeSubscription",
	"setWakeMuted",
	"wakeForCall",
	"setCallOn",
	"wakeConfirm",
	"setFastPoll",
	"createGroup",
	"inviteToGroup",
	"acceptGroupInvitation",
	"declineGroupInvitation",
	"enableGroupLink",
	"disableGroupLink",
	"joinGroupByLink",
	"sendGroupMessage",
	"sendGroupFile",
	"groupFileCheck",
	"pressButton",
	"groupMessages",
	"messagePage",
	"statusCardIndex",
	"groupTaken",
	"leaveGroup",
	"removeGroupMember",
	"makeGroupAdmin",
	"setGroupHub",
	"rotateGroup",
	"setGroupPicture",
	"renameGroup",
	"setGroupTyping",
	"forgetGroup",
	"setGroupManage",
	"deviceEnrollInvite",
	"deviceEnrollConfirm",
	"deviceEnrollCancel",
	"deviceEnrollView",
	"deviceEnrollJoin",
	"deviceEnrollReady",
	"deviceEnrollFinish",
	"deviceEnrollRemove",
	"deviceSet",
	"devicePing",
	"deviceHandoffVerifier",
	"deviceHandoffPush",
	"deviceHandoffPull",
	"deviceHandoffAccept",
	"deviceHandoffSettle",
	"deviceHandoffCancel",
	"deviceHandoffView",
	"deviceHandoffAllow",
	"deviceTakeoverInfo",
	"deviceTakeover",
	"deviceTurnPeek",
	"deviceForkDiscard",
	"deviceRestoreStartOwn",
	"deviceRemove",
	"deviceNewSecret",
	"deviceSecretOfferDismiss",
	"deviceSetNoticeSeen",
	"deviceTurnCheck",
	"devicePushState",
	"devicePushSet",
	"appList",
	"appBuiltIns",
	"appStoreList",
	"appStorePreview",
	"appStoreAdd",
	"appStoreRemove",
	"appStoreRefresh",
	"appPreview",
	"appInstall",
	"appUpdateAccept",
	"appCheckUpdates",
	"appUninstall",
	"appRunCheck",
	"appFetchFiles",
	"appEntry",
	"appFile",
	"appFileAt",
	"appStorageGet",
	"appStorageSet",
	"appStorageDelete",
	"appStorageKeys",
	"appDataExport",
	"appDataExportText"
];
/** Reads the hosts use outside `EngineApi`: the whole state, and one chat's stored messages. */
var ENGINE_READS = ["getState", "getMessages"];
/**
* Calls whose answer holds a secret (chat seeds, wallet phrases and keys, ecash, backups): the CLI prints their
* result only with `--show-secret`.
*/
var SECRET_RESULTS = /* @__PURE__ */ new Set([
	"exportLinks",
	"takeInvite",
	"walletExport",
	"usdtReveal",
	"arkBackup",
	"barkBackup",
	"sparkBackup",
	"fedimintBackup",
	"usdtExportBackup",
	"arkExportBackup",
	"barkExportBackup",
	"sparkExportBackup",
	"fedimintExportBackup",
	"fedimintSpendNotes"
]);
//#endregion
//#region src/turnRefs.ts
/**
* The id an agent turn names its message by (docs/CLI.md § Agent turns). A message is stored under an id its sender
* chose most of (`peer_<the id they sent>`), so a turn carries this one instead, made here from the chat (or group) and
* that id: `t_` and 32 hex digits, in which nobody can write a word. Every command that takes a message's id takes it.
*/
function turnRef(where, messageId) {
	return "t_" + createHash("sha256").update(`${where}\n${messageId}`).digest("hex").slice(0, 32);
}
var TURN_REF = /^t_[0-9a-f]{32}$/;
var isRef = (value) => typeof value === "string" && TURN_REF.test(value);
/**
* `params` with each turn's id in `message`, `reply` and `messages` as the id its message is stored under: looked for
* among the chat's (or group's) newest messages first, where a turn's almost always is, then in all of them. One that
* names no message stays as given, and its command says so as for any unknown id.
*/
async function withStoredIds(ctx, params) {
	const wanted = new Set([
		params.message,
		params.reply,
		...Array.isArray(params.messages) ? params.messages : []
	].filter(isRef));
	if (!wanted.size) return params;
	let target = null;
	try {
		if (typeof params.group === "string") {
			const group = findGroup(state(ctx).groups, params.group);
			target = {
				id: group.id,
				linkId: `group:${group.id}`,
				group: true
			};
		} else if (typeof params.chat === "string") target = chatOrGroup(ctx, params.chat);
	} catch {}
	if (!target) return params;
	const { id, linkId, group } = target;
	const found = /* @__PURE__ */ new Map();
	const look = (messages) => {
		for (const message of messages) {
			const ref = turnRef(id, message.id);
			if (wanted.has(ref)) found.set(ref, message.id);
		}
		return found.size === wanted.size;
	};
	if (!look((await node(ctx).messagePage({
		linkId,
		limit: 200
	})).messages)) look(group ? await node(ctx).groupMessages({ groupId: id }) : await node(ctx).getMessages(linkId));
	const stored = (value) => isRef(value) ? found.get(value) ?? value : value;
	return {
		...params,
		...params.message !== void 0 && { message: stored(params.message) },
		...params.reply !== void 0 && { reply: stored(params.reply) },
		...Array.isArray(params.messages) && { messages: params.messages.map(stored) }
	};
}
//#endregion
export { SECRET_RESULTS as a, ENGINE_READS as i, withStoredIds as n, ENGINE_METHODS as r, turnRef as t };

//# sourceMappingURL=turnRefs-aJfhdKIb.js.map