/**
 * The engine's calls the daemon passes through as `engine.<method>` (WISP 11xx § Local control API): exactly the
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
  "loadPublicGraph", "loadPublicPostImage", "setDidListed", "nostrLoadContact", "nostrForgetContact", "nostrLoadOwn",
  "nostrLookup", "nostrDraft", "nostrPublish", "createLink", "takeInvite", "joinLink", "ensureLink", "confirmPair",
  "pollNow", "removeLink", "renameLink", "setActiveLink", "sendMessage", "editMessage", "retryMessage", "react", "messageDetails",
  "deleteMessage", "exportLinks", "sendFile", "forwardMessages", "fileAction", "setDeliveryMode", "setTransportPreference",
  "setChatTransport", "setChatPaymentMethods", "setChatHold", "connect", "walletAddMint", "walletCreate",
  "walletRemove", "walletTestCoins", "wake", "peekProfile", "walletSetPrimaryMint", "walletRemoveMint", "walletReceiveLightning",
  "walletQuoteInvoice", "walletPayQuote", "lnurlResolve", "lnurlInvoice", "checkPayment", "lightningSetSource",
  "lightningClearSource", "lightningRetrySource", "lightningReconfigureSource", "lightningRefresh",
  "lightningSetReceive", "lightningRename", "bitcoinSetSource", "bitcoinClearSource", "bitcoinRetrySource",
  "bitcoinReconfigureSource", "bitcoinReceiveAddress", "bitcoinRefresh", "walletReceiveToken", "walletInspectCashu",
  "walletExport", "sendPayment", "requestPayment", "requestGroupPayment", "groupPaymentHello", "askToPay",
  "payRequest", "reclaimPayment", "disconnect", "addService", "removeService", "setServiceEnabled",
  "setServiceShared", "updateSettings", "setCallSignal", "setTyping", "setWakeSubscription", "setWakeMuted", "wakeForCall", "setFastPoll", "createGroup", "inviteToGroup",
  "acceptGroupInvitation", "declineGroupInvitation", "enableGroupLink", "disableGroupLink", "joinGroupByLink",
  "sendGroupMessage", "groupMessages", "groupTaken", "leaveGroup", "removeGroupMember", "makeGroupAdmin", "setGroupHub", "rotateGroup",
  "setGroupPicture", "forgetGroup",
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
