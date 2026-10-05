/**
 * The engine's calls the daemon passes through as `engine.<method>` (WISP 1100 § Local control API): exactly the
 * app's `EngineApi` (packages/browser/src/shared/rpc.ts; `engineMethods.test.ts` keeps the two equal), plus two
 * reads every host has. Nothing else on the engine object is reachable.
 */
export const ENGINE_METHODS: readonly string[] = [
  "usdtCreate", "usdtUnlock", "usdtReveal", "usdtLock", "usdtRefresh", "usdtExportBackup", "usdtRestoreBackup",
  "arkCreate", "arkUnlock", "arkLock", "arkBackup", "arkExportBackup", "arkRestoreBackup", "arkRefresh", "arkRecover",
  "barkCreate", "barkBackup", "barkExportBackup", "barkRestoreBackup", "barkRefresh", "barkBoard", "fedimintPreview",
  "fedimintJoin", "fedimintLeave", "fedimintRefresh", "fedimintSpendNotes", "fedimintReceiveNotes", "fedimintInvoice",
  "fedimintTakeBack", "fedimintBackup", "fedimintExportBackup", "fedimintRestoreBackup", "fedimintRestorePhrase",
  "sparkCreate", "sparkBackup", "sparkExportBackup", "sparkRestoreBackup", "sparkRefresh", "sparkUseForLightning",
  "preparePayment", "approvePayment", "reconcilePayment", "cancelPayment", "refreshPublicProfiles",
  "choosePublicProfile", "preparePeerProof", "submitPeerProof", "withdrawPeerProof", "beginIdentityProof",
  "completeIdentityProof", "cancelIdentityProof", "removeIdentityProof", "shareIdentityProof",
  "withdrawIdentityProof", "recheckIdentityProof", "lookupIdentityDisplay", "loadPublicProfile", "loadPublicPosts",
  "loadPublicGraph", "loadPublicPostImage", "clearProfileData", "setDidListed", "nostrLoadContact", "nostrForgetContact", "nostrLoadOwn",
  "nostrLookup", "nostrDraft", "nostrPublish", "createLink", "takeInvite", "joinLink", "ensureLink", "confirmPair",
  "pollNow", "removeLink", "renameLink", "setActiveLink", "sendMessage", "editMessage", "retryMessage", "react", "pinMessage", "messageDetails",
  "deleteMessage", "exportLinks", "sendFile", "forwardMessages", "fileAction", "setDeliveryMode", "setTransportPreference",
  "setChatTransport", "setChatPaymentMethods", "setChatHold", "connect", "walletAddMint", "walletCreate",
  "walletRemove", "walletTestCoins", "walletSetupRetry", "walletSetupDismiss", "wake", "peekProfile", "walletSetPrimaryMint", "walletRemoveMint", "walletReceiveLightning",
  "walletQuoteInvoice", "walletPayQuote", "lnurlResolve", "lnurlInvoice", "checkPayment", "lightningSetSource",
  "lightningClearSource", "lightningRetrySource", "lightningReconfigureSource", "lightningRefresh",
  "lightningSetReceive", "lightningRename", "bitcoinSetSource", "bitcoinClearSource", "bitcoinRetrySource",
  "bitcoinReconfigureSource", "bitcoinReceiveAddress", "bitcoinRefresh", "walletReceiveToken", "walletInspectCashu",
  "walletExport", "walletBackupReminder", "sendPayment", "requestPayment", "requestGroupPayment", "groupPaymentHello", "askToPay",
  "payRequest", "reclaimPayment", "disconnect", "addService", "removeService", "setServiceEnabled",
  "setServiceShared", "updateSettings", "setCallSignal", "setTyping", "setWakeSubscription", "setWakeMuted", "wakeForCall", "setCallOn", "wakeConfirm", "setFastPoll", "createGroup", "inviteToGroup",
  "acceptGroupInvitation", "declineGroupInvitation", "enableGroupLink", "disableGroupLink", "joinGroupByLink",
  "sendGroupMessage", "pressButton", "groupMessages", "messagePage", "statusCardIndex", "groupTaken", "leaveGroup", "removeGroupMember", "makeGroupAdmin", "setGroupHub", "rotateGroup",
  "setGroupPicture", "renameGroup", "setGroupTyping", "forgetGroup", "setGroupManage",
  // One profile on several devices (WISP 06): a CLI profile is always on one device, so these answer `single` or refuse.
  "deviceEnrollInvite", "deviceEnrollConfirm", "deviceEnrollCancel", "deviceEnrollView", "deviceEnrollJoin", "deviceEnrollReady", "deviceEnrollFinish",
  "deviceEnrollRemove", "deviceSet", "devicePing", "deviceHandoffVerifier", "deviceHandoffPush", "deviceHandoffPull", "deviceHandoffAccept",
  "deviceHandoffSettle", "deviceHandoffCancel", "deviceHandoffView", "deviceHandoffAllow", "deviceTakeoverInfo", "deviceTakeover", "deviceTurnPeek", "deviceForkDiscard", "deviceRestoreStartOwn",
  "deviceRemove", "deviceNewSecret", "deviceSecretOfferDismiss", "deviceSetNoticeSeen", "deviceTurnCheck", "devicePushState", "devicePushSet",
];

/** Reads the hosts use outside `EngineApi`: the whole state, and one chat's stored messages. */
export const ENGINE_READS: readonly string[] = ["getState", "getMessages"];

/**
 * Calls whose answer holds a secret (chat seeds, wallet phrases and keys, ecash, backups): the CLI prints their
 * result only with `--show-secret`.
 */
export const SECRET_RESULTS: ReadonlySet<string> = new Set([
  "exportLinks", "takeInvite", "walletExport", "usdtReveal",
  "arkBackup", "barkBackup", "sparkBackup", "fedimintBackup",
  "usdtExportBackup", "arkExportBackup", "barkExportBackup", "sparkExportBackup", "fedimintExportBackup",
  "fedimintSpendNotes",
]);
