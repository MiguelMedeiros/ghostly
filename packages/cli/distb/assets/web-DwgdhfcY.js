//#region ../../node_modules/@breeztech/breez-sdk-spark/web/breez_sdk_spark_wasm.js
/**
* Rust-built implementation of the JS `BitcoinChainService` interface.
*
* Returned by factories like [`new_rest_chain_service`]; users see it as a
* `BitcoinChainService` and pass it to `withChainService`. Pass the same
* instance to multiple `SdkBuilder`s to share a single underlying HTTP
* client (and its connection pool) across SDK instances.
*/
var BitcoinChainServiceHandle = class BitcoinChainServiceHandle {
	static __wrap(ptr) {
		const obj = Object.create(BitcoinChainServiceHandle.prototype);
		obj.__wbg_ptr = ptr;
		BitcoinChainServiceHandleFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		BitcoinChainServiceHandleFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_bitcoinchainservicehandle_free(ptr, 0);
	}
	/**
	* @param {string} tx
	* @returns {Promise<void>}
	*/
	broadcastTransaction(tx) {
		const ptr0 = passStringToWasm0(tx, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.bitcoinchainservicehandle_broadcastTransaction(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* @param {string} address
	* @returns {Promise<any>}
	*/
	getAddressTxos(address) {
		const ptr0 = passStringToWasm0(address, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.bitcoinchainservicehandle_getAddressTxos(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* @param {string} address
	* @returns {Promise<any>}
	*/
	getAddressUtxos(address) {
		const ptr0 = passStringToWasm0(address, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.bitcoinchainservicehandle_getAddressUtxos(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* @param {string} txid
	* @param {number} vout
	* @returns {Promise<any>}
	*/
	getOutspend(txid, vout) {
		const ptr0 = passStringToWasm0(txid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.bitcoinchainservicehandle_getOutspend(this.__wbg_ptr, ptr0, len0, vout);
	}
	/**
	* @param {string} txid
	* @returns {Promise<any>}
	*/
	getTransactionHex(txid) {
		const ptr0 = passStringToWasm0(txid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.bitcoinchainservicehandle_getTransactionHex(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* @param {string} txid
	* @returns {Promise<any>}
	*/
	getTransactionStatus(txid) {
		const ptr0 = passStringToWasm0(txid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.bitcoinchainservicehandle_getTransactionStatus(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* @returns {Promise<any>}
	*/
	recommendedFees() {
		return wasm.bitcoinchainservicehandle_recommendedFees(this.__wbg_ptr);
	}
	/**
	* @returns {Promise<any>}
	*/
	tipHeight() {
		return wasm.bitcoinchainservicehandle_tipHeight(this.__wbg_ptr);
	}
};
if (Symbol.dispose) BitcoinChainServiceHandle.prototype[Symbol.dispose] = BitcoinChainServiceHandle.prototype.free;
var BreezSdk = class BreezSdk {
	static __wrap(ptr) {
		const obj = Object.create(BreezSdk.prototype);
		obj.__wbg_ptr = ptr;
		BreezSdkFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		BreezSdkFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_breezsdk_free(ptr, 0);
	}
	/**
	* @param {AddContactRequest} request
	* @returns {Promise<Contact>}
	*/
	addContact(request) {
		return wasm.breezsdk_addContact(this.__wbg_ptr, request);
	}
	/**
	* @param {EventListener} listener
	* @returns {Promise<string>}
	*/
	addEventListener(listener) {
		return wasm.breezsdk_addEventListener(this.__wbg_ptr, listener);
	}
	/**
	* @param {AuthorizeTransferRequest} request
	* @returns {Promise<TransferAuthorization>}
	*/
	authorizeLightningAddressTransfer(request) {
		return wasm.breezsdk_authorizeLightningAddressTransfer(this.__wbg_ptr, request);
	}
	/**
	* @param {BuildUnsignedBatchPackageRequest} request
	* @returns {Promise<UnsignedTransferPackage>}
	*/
	buildUnsignedBatchPackage(request) {
		return wasm.breezsdk_buildUnsignedBatchPackage(this.__wbg_ptr, request);
	}
	/**
	* @param {BuildUnsignedLnurlPayPackageRequest} request
	* @returns {Promise<UnsignedTransferPackage>}
	*/
	buildUnsignedLnurlPayPackage(request) {
		return wasm.breezsdk_buildUnsignedLnurlPayPackage(this.__wbg_ptr, request);
	}
	/**
	* @param {BuildUnsignedTransferPackageRequest} request
	* @returns {Promise<UnsignedTransferPackage>}
	*/
	buildUnsignedTransferPackage(request) {
		return wasm.breezsdk_buildUnsignedTransferPackage(this.__wbg_ptr, request);
	}
	/**
	* @param {BuyBitcoinRequest} request
	* @returns {Promise<BuyBitcoinResponse>}
	*/
	buyBitcoin(request) {
		return wasm.breezsdk_buyBitcoin(this.__wbg_ptr, request);
	}
	/**
	* @param {CheckLightningAddressRequest} request
	* @returns {Promise<boolean>}
	*/
	checkLightningAddressAvailable(request) {
		return wasm.breezsdk_checkLightningAddressAvailable(this.__wbg_ptr, request);
	}
	/**
	* @param {CheckMessageRequest} request
	* @returns {Promise<CheckMessageResponse>}
	*/
	checkMessage(request) {
		return wasm.breezsdk_checkMessage(this.__wbg_ptr, request);
	}
	/**
	* @param {CheckUnilateralExitRequest} request
	* @returns {Promise<CheckUnilateralExitResponse>}
	*/
	checkUnilateralExit(request) {
		return wasm.breezsdk_checkUnilateralExit(this.__wbg_ptr, request);
	}
	/**
	* @param {ClaimDepositRequest} request
	* @returns {Promise<ClaimDepositResponse>}
	*/
	claimDeposit(request) {
		return wasm.breezsdk_claimDeposit(this.__wbg_ptr, request);
	}
	/**
	* @param {ClaimHtlcPaymentRequest} request
	* @returns {Promise<ClaimHtlcPaymentResponse>}
	*/
	claimHtlcPayment(request) {
		return wasm.breezsdk_claimHtlcPayment(this.__wbg_ptr, request);
	}
	/**
	* @param {ClaimTransferRequest} request
	* @returns {Promise<LightningAddressInfo>}
	*/
	claimLightningAddressTransfer(request) {
		return wasm.breezsdk_claimLightningAddressTransfer(this.__wbg_ptr, request);
	}
	/**
	* @param {string} id
	* @returns {Promise<void>}
	*/
	deleteContact(id) {
		const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.breezsdk_deleteContact(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* @returns {Promise<void>}
	*/
	deleteLightningAddress() {
		return wasm.breezsdk_deleteLightningAddress(this.__wbg_ptr);
	}
	/**
	* @returns {Promise<void>}
	*/
	disconnect() {
		return wasm.breezsdk_disconnect(this.__wbg_ptr);
	}
	/**
	* @returns {Promise<ExportUnilateralExitStateResponse>}
	*/
	exportUnilateralExitState() {
		return wasm.breezsdk_exportUnilateralExitState(this.__wbg_ptr);
	}
	/**
	* @param {FetchClaimDepositQuoteRequest} request
	* @returns {Promise<FetchClaimDepositQuoteResponse>}
	*/
	fetchClaimDepositQuote(request) {
		return wasm.breezsdk_fetchClaimDepositQuote(this.__wbg_ptr, request);
	}
	/**
	* @param {FetchConversionLimitsRequest} request
	* @returns {Promise<FetchConversionLimitsResponse>}
	*/
	fetchConversionLimits(request) {
		return wasm.breezsdk_fetchConversionLimits(this.__wbg_ptr, request);
	}
	/**
	* @param {CrossChainRouteFilter} filter
	* @returns {Promise<CrossChainRoutePair[]>}
	*/
	getCrossChainRoutes(filter) {
		return wasm.breezsdk_getCrossChainRoutes(this.__wbg_ptr, filter);
	}
	/**
	* @param {GetInfoRequest} request
	* @returns {Promise<GetInfoResponse>}
	*/
	getInfo(request) {
		return wasm.breezsdk_getInfo(this.__wbg_ptr, request);
	}
	/**
	* @returns {Promise<LightningAddressInfo | undefined>}
	*/
	getLightningAddress() {
		return wasm.breezsdk_getLightningAddress(this.__wbg_ptr);
	}
	/**
	* @param {GetPaymentRequest} request
	* @returns {Promise<GetPaymentResponse>}
	*/
	getPayment(request) {
		return wasm.breezsdk_getPayment(this.__wbg_ptr, request);
	}
	/**
	* @returns {TokenIssuer}
	*/
	getTokenIssuer() {
		const ret = wasm.breezsdk_getTokenIssuer(this.__wbg_ptr);
		return TokenIssuer.__wrap(ret);
	}
	/**
	* @param {GetTokensMetadataRequest} request
	* @returns {Promise<GetTokensMetadataResponse>}
	*/
	getTokensMetadata(request) {
		return wasm.breezsdk_getTokensMetadata(this.__wbg_ptr, request);
	}
	/**
	* @returns {Promise<UserSettings>}
	*/
	getUserSettings() {
		return wasm.breezsdk_getUserSettings(this.__wbg_ptr);
	}
	/**
	* @param {ImportUnilateralExitStateRequest} request
	* @returns {Promise<ImportUnilateralExitStateResponse>}
	*/
	importUnilateralExitState(request) {
		return wasm.breezsdk_importUnilateralExitState(this.__wbg_ptr, request);
	}
	/**
	* @param {ListContactsRequest} request
	* @returns {Promise<Contact[]>}
	*/
	listContacts(request) {
		return wasm.breezsdk_listContacts(this.__wbg_ptr, request);
	}
	/**
	* @returns {Promise<ListFiatCurrenciesResponse>}
	*/
	listFiatCurrencies() {
		return wasm.breezsdk_listFiatCurrencies(this.__wbg_ptr);
	}
	/**
	* @returns {Promise<ListFiatRatesResponse>}
	*/
	listFiatRates() {
		return wasm.breezsdk_listFiatRates(this.__wbg_ptr);
	}
	/**
	* @param {ListPaymentsRequest} request
	* @returns {Promise<ListPaymentsResponse>}
	*/
	listPayments(request) {
		return wasm.breezsdk_listPayments(this.__wbg_ptr, request);
	}
	/**
	* @param {ListUnclaimedDepositsRequest} request
	* @returns {Promise<ListUnclaimedDepositsResponse>}
	*/
	listUnclaimedDeposits(request) {
		return wasm.breezsdk_listUnclaimedDeposits(this.__wbg_ptr, request);
	}
	/**
	* @returns {Promise<Webhook[]>}
	*/
	listWebhooks() {
		return wasm.breezsdk_listWebhooks(this.__wbg_ptr);
	}
	/**
	* @param {LnurlAuthRequestDetails} request_data
	* @returns {Promise<LnurlCallbackStatus>}
	*/
	lnurlAuth(request_data) {
		return wasm.breezsdk_lnurlAuth(this.__wbg_ptr, request_data);
	}
	/**
	* @param {LnurlPayRequest} request
	* @returns {Promise<LnurlPayResponse>}
	*/
	lnurlPay(request) {
		return wasm.breezsdk_lnurlPay(this.__wbg_ptr, request);
	}
	/**
	* @param {LnurlWithdrawRequest} request
	* @returns {Promise<LnurlWithdrawResponse>}
	*/
	lnurlWithdraw(request) {
		return wasm.breezsdk_lnurlWithdraw(this.__wbg_ptr, request);
	}
	/**
	* @param {OptimizeLeavesRequest} request
	* @returns {Promise<OptimizeLeavesResponse>}
	*/
	optimizeLeaves(request) {
		return wasm.breezsdk_optimizeLeaves(this.__wbg_ptr, request);
	}
	/**
	* @param {string} input
	* @returns {Promise<InputType>}
	*/
	parse(input) {
		const ptr0 = passStringToWasm0(input, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.breezsdk_parse(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* @param {PrepareLnurlPayRequest} request
	* @returns {Promise<PrepareLnurlPayResponse>}
	*/
	prepareLnurlPay(request) {
		return wasm.breezsdk_prepareLnurlPay(this.__wbg_ptr, request);
	}
	/**
	* @param {PreparePaymentLinkRequest} request
	* @returns {Promise<PreparePaymentLinkResponse>}
	*/
	preparePaymentLink(request) {
		return wasm.breezsdk_preparePaymentLink(this.__wbg_ptr, request);
	}
	/**
	* @param {PrepareSendBatchRequest} request
	* @returns {Promise<PrepareSendBatchResponse>}
	*/
	prepareSendBatch(request) {
		return wasm.breezsdk_prepareSendBatch(this.__wbg_ptr, request);
	}
	/**
	* @param {PrepareSendPaymentRequest} request
	* @returns {Promise<PrepareSendPaymentResponse>}
	*/
	prepareSendPayment(request) {
		return wasm.breezsdk_prepareSendPayment(this.__wbg_ptr, request);
	}
	/**
	* @param {PrepareUnilateralExitRequest} request
	* @returns {Promise<PrepareUnilateralExitResponse>}
	*/
	prepareUnilateralExit(request) {
		return wasm.breezsdk_prepareUnilateralExit(this.__wbg_ptr, request);
	}
	/**
	* @param {PublishSignedLnurlPayPackageRequest} request
	* @returns {Promise<PublishSignedLnurlPayResponse>}
	*/
	publishSignedLnurlPayPackage(request) {
		return wasm.breezsdk_publishSignedLnurlPayPackage(this.__wbg_ptr, request);
	}
	/**
	* @param {PublishSignedTransferPackageRequest} request
	* @returns {Promise<PublishSignedTransferPackageResponse>}
	*/
	publishSignedTransferPackage(request) {
		return wasm.breezsdk_publishSignedTransferPackage(this.__wbg_ptr, request);
	}
	/**
	* @param {ReceivePaymentRequest} request
	* @returns {Promise<ReceivePaymentResponse>}
	*/
	receivePayment(request) {
		return wasm.breezsdk_receivePayment(this.__wbg_ptr, request);
	}
	/**
	* @returns {Promise<RecommendedFees>}
	*/
	recommendedFees() {
		return wasm.breezsdk_recommendedFees(this.__wbg_ptr);
	}
	/**
	* @param {RefundDepositRequest} request
	* @returns {Promise<RefundDepositResponse>}
	*/
	refundDeposit(request) {
		return wasm.breezsdk_refundDeposit(this.__wbg_ptr, request);
	}
	/**
	* @returns {Promise<RefundPendingConversionsResponse>}
	*/
	refundPendingConversions() {
		return wasm.breezsdk_refundPendingConversions(this.__wbg_ptr);
	}
	/**
	* @param {RegisterLightningAddressRequest} request
	* @returns {Promise<LightningAddressInfo>}
	*/
	registerLightningAddress(request) {
		return wasm.breezsdk_registerLightningAddress(this.__wbg_ptr, request);
	}
	/**
	* @param {RegisterWebhookRequest} request
	* @returns {Promise<RegisterWebhookResponse>}
	*/
	registerWebhook(request) {
		return wasm.breezsdk_registerWebhook(this.__wbg_ptr, request);
	}
	/**
	* @param {string} id
	* @returns {Promise<boolean>}
	*/
	removeEventListener(id) {
		const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.breezsdk_removeEventListener(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* @param {SendBatchRequest} request
	* @returns {Promise<SendBatchResponse>}
	*/
	sendBatch(request) {
		return wasm.breezsdk_sendBatch(this.__wbg_ptr, request);
	}
	/**
	* @param {SendPaymentRequest} request
	* @returns {Promise<SendPaymentResponse>}
	*/
	sendPayment(request) {
		return wasm.breezsdk_sendPayment(this.__wbg_ptr, request);
	}
	/**
	* @param {SignMessageRequest} request
	* @returns {Promise<SignMessageResponse>}
	*/
	signMessage(request) {
		return wasm.breezsdk_signMessage(this.__wbg_ptr, request);
	}
	/**
	* @param {SyncWalletRequest} request
	* @returns {Promise<SyncWalletResponse>}
	*/
	syncWallet(request) {
		return wasm.breezsdk_syncWallet(this.__wbg_ptr, request);
	}
	/**
	* @param {UnilateralExitRequest} request
	* @param {CpfpSigner} signer
	* @returns {Promise<UnilateralExitResponse>}
	*/
	unilateralExit(request, signer) {
		return wasm.breezsdk_unilateralExit(this.__wbg_ptr, request, signer);
	}
	/**
	* @param {UnregisterWebhookRequest} request
	* @returns {Promise<void>}
	*/
	unregisterWebhook(request) {
		return wasm.breezsdk_unregisterWebhook(this.__wbg_ptr, request);
	}
	/**
	* @param {UpdateContactRequest} request
	* @returns {Promise<Contact>}
	*/
	updateContact(request) {
		return wasm.breezsdk_updateContact(this.__wbg_ptr, request);
	}
	/**
	* @param {UpdateUserSettingsRequest} request
	* @returns {Promise<void>}
	*/
	updateUserSettings(request) {
		return wasm.breezsdk_updateUserSettings(this.__wbg_ptr, request);
	}
};
if (Symbol.dispose) BreezSdk.prototype[Symbol.dispose] = BreezSdk.prototype.free;
/**
* A CPFP signer matching the `CpfpSigner` TypeScript interface.
*/
var DefaultCpfpSigner = class DefaultCpfpSigner {
	static __wrap(ptr) {
		const obj = Object.create(DefaultCpfpSigner.prototype);
		obj.__wbg_ptr = ptr;
		DefaultCpfpSignerFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		DefaultCpfpSignerFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_defaultcpfpsigner_free(ptr, 0);
	}
	/**
	* @param {Uint8Array} psbt_bytes
	* @returns {Promise<Uint8Array>}
	*/
	signPsbt(psbt_bytes) {
		const ptr0 = passArray8ToWasm0(psbt_bytes, wasm.__wbindgen_malloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.defaultcpfpsigner_signPsbt(this.__wbg_ptr, ptr0, len0);
	}
};
if (Symbol.dispose) DefaultCpfpSigner.prototype[Symbol.dispose] = DefaultCpfpSigner.prototype.free;
/**
* A JS handle to a backend's own session store (from `defaultSessionStore`),
* exposing the same `getSession` / `setSession` interface. Wrap it in a JS
* `SessionStore` decorator and pass that to `SdkBuilder.withSessionStore` to
* transform tokens while keeping the backend's persistence: for example
* at-rest encryption, which the SDK does not apply itself.
*/
var DefaultSessionStore = class DefaultSessionStore {
	static __wrap(ptr) {
		const obj = Object.create(DefaultSessionStore.prototype);
		obj.__wbg_ptr = ptr;
		DefaultSessionStoreFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		DefaultSessionStoreFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_defaultsessionstore_free(ptr, 0);
	}
	/**
	* @param {string} service_identity_key
	* @returns {Promise<Session>}
	*/
	getSession(service_identity_key) {
		const ptr0 = passStringToWasm0(service_identity_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.defaultsessionstore_getSession(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* @param {string} service_identity_key
	* @param {Session} session
	* @returns {Promise<void>}
	*/
	setSession(service_identity_key, session) {
		const ptr0 = passStringToWasm0(service_identity_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.defaultsessionstore_setSession(this.__wbg_ptr, ptr0, len0, session);
	}
};
if (Symbol.dispose) DefaultSessionStore.prototype[Symbol.dispose] = DefaultSessionStore.prototype.free;
/**
* A Rust-backed [`ExternalBreezSigner`] surfaced to JS as a signer object that
* can be passed to `connectWithSigner` or `SdkBuilder.newWithSigner`. Produced
* by `defaultExternalSigners` (seed) and `createTurnkeySigner` (Turnkey).
*
* [`ExternalBreezSigner`]: breez_sdk_spark::signer::ExternalBreezSigner
*/
var ExternalBreezSignerHandle = class ExternalBreezSignerHandle {
	static __wrap(ptr) {
		const obj = Object.create(ExternalBreezSignerHandle.prototype);
		obj.__wbg_ptr = ptr;
		ExternalBreezSignerHandleFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		ExternalBreezSignerHandleFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_externalbreezsignerhandle_free(ptr, 0);
	}
	/**
	* @param {Uint8Array} message
	* @param {string} path
	* @returns {Promise<Uint8Array>}
	*/
	decryptEcies(message, path) {
		const ptr0 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
		const len0 = WASM_VECTOR_LEN;
		const ptr1 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len1 = WASM_VECTOR_LEN;
		return wasm.externalbreezsignerhandle_decryptEcies(this.__wbg_ptr, ptr0, len0, ptr1, len1);
	}
	/**
	* @param {string} path
	* @returns {Promise<PublicKeyBytes>}
	*/
	derivePublicKey(path) {
		const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.externalbreezsignerhandle_derivePublicKey(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* @param {Uint8Array} message
	* @param {string} path
	* @returns {Promise<Uint8Array>}
	*/
	encryptEcies(message, path) {
		const ptr0 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
		const len0 = WASM_VECTOR_LEN;
		const ptr1 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len1 = WASM_VECTOR_LEN;
		return wasm.externalbreezsignerhandle_encryptEcies(this.__wbg_ptr, ptr0, len0, ptr1, len1);
	}
	/**
	* @param {Uint8Array} message
	* @param {string} path
	* @returns {Promise<HashedMessageBytes>}
	*/
	hmacSha256(message, path) {
		const ptr0 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
		const len0 = WASM_VECTOR_LEN;
		const ptr1 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len1 = WASM_VECTOR_LEN;
		return wasm.externalbreezsignerhandle_hmacSha256(this.__wbg_ptr, ptr0, len0, ptr1, len1);
	}
	/**
	* @param {MessageBytes} message
	* @param {string} path
	* @returns {Promise<EcdsaSignatureBytes>}
	*/
	signEcdsa(message, path) {
		const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.externalbreezsignerhandle_signEcdsa(this.__wbg_ptr, message, ptr0, len0);
	}
	/**
	* @param {MessageBytes} message
	* @param {string} path
	* @returns {Promise<RecoverableEcdsaSignatureBytes>}
	*/
	signEcdsaRecoverable(message, path) {
		const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.externalbreezsignerhandle_signEcdsaRecoverable(this.__wbg_ptr, message, ptr0, len0);
	}
	/**
	* @param {Uint8Array} hash
	* @param {string} path
	* @returns {Promise<SchnorrSignatureBytes>}
	*/
	signHashSchnorr(hash, path) {
		const ptr0 = passArray8ToWasm0(hash, wasm.__wbindgen_malloc);
		const len0 = WASM_VECTOR_LEN;
		const ptr1 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len1 = WASM_VECTOR_LEN;
		return wasm.externalbreezsignerhandle_signHashSchnorr(this.__wbg_ptr, ptr0, len0, ptr1, len1);
	}
};
if (Symbol.dispose) ExternalBreezSignerHandle.prototype[Symbol.dispose] = ExternalBreezSignerHandle.prototype.free;
/**
* The two external signers for the SDK's signer-based connect. Returned by
* `defaultExternalSigners` (seed) and `createTurnkeySigner` (Turnkey); pass
* both halves to `connectWithSigner` or `SdkBuilder.newWithSigner`.
*/
var ExternalSigners = class ExternalSigners {
	static __wrap(ptr) {
		const obj = Object.create(ExternalSigners.prototype);
		obj.__wbg_ptr = ptr;
		ExternalSignersFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		ExternalSignersFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_externalsigners_free(ptr, 0);
	}
	/**
	* External signer for non-Spark SDK signing (LNURL-auth, sync, message
	* signing, ECIES).
	* @returns {ExternalBreezSignerHandle}
	*/
	get breezSigner() {
		const ret = wasm.externalsigners_breezSigner(this.__wbg_ptr);
		return ExternalBreezSignerHandle.__wrap(ret);
	}
	/**
	* External high-level Spark signer for the Spark wallet flows.
	* @returns {ExternalSparkSignerHandle}
	*/
	get sparkSigner() {
		const ret = wasm.externalsigners_sparkSigner(this.__wbg_ptr);
		return ExternalSparkSignerHandle.__wrap(ret);
	}
};
if (Symbol.dispose) ExternalSigners.prototype[Symbol.dispose] = ExternalSigners.prototype.free;
/**
* A Rust-backed [`ExternalSigningSigner`] surfaced to JS as a signer object
* that can be passed to `connectWithSigningOnlySigner` or
* `SdkBuilder.newWithSigningOnlySigner`. Produced by
* `createTurnkeySigningOnlySigner`.
*
* [`ExternalSigningSigner`]: breez_sdk_spark::signer::ExternalSigningSigner
*/
var ExternalSigningSignerHandle = class ExternalSigningSignerHandle {
	static __wrap(ptr) {
		const obj = Object.create(ExternalSigningSignerHandle.prototype);
		obj.__wbg_ptr = ptr;
		ExternalSigningSignerHandleFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		ExternalSigningSignerHandleFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_externalsigningsignerhandle_free(ptr, 0);
	}
	/**
	* @param {string} path
	* @returns {Promise<PublicKeyBytes>}
	*/
	derivePublicKey(path) {
		const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.externalsigningsignerhandle_derivePublicKey(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* @param {MessageBytes} message
	* @param {string} path
	* @returns {Promise<EcdsaSignatureBytes>}
	*/
	signEcdsa(message, path) {
		const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.externalsigningsignerhandle_signEcdsa(this.__wbg_ptr, message, ptr0, len0);
	}
	/**
	* @param {MessageBytes} message
	* @param {string} path
	* @returns {Promise<RecoverableEcdsaSignatureBytes>}
	*/
	signEcdsaRecoverable(message, path) {
		const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.externalsigningsignerhandle_signEcdsaRecoverable(this.__wbg_ptr, message, ptr0, len0);
	}
	/**
	* @param {Uint8Array} hash
	* @param {string} path
	* @returns {Promise<SchnorrSignatureBytes>}
	*/
	signHashSchnorr(hash, path) {
		const ptr0 = passArray8ToWasm0(hash, wasm.__wbindgen_malloc);
		const len0 = WASM_VECTOR_LEN;
		const ptr1 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len1 = WASM_VECTOR_LEN;
		return wasm.externalsigningsignerhandle_signHashSchnorr(this.__wbg_ptr, ptr0, len0, ptr1, len1);
	}
};
if (Symbol.dispose) ExternalSigningSignerHandle.prototype[Symbol.dispose] = ExternalSigningSignerHandle.prototype.free;
/**
* A Rust-backed [`ExternalSparkSigner`] surfaced to JS as a signer object that
* can be passed to `connectWithSigner` or `SdkBuilder.newWithSigner`. Produced
* by `defaultExternalSigners` (seed) and `createTurnkeySigner` (Turnkey).
*
* [`ExternalSparkSigner`]: breez_sdk_spark::signer::ExternalSparkSigner
*/
var ExternalSparkSignerHandle = class ExternalSparkSignerHandle {
	static __wrap(ptr) {
		const obj = Object.create(ExternalSparkSignerHandle.prototype);
		obj.__wbg_ptr = ptr;
		ExternalSparkSignerHandleFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		ExternalSparkSignerHandleFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_externalsparksignerhandle_free(ptr, 0);
	}
	/**
	* @returns {Promise<PublicKeyBytes>}
	*/
	getIdentityPublicKey() {
		return wasm.externalsparksignerhandle_getIdentityPublicKey(this.__wbg_ptr);
	}
	/**
	* @param {ExternalTreeNodeId} leaf_id
	* @returns {Promise<PublicKeyBytes>}
	*/
	getPublicKeyForLeaf(leaf_id) {
		return wasm.externalsparksignerhandle_getPublicKeyForLeaf(this.__wbg_ptr, leaf_id);
	}
	/**
	* @param {number} index
	* @returns {Promise<PublicKeyBytes>}
	*/
	getStaticDepositPublicKey(index) {
		return wasm.externalsparksignerhandle_getStaticDepositPublicKey(this.__wbg_ptr, index);
	}
	/**
	* @param {ExternalPrepareClaimRequest} request
	* @returns {Promise<ExternalPreparedClaim>}
	*/
	prepareClaim(request) {
		return wasm.externalsparksignerhandle_prepareClaim(this.__wbg_ptr, request);
	}
	/**
	* @param {ExternalPrepareLightningReceiveRequest} request
	* @returns {Promise<ExternalPreparedLightningReceive>}
	*/
	prepareLightningReceive(request) {
		return wasm.externalsparksignerhandle_prepareLightningReceive(this.__wbg_ptr, request);
	}
	/**
	* @param {ExternalPrepareStaticDepositRequest} request
	* @returns {Promise<ExternalPreparedStaticDeposit>}
	*/
	prepareStaticDeposit(request) {
		return wasm.externalsparksignerhandle_prepareStaticDeposit(this.__wbg_ptr, request);
	}
	/**
	* @param {ExternalPrepareStaticDepositClaimRequest} request
	* @returns {Promise<ExternalPreparedStaticDepositClaim>}
	*/
	prepareStaticDepositClaim(request) {
		return wasm.externalsparksignerhandle_prepareStaticDepositClaim(this.__wbg_ptr, request);
	}
	/**
	* @param {ExternalPrepareTokenTransactionRequest} request
	* @returns {Promise<ExternalPreparedTokenTransaction>}
	*/
	prepareTokenTransaction(request) {
		return wasm.externalsparksignerhandle_prepareTokenTransaction(this.__wbg_ptr, request);
	}
	/**
	* @param {ExternalPrepareTransferRequest} request
	* @returns {Promise<ExternalPreparedTransfer>}
	*/
	prepareTransfer(request) {
		return wasm.externalsparksignerhandle_prepareTransfer(this.__wbg_ptr, request);
	}
	/**
	* @param {Uint8Array} challenge
	* @returns {Promise<EcdsaSignatureBytes>}
	*/
	signAuthenticationChallenge(challenge) {
		const ptr0 = passArray8ToWasm0(challenge, wasm.__wbindgen_malloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.externalsparksignerhandle_signAuthenticationChallenge(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* @param {ExternalFrostJob[]} jobs
	* @returns {Promise<ExternalFrostShareResult[]>}
	*/
	signFrost(jobs) {
		const ptr0 = passArrayJsValueToWasm0(jobs, wasm.__wbindgen_malloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.externalsparksignerhandle_signFrost(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* @param {ExternalTreeNodeId} leaf_id
	* @param {Uint8Array} sighash
	* @returns {Promise<SchnorrSignatureBytes>}
	*/
	signLeafRefundSpend(leaf_id, sighash) {
		const ptr0 = passArray8ToWasm0(sighash, wasm.__wbindgen_malloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.externalsparksignerhandle_signLeafRefundSpend(this.__wbg_ptr, leaf_id, ptr0, len0);
	}
	/**
	* @param {Uint8Array} message
	* @returns {Promise<EcdsaSignatureBytes>}
	*/
	signMessage(message) {
		const ptr0 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.externalsparksignerhandle_signMessage(this.__wbg_ptr, ptr0, len0);
	}
	/**
	* @param {ExternalSignSparkInvoiceRequest} request
	* @returns {Promise<ExternalSignedSparkInvoice>}
	*/
	signSparkInvoice(request) {
		return wasm.externalsparksignerhandle_signSparkInvoice(this.__wbg_ptr, request);
	}
	/**
	* @param {ExternalSignStaticDepositRefundRequest} request
	* @returns {Promise<ExternalFrostSignature>}
	*/
	signStaticDepositRefund(request) {
		return wasm.externalsparksignerhandle_signStaticDepositRefund(this.__wbg_ptr, request);
	}
	/**
	* @param {ExternalStartStaticDepositRefundRequest} request
	* @returns {Promise<ExternalStartedStaticDepositRefund>}
	*/
	startStaticDepositRefund(request) {
		return wasm.externalsparksignerhandle_startStaticDepositRefund(this.__wbg_ptr, request);
	}
};
if (Symbol.dispose) ExternalSparkSignerHandle.prototype[Symbol.dispose] = ExternalSparkSignerHandle.prototype.free;
var IntoUnderlyingByteSource = class {
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		IntoUnderlyingByteSourceFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_intounderlyingbytesource_free(ptr, 0);
	}
	/**
	* @returns {number}
	*/
	get autoAllocateChunkSize() {
		return wasm.intounderlyingbytesource_autoAllocateChunkSize(this.__wbg_ptr) >>> 0;
	}
	cancel() {
		const ptr = this.__destroy_into_raw();
		wasm.intounderlyingbytesource_cancel(ptr);
	}
	/**
	* @param {ReadableByteStreamController} controller
	* @returns {Promise<any>}
	*/
	pull(controller) {
		return wasm.intounderlyingbytesource_pull(this.__wbg_ptr, controller);
	}
	/**
	* @param {ReadableByteStreamController} controller
	*/
	start(controller) {
		wasm.intounderlyingbytesource_start(this.__wbg_ptr, controller);
	}
	/**
	* @returns {ReadableStreamType}
	*/
	get type() {
		return __wbindgen_enum_ReadableStreamType[wasm.intounderlyingbytesource_type(this.__wbg_ptr)];
	}
};
if (Symbol.dispose) IntoUnderlyingByteSource.prototype[Symbol.dispose] = IntoUnderlyingByteSource.prototype.free;
var IntoUnderlyingSink = class {
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		IntoUnderlyingSinkFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_intounderlyingsink_free(ptr, 0);
	}
	/**
	* @param {any} reason
	* @returns {Promise<any>}
	*/
	abort(reason) {
		const ptr = this.__destroy_into_raw();
		return wasm.intounderlyingsink_abort(ptr, reason);
	}
	/**
	* @returns {Promise<any>}
	*/
	close() {
		const ptr = this.__destroy_into_raw();
		return wasm.intounderlyingsink_close(ptr);
	}
	/**
	* @param {any} chunk
	* @returns {Promise<any>}
	*/
	write(chunk) {
		return wasm.intounderlyingsink_write(this.__wbg_ptr, chunk);
	}
};
if (Symbol.dispose) IntoUnderlyingSink.prototype[Symbol.dispose] = IntoUnderlyingSink.prototype.free;
var IntoUnderlyingSource = class {
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		IntoUnderlyingSourceFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_intounderlyingsource_free(ptr, 0);
	}
	cancel() {
		const ptr = this.__destroy_into_raw();
		wasm.intounderlyingsource_cancel(ptr);
	}
	/**
	* @param {ReadableStreamDefaultController} controller
	* @returns {Promise<any>}
	*/
	pull(controller) {
		return wasm.intounderlyingsource_pull(this.__wbg_ptr, controller);
	}
};
if (Symbol.dispose) IntoUnderlyingSource.prototype[Symbol.dispose] = IntoUnderlyingSource.prototype.free;
/**
* High-level orchestrator that collapses register / sign-in flows
* into single calls. See the matching Rust types for full semantics;
* the JS surface is a thin wasm-bindgen wrapper.
*/
var PasskeyClient = class {
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		PasskeyClientFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_passkeyclient_free(ptr, 0);
	}
	/**
	* One-shot capability probe (PRF support + domain association)
	* hosts can gate UX on.
	* @returns {Promise<PasskeyAvailability>}
	*/
	checkAvailability() {
		return wasm.passkeyclient_checkAvailability(this.__wbg_ptr);
	}
	/**
	* Single-CTA onboarding: silent sign-in that falls through to
	* registration when no credential exists on the device. Pins
	* immediate mediation, so on web only use it where the browser
	* advertises it (`supportsImmediateMediation`); otherwise the silent
	* probe degrades to the standard picker and a dismiss does not fall
	* through to register, so
	* present an explicit create / sign-in choice instead. Called without
	* a `label`, the response `labels` lists a returning user's wallets
	* for a picker.
	* @param {ConnectWithPasskeyRequest} request
	* @returns {Promise<ConnectWithPasskeyResponse>}
	*/
	connectWithPasskey(request) {
		return wasm.passkeyclient_connectWithPasskey(this.__wbg_ptr, request);
	}
	/**
	* Label sub-object. List / publish labels for this passkey's identity.
	* @returns {PasskeyLabels}
	*/
	labels() {
		const ret = wasm.passkeyclient_labels(this.__wbg_ptr);
		return PasskeyLabels.__wrap(ret);
	}
	/**
	* Create a `PasskeyClient` backed by the supplied `PrfProvider` and
	* the default Nostr-backed label store. `breezApiKey` enables
	* authenticated (NIP-42) relay access for label storage; omit for
	* public relays only.
	* @param {PrfProvider} prf_provider
	* @param {string | null} [breez_api_key]
	* @param {PasskeyConfig | null} [config]
	*/
	constructor(prf_provider, breez_api_key, config) {
		var ptr0 = isLikeNone(breez_api_key) ? 0 : passStringToWasm0(breez_api_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		var len0 = WASM_VECTOR_LEN;
		const ret = wasm.passkeyclient_new(prf_provider, ptr0, len0, isLikeNone(config) ? 0 : addToExternrefTable0(config));
		if (ret[2]) throw takeFromExternrefTable0(ret[1]);
		this.__wbg_ptr = ret[0];
		PasskeyClientFinalization.register(this, this.__wbg_ptr, this);
		return this;
	}
	/**
	* First-time setup. Drives the platform's create-passkey ceremony
	* then derives the wallet seed in the same PRF assertion ceremony
	* where the platform supports it.
	* @param {RegisterRequest} request
	* @returns {Promise<RegisterResponse>}
	*/
	register(request) {
		return wasm.passkeyclient_register(this.__wbg_ptr, request);
	}
	/**
	* Returning-user sign-in. With `label` set, uses the fast path
	* (one ceremony, no Nostr round-trip). With `label` omitted,
	* derives the default-label wallet and discovers the user's
	* label set in the same ceremony.
	* @param {SignInRequest} request
	* @returns {Promise<SignInResponse>}
	*/
	signIn(request) {
		return wasm.passkeyclient_signIn(this.__wbg_ptr, request);
	}
	/**
	* Whether this browser advertises WebAuthn immediate mediation: the
	* silent single-CTA probe (a no-credential sign-in fast-fails with no
	* UI) works here, so a web host can pick single- vs two-button
	* onboarding. Web-only and WASM-only: native does the silent probe
	* inherently, so there is nothing to query off-web.
	* @returns {Promise<boolean>}
	*/
	supportsImmediateMediation() {
		return wasm.passkeyclient_supportsImmediateMediation(this.__wbg_ptr);
	}
};
if (Symbol.dispose) PasskeyClient.prototype[Symbol.dispose] = PasskeyClient.prototype.free;
/**
* Label sub-object surfaced from `PasskeyClient.labels()`.
*/
var PasskeyLabels = class PasskeyLabels {
	static __wrap(ptr) {
		const obj = Object.create(PasskeyLabels.prototype);
		obj.__wbg_ptr = ptr;
		PasskeyLabelsFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		PasskeyLabelsFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_passkeylabels_free(ptr, 0);
	}
	/**
	* List labels published for this passkey's identity.
	* @returns {Promise<string[]>}
	*/
	list() {
		return wasm.passkeylabels_list(this.__wbg_ptr);
	}
	/**
	* Idempotently publish `label` for this passkey's identity.
	* @param {string} label
	* @returns {Promise<void>}
	*/
	store(label) {
		const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.passkeylabels_store(this.__wbg_ptr, ptr0, len0);
	}
};
if (Symbol.dispose) PasskeyLabels.prototype[Symbol.dispose] = PasskeyLabels.prototype.free;
var SdkBuilder = class SdkBuilder {
	static __wrap(ptr) {
		const obj = Object.create(SdkBuilder.prototype);
		obj.__wbg_ptr = ptr;
		SdkBuilderFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		SdkBuilderFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_sdkbuilder_free(ptr, 0);
	}
	/**
	* @returns {Promise<BreezSdk>}
	*/
	build() {
		const ptr = this.__destroy_into_raw();
		return wasm.sdkbuilder_build(ptr);
	}
	/**
	* @param {Config} config
	* @param {Seed} seed
	* @returns {SdkBuilder}
	*/
	static new(config, seed) {
		const ret = wasm.sdkbuilder_new(config, seed);
		return SdkBuilder.__wrap(ret);
	}
	/**
	* @param {Config} config
	* @param {ExternalBreezSigner} breez_signer
	* @param {ExternalSparkSigner} spark_signer
	* @returns {SdkBuilder}
	*/
	static newWithSigner(config, breez_signer, spark_signer) {
		const ret = wasm.sdkbuilder_newWithSigner(config, breez_signer, spark_signer);
		return SdkBuilder.__wrap(ret);
	}
	/**
	* Creates a new `SdkBuilder` with a signing-only external signer, for a
	* signer that can't perform the SDK's local ECIES/HMAC operations. The SDK
	* keeps session tokens in plaintext and disables the features that rely on
	* ECIES/HMAC.
	* @param {Config} config
	* @param {ExternalSigningSigner} breez_signer
	* @param {ExternalSparkSigner} spark_signer
	* @returns {SdkBuilder}
	*/
	static newWithSigningOnlySigner(config, breez_signer, spark_signer) {
		const ret = wasm.sdkbuilder_newWithSigningOnlySigner(config, breez_signer, spark_signer);
		return SdkBuilder.__wrap(ret);
	}
	/**
	* @param {number} account_number
	* @returns {SdkBuilder}
	*/
	withAccountNumber(account_number) {
		const ptr = this.__destroy_into_raw();
		const ret = wasm.sdkbuilder_withAccountNumber(ptr, account_number);
		return SdkBuilder.__wrap(ret);
	}
	/**
	* @param {BitcoinChainService} chain_service
	* @returns {SdkBuilder}
	*/
	withChainService(chain_service) {
		const ptr = this.__destroy_into_raw();
		const ret = wasm.sdkbuilder_withChainService(ptr, chain_service);
		return SdkBuilder.__wrap(ret);
	}
	/**
	* @param {string} storage_dir
	* @returns {Promise<SdkBuilder>}
	*/
	withDefaultStorage(storage_dir) {
		const ptr = this.__destroy_into_raw();
		const ptr0 = passStringToWasm0(storage_dir, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		return wasm.sdkbuilder_withDefaultStorage(ptr, ptr0, len0);
	}
	/**
	* @param {FiatService} fiat_service
	* @returns {SdkBuilder}
	*/
	withFiatService(fiat_service) {
		const ptr = this.__destroy_into_raw();
		const ret = wasm.sdkbuilder_withFiatService(ptr, fiat_service);
		return SdkBuilder.__wrap(ret);
	}
	/**
	* @param {RestClient} lnurl_client
	* @returns {SdkBuilder}
	*/
	withLnurlClient(lnurl_client) {
		const ptr = this.__destroy_into_raw();
		const ret = wasm.sdkbuilder_withLnurlClient(ptr, lnurl_client);
		return SdkBuilder.__wrap(ret);
	}
	/**
	* **Deprecated.** Use `withStorageBackend(mysqlStorage(config))`.
	* @param {MysqlStorageConfig} config
	* @returns {SdkBuilder}
	*/
	withMysqlBackend(config) {
		const ptr = this.__destroy_into_raw();
		const ret = wasm.sdkbuilder_withMysqlBackend(ptr, config);
		if (ret[2]) throw takeFromExternrefTable0(ret[1]);
		return SdkBuilder.__wrap(ret[0]);
	}
	/**
	* @param {PaymentObserver} payment_observer
	* @returns {SdkBuilder}
	*/
	withPaymentObserver(payment_observer) {
		const ptr = this.__destroy_into_raw();
		const ret = wasm.sdkbuilder_withPaymentObserver(ptr, payment_observer);
		return SdkBuilder.__wrap(ret);
	}
	/**
	* **Deprecated.** Use `withStorageBackend(postgresStorage(config))`.
	* @param {PostgresStorageConfig} config
	* @returns {SdkBuilder}
	*/
	withPostgresBackend(config) {
		const ptr = this.__destroy_into_raw();
		const ret = wasm.sdkbuilder_withPostgresBackend(ptr, config);
		if (ret[2]) throw takeFromExternrefTable0(ret[1]);
		return SdkBuilder.__wrap(ret[0]);
	}
	/**
	* @param {string} url
	* @param {ChainApiType} api_type
	* @param {Credentials | null} [credentials]
	* @returns {SdkBuilder}
	*/
	withRestChainService(url, api_type, credentials) {
		const ptr = this.__destroy_into_raw();
		const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
		const len0 = WASM_VECTOR_LEN;
		const ret = wasm.sdkbuilder_withRestChainService(ptr, ptr0, len0, api_type, isLikeNone(credentials) ? 0 : addToExternrefTable0(credentials));
		return SdkBuilder.__wrap(ret);
	}
	/**
	* Overrides the session store used to cache auth tokens, replacing the one
	* the backend provides. Pass any `SessionStore`: for example one that wraps
	* the backend's own store from `defaultSessionStore` to add at-rest
	* encryption, which the SDK does not apply itself.
	* @param {SessionStore} session_store
	* @returns {SdkBuilder}
	*/
	withSessionStore(session_store) {
		const ptr = this.__destroy_into_raw();
		const ret = wasm.sdkbuilder_withSessionStore(ptr, session_store);
		return SdkBuilder.__wrap(ret);
	}
	/**
	* Threads a shared [`WasmSdkContext`] into the builder.
	*
	* Construct the context once via `newSharedSdkContext` and pass the same
	* handle to every `SdkBuilder` whose SDKs should share its resources
	* (operator gRPC channels, SSP HTTP client, database pool).
	* @param {WasmSdkContext} context
	* @returns {SdkBuilder}
	*/
	withSharedContext(context) {
		const ptr = this.__destroy_into_raw();
		_assertClass(context, WasmSdkContext);
		const ret = wasm.sdkbuilder_withSharedContext(ptr, context.__wbg_ptr);
		return SdkBuilder.__wrap(ret);
	}
	/**
	* @param {Storage} storage
	* @returns {SdkBuilder}
	*/
	withStorage(storage) {
		const ptr = this.__destroy_into_raw();
		const ret = wasm.sdkbuilder_withStorage(ptr, storage);
		return SdkBuilder.__wrap(ret);
	}
	/**
	* Sets one of the SDK's built-in storage backends.
	*
	* Construct the [`WasmStorageConfig`] via `defaultStorage`,
	* `postgresStorage` or `mysqlStorage`.
	* @param {WasmStorageConfig} config
	* @returns {SdkBuilder}
	*/
	withStorageBackend(config) {
		const ptr = this.__destroy_into_raw();
		_assertClass(config, WasmStorageConfig);
		var ptr0 = config.__destroy_into_raw();
		const ret = wasm.sdkbuilder_withStorageBackend(ptr, ptr0);
		return SdkBuilder.__wrap(ret);
	}
};
if (Symbol.dispose) SdkBuilder.prototype[Symbol.dispose] = SdkBuilder.prototype.free;
/**
* The signing-only external signers for the SDK's signer-based connect.
* Returned by `createTurnkeySigningOnlySigner`; pass both halves to
* `connectWithSigningOnlySigner` or `SdkBuilder.newWithSigningOnlySigner`.
*/
var SigningOnlyExternalSigners = class SigningOnlyExternalSigners {
	static __wrap(ptr) {
		const obj = Object.create(SigningOnlyExternalSigners.prototype);
		obj.__wbg_ptr = ptr;
		SigningOnlyExternalSignersFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		SigningOnlyExternalSignersFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_signingonlyexternalsigners_free(ptr, 0);
	}
	/**
	* Signing-only external signer for non-Spark SDK signing.
	* @returns {ExternalSigningSignerHandle}
	*/
	get breezSigner() {
		const ret = wasm.signingonlyexternalsigners_breezSigner(this.__wbg_ptr);
		return ExternalSigningSignerHandle.__wrap(ret);
	}
	/**
	* External high-level Spark signer for the Spark wallet flows.
	* @returns {ExternalSparkSignerHandle}
	*/
	get sparkSigner() {
		const ret = wasm.signingonlyexternalsigners_sparkSigner(this.__wbg_ptr);
		return ExternalSparkSignerHandle.__wrap(ret);
	}
};
if (Symbol.dispose) SigningOnlyExternalSigners.prototype[Symbol.dispose] = SigningOnlyExternalSigners.prototype.free;
var TokenIssuer = class TokenIssuer {
	static __wrap(ptr) {
		const obj = Object.create(TokenIssuer.prototype);
		obj.__wbg_ptr = ptr;
		TokenIssuerFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		TokenIssuerFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_tokenissuer_free(ptr, 0);
	}
	/**
	* @param {BurnIssuerTokenRequest} request
	* @returns {Promise<Payment>}
	*/
	burnIssuerToken(request) {
		return wasm.tokenissuer_burnIssuerToken(this.__wbg_ptr, request);
	}
	/**
	* @param {CreateIssuerTokenRequest} request
	* @returns {Promise<TokenMetadata>}
	*/
	createIssuerToken(request) {
		return wasm.tokenissuer_createIssuerToken(this.__wbg_ptr, request);
	}
	/**
	* @param {FreezeIssuerTokenRequest} request
	* @returns {Promise<FreezeIssuerTokenResponse>}
	*/
	freezeIssuerToken(request) {
		return wasm.tokenissuer_freezeIssuerToken(this.__wbg_ptr, request);
	}
	/**
	* @returns {Promise<TokenBalance>}
	*/
	getIssuerTokenBalance() {
		return wasm.tokenissuer_getIssuerTokenBalance(this.__wbg_ptr);
	}
	/**
	* @returns {Promise<TokenMetadata>}
	*/
	getIssuerTokenMetadata() {
		return wasm.tokenissuer_getIssuerTokenMetadata(this.__wbg_ptr);
	}
	/**
	* @param {MintIssuerTokenRequest} request
	* @returns {Promise<Payment>}
	*/
	mintIssuerToken(request) {
		return wasm.tokenissuer_mintIssuerToken(this.__wbg_ptr, request);
	}
	/**
	* @param {UnfreezeIssuerTokenRequest} request
	* @returns {Promise<UnfreezeIssuerTokenResponse>}
	*/
	unfreezeIssuerToken(request) {
		return wasm.tokenissuer_unfreezeIssuerToken(this.__wbg_ptr, request);
	}
};
if (Symbol.dispose) TokenIssuer.prototype[Symbol.dispose] = TokenIssuer.prototype.free;
/**
* Process-shared resources backing one or more `BreezSdk` instances on WASM.
*
* Construct once via `newSharedSdkContext` and pass the handle to every
* `SdkBuilder` whose SDKs should share its operator gRPC channels, SSP HTTP
* client, and (optionally) database connection pool.
*/
var WasmSdkContext = class WasmSdkContext {
	static __wrap(ptr) {
		const obj = Object.create(WasmSdkContext.prototype);
		obj.__wbg_ptr = ptr;
		WasmSdkContextFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		WasmSdkContextFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_wasmsdkcontext_free(ptr, 0);
	}
};
if (Symbol.dispose) WasmSdkContext.prototype[Symbol.dispose] = WasmSdkContext.prototype.free;
/**
* Selects one of the SDK's built-in storage backends.
*
* Construct it via `defaultStorage`, `postgresStorage` or `mysqlStorage` and
* pass it to `SdkBuilder.withStorageBackend`.
*/
var WasmStorageConfig = class WasmStorageConfig {
	static __wrap(ptr) {
		const obj = Object.create(WasmStorageConfig.prototype);
		obj.__wbg_ptr = ptr;
		WasmStorageConfigFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		WasmStorageConfigFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_wasmstorageconfig_free(ptr, 0);
	}
};
if (Symbol.dispose) WasmStorageConfig.prototype[Symbol.dispose] = WasmStorageConfig.prototype.free;
/**
* @param {ConnectRequest} request
* @returns {Promise<BreezSdk>}
*/
function connect(request) {
	return wasm.connect(request);
}
/**
* @param {Network} network
* @returns {Config}
*/
function defaultConfig(network) {
	return wasm.defaultConfig(network);
}
function __wbg_get_imports() {
	return {
		__proto__: null,
		"./breez_sdk_spark_wasm_bg.js": {
			__proto__: null,
			__wbg_BigInt_ae200e93cacbd2b3: function(arg0) {
				return BigInt(arg0);
			},
			__wbg_Error_3639a60ed15f87e7: function(arg0, arg1) {
				return Error(getStringFromWasm0(arg0, arg1));
			},
			__wbg_Number_a3d737fd183f7dca: function(arg0) {
				return Number(arg0);
			},
			__wbg_String_8564e559799eccda: function(arg0, arg1) {
				const ptr1 = passStringToWasm0(String(arg1), wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
				const len1 = WASM_VECTOR_LEN;
				getDataViewMemory0().setInt32(arg0 + 4, len1, true);
				getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
			},
			__wbg___wbindgen_bigint_get_as_i64_3af6d4ca77193a4b: function(arg0, arg1) {
				const v = arg1;
				const ret = typeof v === "bigint" ? v : void 0;
				getDataViewMemory0().setBigInt64(arg0 + 8, isLikeNone(ret) ? BigInt(0) : ret, true);
				getDataViewMemory0().setInt32(arg0 + 0, !isLikeNone(ret), true);
			},
			__wbg___wbindgen_boolean_get_c3dd5c39f1b5a12b: function(arg0) {
				const v = arg0;
				const ret = typeof v === "boolean" ? v : void 0;
				return isLikeNone(ret) ? 16777215 : ret ? 1 : 0;
			},
			__wbg___wbindgen_debug_string_07cb72cfcc952e2b: function(arg0, arg1) {
				const ptr1 = passStringToWasm0(debugString(arg1), wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
				const len1 = WASM_VECTOR_LEN;
				getDataViewMemory0().setInt32(arg0 + 4, len1, true);
				getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
			},
			__wbg___wbindgen_in_2617fa76397620d3: function(arg0, arg1) {
				return arg0 in arg1;
			},
			__wbg___wbindgen_is_bigint_d6a8167cac401b95: function(arg0) {
				return typeof arg0 === "bigint";
			},
			__wbg___wbindgen_is_function_2f0fd7ceb86e64c5: function(arg0) {
				return typeof arg0 === "function";
			},
			__wbg___wbindgen_is_null_066086be3abe9bb3: function(arg0) {
				return arg0 === null;
			},
			__wbg___wbindgen_is_object_5b22ff2418063a9c: function(arg0) {
				const val = arg0;
				return typeof val === "object" && val !== null;
			},
			__wbg___wbindgen_is_string_eddc07a3efad52e6: function(arg0) {
				return typeof arg0 === "string";
			},
			__wbg___wbindgen_is_undefined_244a92c34d3b6ec0: function(arg0) {
				return arg0 === void 0;
			},
			__wbg___wbindgen_jsval_eq_403eaa3610500a25: function(arg0, arg1) {
				return arg0 === arg1;
			},
			__wbg___wbindgen_jsval_loose_eq_1978f1e77b4bce62: function(arg0, arg1) {
				return arg0 == arg1;
			},
			__wbg___wbindgen_lt_c483cc694de67c3e: function(arg0, arg1) {
				return arg0 < arg1;
			},
			__wbg___wbindgen_neg_9b4d71823e3bc513: function(arg0) {
				return -arg0;
			},
			__wbg___wbindgen_number_get_dd6d69a6079f26f1: function(arg0, arg1) {
				const obj = arg1;
				const ret = typeof obj === "number" ? obj : void 0;
				getDataViewMemory0().setFloat64(arg0 + 8, isLikeNone(ret) ? 0 : ret, true);
				getDataViewMemory0().setInt32(arg0 + 0, !isLikeNone(ret), true);
			},
			__wbg___wbindgen_shr_d8f8268f18c7a1c3: function(arg0, arg1) {
				return arg0 >> arg1;
			},
			__wbg___wbindgen_string_get_965592073e5d848c: function(arg0, arg1) {
				const obj = arg1;
				const ret = typeof obj === "string" ? obj : void 0;
				var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
				var len1 = WASM_VECTOR_LEN;
				getDataViewMemory0().setInt32(arg0 + 4, len1, true);
				getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
			},
			__wbg___wbindgen_throw_9c75d47bf9e7731e: function(arg0, arg1) {
				throw new Error(getStringFromWasm0(arg0, arg1));
			},
			__wbg__wbg_cb_unref_158e43e869788cdc: function(arg0) {
				arg0._wbg_cb_unref();
			},
			__wbg_abort_43913e33ecb83d0d: function(arg0, arg1) {
				arg0.abort(arg1);
			},
			__wbg_abort_87eb7f23cf4b73d1: function(arg0) {
				arg0.abort();
			},
			__wbg_addDeposit_a506b5a5bf8c1cbc: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4, arg5) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.addDeposit(getStringFromWasm0(arg1, arg2), arg3 >>> 0, BigInt.asUintN(64, arg4), arg5 !== 0);
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_addLeaves_96b8c0f05f6b2a00: function() {
				return handleError(function(arg0, arg1) {
					return arg0.addLeaves(arg1);
				}, arguments);
			},
			__wbg_afterSend_465a6d26048f7342: function() {
				return handleError(function(arg0, arg1, arg2) {
					var v0 = getArrayJsValueFromWasm0(arg1, arg2).slice();
					wasm.__wbindgen_free(arg1, arg2 * 4, 4);
					return arg0.afterSend(v0);
				}, arguments);
			},
			__wbg_append_8df396311184f750: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					arg0.append(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
				}, arguments);
			},
			__wbg_applyPaymentUpdate_8526d773e5ac8314: function() {
				return handleError(function(arg0, arg1) {
					return arg0.applyPaymentUpdate(arg1);
				}, arguments);
			},
			__wbg_beforeSend_e8a50acd6afd73ed: function() {
				return handleError(function(arg0, arg1, arg2) {
					var v0 = getArrayJsValueFromWasm0(arg1, arg2).slice();
					wasm.__wbindgen_free(arg1, arg2 * 4, 4);
					return arg0.beforeSend(v0);
				}, arguments);
			},
			__wbg_bitcoinchainservicehandle_new: function(arg0) {
				return BitcoinChainServiceHandle.__wrap(arg0);
			},
			__wbg_body_6929614c20dfa7b0: function(arg0) {
				const ret = arg0.body;
				return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
			},
			__wbg_breezsdk_new: function(arg0) {
				return BreezSdk.__wrap(arg0);
			},
			__wbg_broadcastTransaction_f298d093a11def5e: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.broadcastTransaction(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_buffer_9ee17426fe5a5d65: function(arg0) {
				return arg0.buffer;
			},
			__wbg_byobRequest_178b64c09a0bee03: function(arg0) {
				const ret = arg0.byobRequest;
				return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
			},
			__wbg_byteLength_1f57c71e64ee0180: function(arg0) {
				return arg0.byteLength;
			},
			__wbg_byteOffset_648d0af273024f3d: function(arg0) {
				return arg0.byteOffset;
			},
			__wbg_call_a41d6421b30a32c5: function() {
				return handleError(function(arg0, arg1, arg2) {
					return arg0.call(arg1, arg2);
				}, arguments);
			},
			__wbg_call_add9e5a76382e668: function() {
				return handleError(function(arg0, arg1) {
					return arg0.call(arg1);
				}, arguments);
			},
			__wbg_cancelReservation_d3cadf13ef3b466b: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.cancelReservation(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_cancelReservation_fdc08ad6bfe4ea81: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.cancelReservation(getStringFromWasm0(arg1, arg2), arg3);
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_cancel_f97a3ee5a8b30eef: function(arg0) {
				return arg0.cancel();
			},
			__wbg_catch_f939343cb181958c: function(arg0, arg1) {
				return arg0.catch(arg1);
			},
			__wbg_clearTimeout_113b1cde814ec762: function(arg0) {
				return clearTimeout(arg0);
			},
			__wbg_clearTimeout_6b8d9a38b9263d65: function(arg0) {
				return clearTimeout(arg0);
			},
			__wbg_close_63e009c5a75f5597: function() {
				return handleError(function(arg0) {
					arg0.close();
				}, arguments);
			},
			__wbg_close_931d0c62e2aab92c: function() {
				return handleError(function(arg0) {
					arg0.close();
				}, arguments);
			},
			__wbg_close_de471367367aa5cb: function() {
				return handleError(function(arg0) {
					arg0.close();
				}, arguments);
			},
			__wbg_code_be6f339819ebb2c4: function(arg0) {
				return arg0.code;
			},
			__wbg_code_f1d2ddc1fbbb5aad: function(arg0) {
				return arg0.code;
			},
			__wbg_createDefaultStorage_0d66fd24fb8cc6f3: function() {
				return handleError(function(arg0, arg1, arg2) {
					return createDefaultStorage(getStringFromWasm0(arg0, arg1), arg2);
				}, arguments);
			},
			__wbg_createDefaultTreeStore_231e13cea886fab8: function() {
				return handleError(function(arg0, arg1, arg2) {
					return createDefaultTreeStore(getStringFromWasm0(arg0, arg1), arg2);
				}, arguments);
			},
			__wbg_createMysqlPool_8927bff3a28fcef9: function() {
				return handleError(function(arg0) {
					return createMysqlPool(arg0);
				}, arguments);
			},
			__wbg_createMysqlSessionStoreWithPool_52192c9b2932ff7c: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					return createMysqlSessionStoreWithPool(arg0, getArrayU8FromWasm0(arg1, arg2), arg3, arg4 !== 0);
				}, arguments);
			},
			__wbg_createMysqlStorageWithPool_22d23b0d068eae47: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					return createMysqlStorageWithPool(arg0, getArrayU8FromWasm0(arg1, arg2), arg3, arg4 !== 0);
				}, arguments);
			},
			__wbg_createMysqlTokenStoreWithPool_f59d99943757f602: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4, arg5) {
					return createMysqlTokenStoreWithPool(arg0, getArrayU8FromWasm0(arg1, arg2), arg3, arg4, arg5 !== 0);
				}, arguments);
			},
			__wbg_createMysqlTreeStoreWithPool_4c6bcff518c7f9c4: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4, arg5) {
					return createMysqlTreeStoreWithPool(arg0, getArrayU8FromWasm0(arg1, arg2), arg3, arg4, arg5 !== 0);
				}, arguments);
			},
			__wbg_createPasskey_37eb4d30fdaf2a3f: function() {
				return handleError(function(arg0, arg1, arg2) {
					return arg0.createPasskey(arg1, arg2);
				}, arguments);
			},
			__wbg_createPostgresPool_3c396c7ab2f0eab2: function() {
				return handleError(function(arg0) {
					return createPostgresPool(arg0);
				}, arguments);
			},
			__wbg_createPostgresSessionStoreWithPool_dd76c7c3517d7bd0: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					return createPostgresSessionStoreWithPool(arg0, getArrayU8FromWasm0(arg1, arg2), arg3, arg4 !== 0);
				}, arguments);
			},
			__wbg_createPostgresStorageWithPool_9408116e32ab58f8: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					return createPostgresStorageWithPool(arg0, getArrayU8FromWasm0(arg1, arg2), arg3, arg4 !== 0);
				}, arguments);
			},
			__wbg_createPostgresTokenStoreWithPool_5e936f3aa8bd424a: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					return createPostgresTokenStoreWithPool(arg0, getArrayU8FromWasm0(arg1, arg2), arg3, arg4 !== 0);
				}, arguments);
			},
			__wbg_createPostgresTreeStoreWithPool_03a03c4c0664703c: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					return createPostgresTreeStoreWithPool(arg0, getArrayU8FromWasm0(arg1, arg2), arg3, arg4 !== 0);
				}, arguments);
			},
			__wbg_crypto_38df2bab126b63dc: function(arg0) {
				return arg0.crypto;
			},
			__wbg_data_4a14fad4c5f216c4: function(arg0) {
				return arg0.data;
			},
			__wbg_decryptEcies_ebe426814020926b: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					let deferred1_0;
					let deferred1_1;
					try {
						var v0 = getArrayU8FromWasm0(arg1, arg2).slice();
						wasm.__wbindgen_free(arg1, arg2 * 1, 1);
						deferred1_0 = arg3;
						deferred1_1 = arg4;
						return arg0.decryptEcies(v0, getStringFromWasm0(arg3, arg4));
					} finally {
						wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
					}
				}, arguments);
			},
			__wbg_defaultsessionstore_new: function(arg0) {
				return DefaultSessionStore.__wrap(arg0);
			},
			__wbg_deleteCachedItem_b8fbe3ebea21ed7e: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.deleteCachedItem(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_deleteContact_415ef25ea1d91dff: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.deleteContact(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_deleteDeposit_f62650143b0453b9: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.deleteDeposit(getStringFromWasm0(arg1, arg2), arg3 >>> 0);
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_deleteRequest_597243024c6ce08c: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4, arg5) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						let v1;
						if (arg4 !== 0) {
							v1 = getStringFromWasm0(arg4, arg5).slice();
							wasm.__wbindgen_free(arg4, arg5 * 1, 1);
						}
						return arg0.deleteRequest(getStringFromWasm0(arg1, arg2), arg3, v1);
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_derivePublicKey_1bc53f60dc792488: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.derivePublicKey(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_derivePublicKey_db43f40bd54e092a: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.derivePublicKey(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_deriveSeeds_5c331613e2894c56: function() {
				return handleError(function(arg0, arg1, arg2) {
					return arg0.deriveSeeds(arg1, arg2);
				}, arguments);
			},
			__wbg_done_b1afd6201ac045e0: function(arg0) {
				return arg0.done;
			},
			__wbg_encryptEcies_6a990da1c19d1f7c: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					let deferred1_0;
					let deferred1_1;
					try {
						var v0 = getArrayU8FromWasm0(arg1, arg2).slice();
						wasm.__wbindgen_free(arg1, arg2 * 1, 1);
						deferred1_0 = arg3;
						deferred1_1 = arg4;
						return arg0.encryptEcies(v0, getStringFromWasm0(arg3, arg4));
					} finally {
						wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
					}
				}, arguments);
			},
			__wbg_enqueue_6c7cd543c0f3828e: function() {
				return handleError(function(arg0, arg1) {
					arg0.enqueue(arg1);
				}, arguments);
			},
			__wbg_entries_bb9843ba73dc70d6: function(arg0) {
				return Object.entries(arg0);
			},
			__wbg_error_145dadf4216d70bc: function(arg0, arg1) {
				console.error(getStringFromWasm0(arg0, arg1));
			},
			__wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
				let deferred0_0;
				let deferred0_1;
				try {
					deferred0_0 = arg0;
					deferred0_1 = arg1;
					console.error(getStringFromWasm0(arg0, arg1));
				} finally {
					wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
				}
			},
			__wbg_externalsigners_new: function(arg0) {
				return ExternalSigners.__wrap(arg0);
			},
			__wbg_fetchFiatCurrencies_8afa0468f01bf013: function() {
				return handleError(function(arg0) {
					return arg0.fetchFiatCurrencies();
				}, arguments);
			},
			__wbg_fetchFiatRates_89205e79f984cee8: function() {
				return handleError(function(arg0) {
					return arg0.fetchFiatRates();
				}, arguments);
			},
			__wbg_fetch_1a030943aa8e0c38: function(arg0, arg1) {
				return arg0.fetch(arg1);
			},
			__wbg_fetch_217f3dd51c581eee: function(arg0, arg1) {
				return fetch(arg0, arg1);
			},
			__wbg_fetch_9dad4fe911207b37: function(arg0) {
				return fetch(arg0);
			},
			__wbg_fetch_a851d393d6b4492c: function(arg0, arg1, arg2) {
				return arg0.fetch(arg1, arg2);
			},
			__wbg_finalizeReservation_10f99a20bf634639: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.finalizeReservation(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_finalizeReservation_aa324ddf4b195930: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.finalizeReservation(getStringFromWasm0(arg1, arg2), arg3);
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_from_ff141b1e4c69b979: function(arg0) {
				return Array.from(arg0);
			},
			__wbg_getAddressTxos_3ca1c4b39dd84911: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.getAddressTxos(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_getAddressUtxos_9526b6d8078b867e: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.getAddressUtxos(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_getAvailableBalance_6f4e670b89ade6d0: function() {
				return handleError(function(arg0) {
					return arg0.getAvailableBalance();
				}, arguments);
			},
			__wbg_getCachedItem_b89cba4db943ef67: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.getCachedItem(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_getContact_35b5c6f2fa25cf9e: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.getContact(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_getCrossChainSwap_e3b8fcf14d3d17ce: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					let deferred0_0;
					let deferred0_1;
					let deferred1_0;
					let deferred1_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						deferred1_0 = arg3;
						deferred1_1 = arg4;
						return arg0.getCrossChainSwap(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
						wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
					}
				}, arguments);
			},
			__wbg_getExitChains_a61db75ca1ab9009: function() {
				return handleError(function(arg0, arg1) {
					return arg0.getExitChains(arg1);
				}, arguments);
			},
			__wbg_getIdentityPublicKey_c6fcd87d66ed6927: function() {
				return handleError(function(arg0) {
					return arg0.getIdentityPublicKey();
				}, arguments);
			},
			__wbg_getLeaves_5259dc2b9de80ff0: function() {
				return handleError(function(arg0) {
					return arg0.getLeaves();
				}, arguments);
			},
			__wbg_getOutspend_4b3c117972515790: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.getOutspend(getStringFromWasm0(arg1, arg2), arg3 >>> 0);
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_getPaymentById_6d677ada5879df99: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.getPaymentById(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_getPaymentByInvoice_82ae971724979f3a: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.getPaymentByInvoice(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_getPaymentsByParentIds_7ab066452766ae6d: function() {
				return handleError(function(arg0, arg1, arg2) {
					var v0 = getArrayJsValueFromWasm0(arg1, arg2).slice();
					wasm.__wbindgen_free(arg1, arg2 * 4, 4);
					return arg0.getPaymentsByParentIds(v0);
				}, arguments);
			},
			__wbg_getPublicKeyForLeaf_9826724c9b0c3963: function() {
				return handleError(function(arg0, arg1) {
					return arg0.getPublicKeyForLeaf(arg1);
				}, arguments);
			},
			__wbg_getRandomValues_c44a50d8cfdaebeb: function() {
				return handleError(function(arg0, arg1) {
					arg0.getRandomValues(arg1);
				}, arguments);
			},
			__wbg_getRandomValues_ef12552bf5acd2fe: function() {
				return handleError(function(arg0, arg1) {
					globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
				}, arguments);
			},
			__wbg_getReader_b4b1868fbca77dbe: function() {
				return handleError(function(arg0) {
					return arg0.getReader();
				}, arguments);
			},
			__wbg_getRequest_9153d27d6c51b5c7: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.getRequest(getStringFromWasm0(arg1, arg2), arg3);
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_getSession_95998cc236a30653: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.getSession(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_getStaticDepositPublicKey_9c7c893612c4c53f: function() {
				return handleError(function(arg0, arg1) {
					return arg0.getStaticDepositPublicKey(arg1 >>> 0);
				}, arguments);
			},
			__wbg_getTokenBalances_b788cda26e92f342: function() {
				return handleError(function(arg0) {
					return arg0.getTokenBalances();
				}, arguments);
			},
			__wbg_getTokenOutputs_f30e221535c83db6: function() {
				return handleError(function(arg0, arg1) {
					return arg0.getTokenOutputs(arg1);
				}, arguments);
			},
			__wbg_getTransactionHex_c65f4b9ee4eb9b96: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.getTransactionHex(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_getTransactionStatus_32c49e1985e35d63: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.getTransactionStatus(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_getVerifiedLeafKeys_12405bb5f39ffb61: function() {
				return handleError(function(arg0) {
					return arg0.getVerifiedLeafKeys();
				}, arguments);
			},
			__wbg_get_41476db20fef99a8: function() {
				return handleError(function(arg0, arg1) {
					return Reflect.get(arg0, arg1);
				}, arguments);
			},
			__wbg_get_652f640b3b0b6e3e: function(arg0, arg1) {
				return arg0[arg1 >>> 0];
			},
			__wbg_get_9cfea9b7bbf12a15: function() {
				return handleError(function(arg0, arg1) {
					return Reflect.get(arg0, arg1);
				}, arguments);
			},
			__wbg_get_done_2088079830fb242e: function(arg0) {
				const ret = arg0.done;
				return isLikeNone(ret) ? 16777215 : ret ? 1 : 0;
			},
			__wbg_get_unchecked_be562b1421656321: function(arg0, arg1) {
				return arg0[arg1 >>> 0];
			},
			__wbg_get_value_52f4b39f58a812ed: function(arg0) {
				return arg0.value;
			},
			__wbg_get_with_ref_key_6412cf3094599694: function(arg0, arg1) {
				return arg0[arg1];
			},
			__wbg_has_3a6f31f647e0ba22: function() {
				return handleError(function(arg0, arg1) {
					return Reflect.has(arg0, arg1);
				}, arguments);
			},
			__wbg_headers_de17f740bce997ae: function(arg0) {
				return arg0.headers;
			},
			__wbg_hmacSha256_04164bea6bd3c7d4: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					let deferred1_0;
					let deferred1_1;
					try {
						var v0 = getArrayU8FromWasm0(arg1, arg2).slice();
						wasm.__wbindgen_free(arg1, arg2 * 1, 1);
						deferred1_0 = arg3;
						deferred1_1 = arg4;
						return arg0.hmacSha256(v0, getStringFromWasm0(arg3, arg4));
					} finally {
						wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
					}
				}, arguments);
			},
			__wbg_insertContact_cc39397cb8e88ff8: function() {
				return handleError(function(arg0, arg1) {
					return arg0.insertContact(arg1);
				}, arguments);
			},
			__wbg_insertPaymentMetadata_0ce664b21d71c9f8: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.insertPaymentMetadata(getStringFromWasm0(arg1, arg2), arg3);
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_instanceof_ArrayBuffer_eab9f28fbec23477: function(arg0) {
				let result;
				try {
					result = arg0 instanceof ArrayBuffer;
				} catch (_) {
					result = false;
				}
				return result;
			},
			__wbg_instanceof_Blob_03470b25075ee8f1: function(arg0) {
				let result;
				try {
					result = arg0 instanceof Blob;
				} catch (_) {
					result = false;
				}
				return result;
			},
			__wbg_instanceof_DomException_47098be3333e16f8: function(arg0) {
				let result;
				try {
					result = arg0 instanceof DOMException;
				} catch (_) {
					result = false;
				}
				return result;
			},
			__wbg_instanceof_Error_5e21755e9d9cbee5: function(arg0) {
				let result;
				try {
					result = arg0 instanceof Error;
				} catch (_) {
					result = false;
				}
				return result;
			},
			__wbg_instanceof_Map_10d4edf60fcf9327: function(arg0) {
				let result;
				try {
					result = arg0 instanceof Map;
				} catch (_) {
					result = false;
				}
				return result;
			},
			__wbg_instanceof_Object_af9351f8f1c6f0c4: function(arg0) {
				let result;
				try {
					result = arg0 instanceof Object;
				} catch (_) {
					result = false;
				}
				return result;
			},
			__wbg_instanceof_Response_370b83aa6c17e88a: function(arg0) {
				let result;
				try {
					result = arg0 instanceof Response;
				} catch (_) {
					result = false;
				}
				return result;
			},
			__wbg_instanceof_Uint8Array_57d77acd50e4c44d: function(arg0) {
				let result;
				try {
					result = arg0 instanceof Uint8Array;
				} catch (_) {
					result = false;
				}
				return result;
			},
			__wbg_isArray_c6c6ef8308995bcf: function(arg0) {
				return Array.isArray(arg0);
			},
			__wbg_isSafeInteger_3c56c421a5b4cce4: function(arg0) {
				return Number.isSafeInteger(arg0);
			},
			__wbg_isSupported_0fab0220495a1089: function() {
				return handleError(function(arg0) {
					return arg0.isSupported();
				}, arguments);
			},
			__wbg_iterator_9d68985a1d096fc2: function() {
				return Symbol.iterator;
			},
			__wbg_leavesMissingExitChains_f49172139683e37b: function() {
				return handleError(function(arg0) {
					return arg0.leavesMissingExitChains();
				}, arguments);
			},
			__wbg_length_0a6ce016dc1460b0: function(arg0) {
				return arg0.length;
			},
			__wbg_length_ba3c032602efe310: function(arg0) {
				return arg0.length;
			},
			__wbg_listActiveCrossChainSwaps_7339427675c1ddec: function() {
				return handleError(function(arg0, arg1, arg2) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.listActiveCrossChainSwaps(getStringFromWasm0(arg1, arg2));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_listContacts_0afeb7e9554fdb74: function() {
				return handleError(function(arg0, arg1) {
					return arg0.listContacts(arg1);
				}, arguments);
			},
			__wbg_listDeposits_c2241448716e0b2b: function() {
				return handleError(function(arg0) {
					return arg0.listDeposits();
				}, arguments);
			},
			__wbg_listPayments_c1aab8442a6e2fe9: function() {
				return handleError(function(arg0, arg1) {
					return arg0.listPayments(arg1);
				}, arguments);
			},
			__wbg_listTokensOutputs_3fecc3251ae7b71c: function() {
				return handleError(function(arg0) {
					return arg0.listTokensOutputs();
				}, arguments);
			},
			__wbg_listWatchedDepositAddresses_55fe8af0643e3ea9: function() {
				return handleError(function(arg0) {
					return arg0.listWatchedDepositAddresses();
				}, arguments);
			},
			__wbg_log_cf86719f8acabfda: function(arg0, arg1) {
				arg0.log(arg1);
			},
			__wbg_message_609b498da776cb30: function(arg0, arg1) {
				const ret = arg1.message;
				const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
				const len1 = WASM_VECTOR_LEN;
				getDataViewMemory0().setInt32(arg0 + 4, len1, true);
				getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
			},
			__wbg_message_d5628ca19de920d3: function(arg0) {
				return arg0.message;
			},
			__wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
				return arg0.msCrypto;
			},
			__wbg_name_bf92195f4668ab6e: function(arg0) {
				return arg0.name;
			},
			__wbg_name_f19fb17a86413602: function(arg0, arg1) {
				const ret = arg1.name;
				const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
				const len1 = WASM_VECTOR_LEN;
				getDataViewMemory0().setInt32(arg0 + 4, len1, true);
				getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
			},
			__wbg_new_18865c63fa645c6f: function() {
				return handleError(function() {
					return new Headers();
				}, arguments);
			},
			__wbg_new_227d7c05414eb861: function() {
				return /* @__PURE__ */ new Error();
			},
			__wbg_new_2fad8ca02fd00684: function() {
				return /* @__PURE__ */ new Object();
			},
			__wbg_new_3baa8d9866155c79: function() {
				return new Array();
			},
			__wbg_new_46ae4e4ff2a07a64: function() {
				return /* @__PURE__ */ new Map();
			},
			__wbg_new_51ff470dc2f61e27: function() {
				return handleError(function() {
					return new AbortController();
				}, arguments);
			},
			__wbg_new_71b820e9c1f9ee88: function() {
				return handleError(function(arg0, arg1) {
					return new WebSocket(getStringFromWasm0(arg0, arg1));
				}, arguments);
			},
			__wbg_new_8454eee672b2ba6e: function(arg0) {
				return new Uint8Array(arg0);
			},
			__wbg_new_c9ea13ea803a692e: function(arg0, arg1) {
				return new Error(getStringFromWasm0(arg0, arg1));
			},
			__wbg_new_eb8acd9352be84ba: function(arg0, arg1) {
				try {
					var state0 = {
						a: arg0,
						b: arg1
					};
					var cb0 = (arg0, arg1) => {
						const a = state0.a;
						state0.a = 0;
						try {
							return wasm_bindgen__convert__closures_____invoke__h41057d61edf43a32(a, state0.b, arg0, arg1);
						} finally {
							state0.a = a;
						}
					};
					return new Promise(cb0);
				} finally {
					state0.a = 0;
				}
			},
			__wbg_new_from_slice_5a173c243af2e823: function(arg0, arg1) {
				return new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
			},
			__wbg_new_typed_1137602701dc87d4: function(arg0, arg1) {
				try {
					var state0 = {
						a: arg0,
						b: arg1
					};
					var cb0 = (arg0, arg1) => {
						const a = state0.a;
						state0.a = 0;
						try {
							return wasm_bindgen__convert__closures_____invoke__h41057d61edf43a32(a, state0.b, arg0, arg1);
						} finally {
							state0.a = a;
						}
					};
					return new Promise(cb0);
				} finally {
					state0.a = 0;
				}
			},
			__wbg_new_with_byte_offset_and_length_643e5e9e2fb6b1ad: function(arg0, arg1, arg2) {
				return new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
			},
			__wbg_new_with_length_9011f5da794bf5d9: function(arg0) {
				return new Uint8Array(arg0 >>> 0);
			},
			__wbg_new_with_str_and_init_da311e12114f4d1e: function() {
				return handleError(function(arg0, arg1, arg2) {
					return new Request(getStringFromWasm0(arg0, arg1), arg2);
				}, arguments);
			},
			__wbg_next_261c3c48c6e309a5: function(arg0) {
				return arg0.next;
			},
			__wbg_next_aacee310bcfe6461: function() {
				return handleError(function(arg0) {
					return arg0.next();
				}, arguments);
			},
			__wbg_node_84ea875411254db1: function(arg0) {
				return arg0.node;
			},
			__wbg_now_0cce8c6798af1870: function() {
				return handleError(function() {
					return Date.now();
				}, arguments);
			},
			__wbg_now_4f457f10f864aec5: function() {
				return Date.now();
			},
			__wbg_now_e7c6795a7f81e10f: function(arg0) {
				return arg0.now();
			},
			__wbg_now_ea3e9aca8593610d: function() {
				return handleError(function(arg0) {
					return arg0.now();
				}, arguments);
			},
			__wbg_now_ee1e8589b4c39f9a: function() {
				return handleError(function(arg0) {
					return arg0.now();
				}, arguments);
			},
			__wbg_onEvent_a70e8ec272c69a3a: function(arg0, arg1) {
				arg0.onEvent(arg1);
			},
			__wbg_performance_3fcf6e32a7e1ed0a: function(arg0) {
				return arg0.performance;
			},
			__wbg_postMessage_ead2ef5ee8c7a94e: function() {
				return handleError(function(arg0, arg1) {
					arg0.postMessage(arg1);
				}, arguments);
			},
			__wbg_postRequest_b7e02f7ec4d8b99b: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4, arg5) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						let v1;
						if (arg4 !== 0) {
							v1 = getStringFromWasm0(arg4, arg5).slice();
							wasm.__wbindgen_free(arg4, arg5 * 1, 1);
						}
						return arg0.postRequest(getStringFromWasm0(arg1, arg2), arg3, v1);
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_prepareClaim_1286899715876e7d: function() {
				return handleError(function(arg0, arg1) {
					return arg0.prepareClaim(arg1);
				}, arguments);
			},
			__wbg_prepareLightningReceive_fe5b5a46a5d5d976: function() {
				return handleError(function(arg0, arg1) {
					return arg0.prepareLightningReceive(arg1);
				}, arguments);
			},
			__wbg_prepareStaticDepositClaim_2aac4f9634448525: function() {
				return handleError(function(arg0, arg1) {
					return arg0.prepareStaticDepositClaim(arg1);
				}, arguments);
			},
			__wbg_prepareStaticDeposit_66175a4078320749: function() {
				return handleError(function(arg0, arg1) {
					return arg0.prepareStaticDeposit(arg1);
				}, arguments);
			},
			__wbg_prepareTokenTransaction_d2e097f1363077c0: function() {
				return handleError(function(arg0, arg1) {
					return arg0.prepareTokenTransaction(arg1);
				}, arguments);
			},
			__wbg_prepareTransfer_f1fd01fccd18c85b: function() {
				return handleError(function(arg0, arg1) {
					return arg0.prepareTransfer(arg1);
				}, arguments);
			},
			__wbg_process_44c7a14e11e9f69e: function(arg0) {
				return arg0.process;
			},
			__wbg_prototypesetcall_fd4050e806e1d519: function(arg0, arg1, arg2) {
				Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
			},
			__wbg_push_60a5366c0bb22a7d: function(arg0, arg1) {
				return arg0.push(arg1);
			},
			__wbg_queueMicrotask_40ac6ffc2848ba77: function(arg0) {
				queueMicrotask(arg0);
			},
			__wbg_queueMicrotask_74d092439f6494c1: function(arg0) {
				return arg0.queueMicrotask;
			},
			__wbg_randomFillSync_6c25eac9869eb53c: function() {
				return handleError(function(arg0, arg1) {
					arg0.randomFillSync(arg1);
				}, arguments);
			},
			__wbg_read_ac2e4325f1799cbe: function(arg0) {
				return arg0.read();
			},
			__wbg_readyState_be3cc9403da6c6ae: function(arg0) {
				return arg0.readyState;
			},
			__wbg_reason_fe958bcb63725f3b: function(arg0, arg1) {
				const ret = arg1.reason;
				const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
				const len1 = WASM_VECTOR_LEN;
				getDataViewMemory0().setInt32(arg0 + 4, len1, true);
				getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
			},
			__wbg_recommendedFees_eee625cd978e070a: function() {
				return handleError(function(arg0) {
					return arg0.recommendedFees();
				}, arguments);
			},
			__wbg_releaseLock_9e0ebc0b5270a358: function(arg0) {
				arg0.releaseLock();
			},
			__wbg_require_b4edbdcf3e2a1ef0: function() {
				return handleError(function() {
					return module.require;
				}, arguments);
			},
			__wbg_reserveTokenOutputsByOutpoints_2b3aa01becdba378: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg2;
						deferred0_1 = arg3;
						return arg0.reserveTokenOutputsByOutpoints(arg1, getStringFromWasm0(arg2, arg3));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_reserveTokenOutputs_17ba3b5fcc91b000: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4, arg5) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg2;
						deferred0_1 = arg3;
						return arg0.reserveTokenOutputs(arg1, getStringFromWasm0(arg2, arg3), arg4, arg5);
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_resolve_9feb5d906ca62419: function(arg0) {
				return Promise.resolve(arg0);
			},
			__wbg_respond_e7e53102735b2ae2: function() {
				return handleError(function(arg0, arg1) {
					arg0.respond(arg1 >>> 0);
				}, arguments);
			},
			__wbg_sdkbuilder_new: function(arg0) {
				return SdkBuilder.__wrap(arg0);
			},
			__wbg_selectTokenOutputs_378aebd65f866d1b: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					return arg0.selectTokenOutputs(arg1, arg2, arg3);
				}, arguments);
			},
			__wbg_send_0edb796d05cd3239: function() {
				return handleError(function(arg0, arg1, arg2) {
					arg0.send(getStringFromWasm0(arg1, arg2));
				}, arguments);
			},
			__wbg_send_c422d0aa0cb71d09: function() {
				return handleError(function(arg0, arg1, arg2) {
					arg0.send(getArrayU8FromWasm0(arg1, arg2));
				}, arguments);
			},
			__wbg_setCachedItem_a09dafdd0852fcb6: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					let deferred0_0;
					let deferred0_1;
					let deferred1_0;
					let deferred1_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						deferred1_0 = arg3;
						deferred1_1 = arg4;
						return arg0.setCachedItem(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
						wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
					}
				}, arguments);
			},
			__wbg_setCrossChainSwap_9047f4cc41fe2eca: function() {
				return handleError(function(arg0, arg1) {
					return arg0.setCrossChainSwap(arg1);
				}, arguments);
			},
			__wbg_setLeaves_3a013e3266762f4b: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					return arg0.setLeaves(arg1, arg2, arg3);
				}, arguments);
			},
			__wbg_setLnurlMetadata_084b50d8b878f93f: function() {
				return handleError(function(arg0, arg1, arg2) {
					var v0 = getArrayJsValueFromWasm0(arg1, arg2).slice();
					wasm.__wbindgen_free(arg1, arg2 * 4, 4);
					return arg0.setLnurlMetadata(v0);
				}, arguments);
			},
			__wbg_setSession_86d7fef1f452677c: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.setSession(getStringFromWasm0(arg1, arg2), arg3);
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_setTimeout_631eb4eafbc308a9: function(arg0, arg1) {
				globalThis.setTimeout(arg0, arg1);
			},
			__wbg_setTimeout_ef24d2fc3ad97385: function() {
				return handleError(function(arg0, arg1) {
					return setTimeout(arg0, arg1);
				}, arguments);
			},
			__wbg_setTimeout_f757f00851f76c42: function(arg0, arg1) {
				return setTimeout(arg0, arg1);
			},
			__wbg_setTokensOutputs_dc61529ca8c6dbec: function() {
				return handleError(function(arg0, arg1, arg2) {
					return arg0.setTokensOutputs(arg1, arg2);
				}, arguments);
			},
			__wbg_set_5337f8ac82364a3f: function() {
				return handleError(function(arg0, arg1, arg2) {
					return Reflect.set(arg0, arg1, arg2);
				}, arguments);
			},
			__wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
				arg0[arg1] = arg2;
			},
			__wbg_set_82f7a370f604db70: function(arg0, arg1, arg2) {
				return arg0.set(arg1, arg2);
			},
			__wbg_set_b0d9dc239ecdb765: function(arg0, arg1, arg2) {
				arg0.set(getArrayU8FromWasm0(arg1, arg2));
			},
			__wbg_set_binaryType_8564bdba0fbec720: function(arg0, arg1) {
				arg0.binaryType = __wbindgen_enum_BinaryType[arg1];
			},
			__wbg_set_body_aaff4f5f9991f342: function(arg0, arg1) {
				arg0.body = arg1;
			},
			__wbg_set_cache_d1f2b7b4dfa39317: function(arg0, arg1) {
				arg0.cache = __wbindgen_enum_RequestCache[arg1];
			},
			__wbg_set_credentials_f31e4d30b974ce14: function(arg0, arg1) {
				arg0.credentials = __wbindgen_enum_RequestCredentials[arg1];
			},
			__wbg_set_f614f6a0608d1d1d: function(arg0, arg1, arg2) {
				arg0[arg1 >>> 0] = arg2;
			},
			__wbg_set_headers_ae96049ea40e9eef: function(arg0, arg1) {
				arg0.headers = arg1;
			},
			__wbg_set_integrity_e20206ae8869d3fd: function(arg0, arg1, arg2) {
				arg0.integrity = getStringFromWasm0(arg1, arg2);
			},
			__wbg_set_method_0eea8a5597775fa1: function(arg0, arg1, arg2) {
				arg0.method = getStringFromWasm0(arg1, arg2);
			},
			__wbg_set_mode_9fe47bff60a1580d: function(arg0, arg1) {
				arg0.mode = __wbindgen_enum_RequestMode[arg1];
			},
			__wbg_set_onclose_f756840519cd20b5: function(arg0, arg1) {
				arg0.onclose = arg1;
			},
			__wbg_set_onerror_02f33de339f1fa31: function(arg0, arg1) {
				arg0.onerror = arg1;
			},
			__wbg_set_onmessage_d2ff0c1d20584625: function(arg0, arg1) {
				arg0.onmessage = arg1;
			},
			__wbg_set_onopen_1da8a4f65e6180d2: function(arg0, arg1) {
				arg0.onopen = arg1;
			},
			__wbg_set_redirect_d59447760eb3129d: function(arg0, arg1) {
				arg0.redirect = __wbindgen_enum_RequestRedirect[arg1];
			},
			__wbg_set_referrer_d0e5dc091bbc9f75: function(arg0, arg1, arg2) {
				arg0.referrer = getStringFromWasm0(arg1, arg2);
			},
			__wbg_set_referrer_policy_5afdd37afd73c769: function(arg0, arg1) {
				arg0.referrerPolicy = __wbindgen_enum_ReferrerPolicy[arg1];
			},
			__wbg_set_signal_8c5cf4c3b27bd8a8: function(arg0, arg1) {
				arg0.signal = arg1;
			},
			__wbg_signAuthenticationChallenge_e2ea9cf87c76a6de: function() {
				return handleError(function(arg0, arg1, arg2) {
					var v0 = getArrayU8FromWasm0(arg1, arg2).slice();
					wasm.__wbindgen_free(arg1, arg2 * 1, 1);
					return arg0.signAuthenticationChallenge(v0);
				}, arguments);
			},
			__wbg_signEcdsaRecoverable_7a9da0490e388132: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg2;
						deferred0_1 = arg3;
						return arg0.signEcdsaRecoverable(arg1, getStringFromWasm0(arg2, arg3));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_signEcdsaRecoverable_978c5526e66a433b: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg2;
						deferred0_1 = arg3;
						return arg0.signEcdsaRecoverable(arg1, getStringFromWasm0(arg2, arg3));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_signEcdsa_1947a1a2c8f39a16: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg2;
						deferred0_1 = arg3;
						return arg0.signEcdsa(arg1, getStringFromWasm0(arg2, arg3));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_signEcdsa_89f0abf313463778: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg2;
						deferred0_1 = arg3;
						return arg0.signEcdsa(arg1, getStringFromWasm0(arg2, arg3));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_signFrost_08951e01d00d4b1c: function() {
				return handleError(function(arg0, arg1) {
					return arg0.signFrost(arg1);
				}, arguments);
			},
			__wbg_signHashSchnorr_881022637f4bf583: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					let deferred1_0;
					let deferred1_1;
					try {
						var v0 = getArrayU8FromWasm0(arg1, arg2).slice();
						wasm.__wbindgen_free(arg1, arg2 * 1, 1);
						deferred1_0 = arg3;
						deferred1_1 = arg4;
						return arg0.signHashSchnorr(v0, getStringFromWasm0(arg3, arg4));
					} finally {
						wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
					}
				}, arguments);
			},
			__wbg_signHashSchnorr_fc8afda9a7ee021a: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					let deferred1_0;
					let deferred1_1;
					try {
						var v0 = getArrayU8FromWasm0(arg1, arg2).slice();
						wasm.__wbindgen_free(arg1, arg2 * 1, 1);
						deferred1_0 = arg3;
						deferred1_1 = arg4;
						return arg0.signHashSchnorr(v0, getStringFromWasm0(arg3, arg4));
					} finally {
						wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
					}
				}, arguments);
			},
			__wbg_signLeafRefundSpend_dc0eea305a0dde9c: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					var v0 = getArrayU8FromWasm0(arg2, arg3).slice();
					wasm.__wbindgen_free(arg2, arg3 * 1, 1);
					return arg0.signLeafRefundSpend(arg1, v0);
				}, arguments);
			},
			__wbg_signMessage_80ec0b0dfc7f00ee: function() {
				return handleError(function(arg0, arg1, arg2) {
					var v0 = getArrayU8FromWasm0(arg1, arg2).slice();
					wasm.__wbindgen_free(arg1, arg2 * 1, 1);
					return arg0.signMessage(v0);
				}, arguments);
			},
			__wbg_signPsbt_625c8cbdec488cc6: function() {
				return handleError(function(arg0, arg1, arg2) {
					var v0 = getArrayU8FromWasm0(arg1, arg2).slice();
					wasm.__wbindgen_free(arg1, arg2 * 1, 1);
					return arg0.signPsbt(v0);
				}, arguments);
			},
			__wbg_signSparkInvoice_cca6c7f35b5e85d2: function() {
				return handleError(function(arg0, arg1) {
					return arg0.signSparkInvoice(arg1);
				}, arguments);
			},
			__wbg_signStaticDepositRefund_3a6fb4e71a15bebd: function() {
				return handleError(function(arg0, arg1) {
					return arg0.signStaticDepositRefund(arg1);
				}, arguments);
			},
			__wbg_signal_4643ce883b92b553: function(arg0) {
				return arg0.signal;
			},
			__wbg_signingonlyexternalsigners_new: function(arg0) {
				return SigningOnlyExternalSigners.__wrap(arg0);
			},
			__wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
				const ret = arg1.stack;
				const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
				const len1 = WASM_VECTOR_LEN;
				getDataViewMemory0().setInt32(arg0 + 4, len1, true);
				getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
			},
			__wbg_startStaticDepositRefund_5b591bbea22aa0d2: function() {
				return handleError(function(arg0, arg1) {
					return arg0.startStaticDepositRefund(arg1);
				}, arguments);
			},
			__wbg_static_accessor_GLOBAL_THIS_1c7f1bd6c6941fdb: function() {
				const ret = typeof globalThis === "undefined" ? null : globalThis;
				return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
			},
			__wbg_static_accessor_GLOBAL_e039bc914f83e74e: function() {
				const ret = typeof global === "undefined" ? null : global;
				return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
			},
			__wbg_static_accessor_SELF_8bf8c48c28420ad5: function() {
				const ret = typeof self === "undefined" ? null : self;
				return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
			},
			__wbg_static_accessor_WINDOW_6aeee9b51652ee0f: function() {
				const ret = typeof window === "undefined" ? null : window;
				return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
			},
			__wbg_status_157e67ab07d01f8a: function(arg0) {
				return arg0.status;
			},
			__wbg_storeAncestors_4977efb1f53b8d99: function() {
				return handleError(function(arg0, arg1) {
					return arg0.storeAncestors(arg1);
				}, arguments);
			},
			__wbg_stringify_7fd5cae8859a6f10: function() {
				return handleError(function(arg0) {
					return JSON.stringify(arg0);
				}, arguments);
			},
			__wbg_subarray_fbe3cef290e1fa43: function(arg0, arg1, arg2) {
				return arg0.subarray(arg1 >>> 0, arg2 >>> 0);
			},
			__wbg_supportsImmediateMediation_a50b46b1cdfacd3d: function() {
				return handleError(function(arg0) {
					return arg0.supportsImmediateMediation();
				}, arguments);
			},
			__wbg_syncAddOutgoingChange_69db2a1430cbd55a: function() {
				return handleError(function(arg0, arg1) {
					return arg0.syncAddOutgoingChange(arg1);
				}, arguments);
			},
			__wbg_syncCompleteOutgoingSync_00c1d42ba5d7c93c: function() {
				return handleError(function(arg0, arg1, arg2) {
					return arg0.syncCompleteOutgoingSync(arg1, BigInt.asUintN(64, arg2));
				}, arguments);
			},
			__wbg_syncDeleteIncomingRecord_252fb75ae2bd4409: function() {
				return handleError(function(arg0, arg1) {
					return arg0.syncDeleteIncomingRecord(arg1);
				}, arguments);
			},
			__wbg_syncGetIncomingRecords_11f4eb6eba830ca1: function() {
				return handleError(function(arg0, arg1) {
					return arg0.syncGetIncomingRecords(arg1 >>> 0);
				}, arguments);
			},
			__wbg_syncGetLastRevision_f2613db6e3bc3fdb: function() {
				return handleError(function(arg0) {
					return arg0.syncGetLastRevision();
				}, arguments);
			},
			__wbg_syncGetLatestOutgoingChange_a0828a121ba8ef6a: function() {
				return handleError(function(arg0) {
					return arg0.syncGetLatestOutgoingChange();
				}, arguments);
			},
			__wbg_syncGetPendingOutgoingChanges_caff6e310e5774a0: function() {
				return handleError(function(arg0, arg1) {
					return arg0.syncGetPendingOutgoingChanges(arg1 >>> 0);
				}, arguments);
			},
			__wbg_syncInsertIncomingRecords_a606acc50dc8ccdb: function() {
				return handleError(function(arg0, arg1, arg2) {
					var v0 = getArrayJsValueFromWasm0(arg1, arg2).slice();
					wasm.__wbindgen_free(arg1, arg2 * 4, 4);
					return arg0.syncInsertIncomingRecords(v0);
				}, arguments);
			},
			__wbg_syncUpdateRecordFromIncoming_47caaa75be4d3a9a: function() {
				return handleError(function(arg0, arg1) {
					return arg0.syncUpdateRecordFromIncoming(arg1);
				}, arguments);
			},
			__wbg_then_20a157d939b514f5: function(arg0, arg1) {
				return arg0.then(arg1);
			},
			__wbg_then_5ef9b762bc91555c: function(arg0, arg1, arg2) {
				return arg0.then(arg1, arg2);
			},
			__wbg_tipHeight_e14ddf8ed9a68d5a: function() {
				return handleError(function(arg0) {
					return arg0.tipHeight();
				}, arguments);
			},
			__wbg_toString_15656af8d8e71f16: function(arg0, arg1, arg2) {
				const ptr1 = passStringToWasm0(arg1.toString(arg2), wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
				const len1 = WASM_VECTOR_LEN;
				getDataViewMemory0().setInt32(arg0 + 4, len1, true);
				getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
			},
			__wbg_toString_9ae74d2321992740: function(arg0) {
				return arg0.toString();
			},
			__wbg_tryReserveLeavesByIds_a6433e824993a82f: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg2;
						deferred0_1 = arg3;
						return arg0.tryReserveLeavesByIds(arg1, getStringFromWasm0(arg2, arg3));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_tryReserveLeaves_d2cd87cbc2a886d2: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg3;
						deferred0_1 = arg4;
						return arg0.tryReserveLeaves(arg1, arg2 !== 0, getStringFromWasm0(arg3, arg4));
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_trySelectLeaves_ff1aeb7ffc5e4e57: function() {
				return handleError(function(arg0, arg1) {
					return arg0.trySelectLeaves(arg1);
				}, arguments);
			},
			__wbg_updateDeposit_efb96cf6e6fbe7b7: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.updateDeposit(getStringFromWasm0(arg1, arg2), arg3 >>> 0, arg4);
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_updateReservation_8d9f42570704dca1: function() {
				return handleError(function(arg0, arg1, arg2, arg3, arg4) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.updateReservation(getStringFromWasm0(arg1, arg2), arg3, arg4);
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_updateTokenOutputs_d978e01c817e8230: function() {
				return handleError(function(arg0, arg1, arg2) {
					return arg0.updateTokenOutputs(arg1, arg2);
				}, arguments);
			},
			__wbg_updateWatchedDepositAddress_260322f77dee1443: function() {
				return handleError(function(arg0, arg1, arg2, arg3) {
					let deferred0_0;
					let deferred0_1;
					try {
						deferred0_0 = arg1;
						deferred0_1 = arg2;
						return arg0.updateWatchedDepositAddress(getStringFromWasm0(arg1, arg2), arg3);
					} finally {
						wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
					}
				}, arguments);
			},
			__wbg_url_68fd9a221360e0db: function(arg0, arg1) {
				const ret = arg1.url;
				const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
				const len1 = WASM_VECTOR_LEN;
				getDataViewMemory0().setInt32(arg0 + 4, len1, true);
				getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
			},
			__wbg_url_a0e994e7d0317efc: function(arg0, arg1) {
				const ret = arg1.url;
				const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
				const len1 = WASM_VECTOR_LEN;
				getDataViewMemory0().setInt32(arg0 + 4, len1, true);
				getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
			},
			__wbg_value_f852716acdeb3e82: function(arg0) {
				return arg0.value;
			},
			__wbg_versions_276b2795b1c6a219: function(arg0) {
				return arg0.versions;
			},
			__wbg_view_16bd97d49793e1a9: function(arg0) {
				const ret = arg0.view;
				return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
			},
			__wbg_wasClean_92b4133f985dfae0: function(arg0) {
				return arg0.wasClean;
			},
			__wbg_wasmsdkcontext_new: function(arg0) {
				return WasmSdkContext.__wrap(arg0);
			},
			__wbindgen_cast_0000000000000001: function(arg0, arg1) {
				return makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375);
			},
			__wbindgen_cast_0000000000000002: function(arg0, arg1) {
				return makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h3b28fbbc8b451a25);
			},
			__wbindgen_cast_0000000000000003: function(arg0, arg1) {
				return makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h3b28fbbc8b451a25_2);
			},
			__wbindgen_cast_0000000000000004: function(arg0, arg1) {
				return makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h3b28fbbc8b451a25_3);
			},
			__wbindgen_cast_0000000000000005: function(arg0, arg1) {
				return makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375_4);
			},
			__wbindgen_cast_0000000000000006: function(arg0, arg1) {
				return makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375_5);
			},
			__wbindgen_cast_0000000000000007: function(arg0, arg1) {
				return makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375_6);
			},
			__wbindgen_cast_0000000000000008: function(arg0, arg1) {
				return makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375_7);
			},
			__wbindgen_cast_0000000000000009: function(arg0, arg1) {
				return makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h484cd36e13f37bd7);
			},
			__wbindgen_cast_000000000000000a: function(arg0) {
				return arg0;
			},
			__wbindgen_cast_000000000000000b: function(arg0) {
				return arg0;
			},
			__wbindgen_cast_000000000000000c: function(arg0, arg1) {
				return getArrayU8FromWasm0(arg0, arg1);
			},
			__wbindgen_cast_000000000000000d: function(arg0, arg1) {
				return getStringFromWasm0(arg0, arg1);
			},
			__wbindgen_cast_000000000000000e: function(arg0, arg1) {
				return BigInt.asUintN(64, arg0) | BigInt.asUintN(64, arg1) << BigInt(64);
			},
			__wbindgen_cast_000000000000000f: function(arg0) {
				return BigInt.asUintN(64, arg0);
			},
			__wbindgen_cast_0000000000000010: function(arg0, arg1) {
				var v0 = getArrayJsValueFromWasm0(arg0, arg1).slice();
				wasm.__wbindgen_free(arg0, arg1 * 4, 4);
				return v0;
			},
			__wbindgen_cast_0000000000000011: function(arg0, arg1) {
				var v0 = getArrayJsValueFromWasm0(arg0, arg1).slice();
				wasm.__wbindgen_free(arg0, arg1 * 4, 4);
				return v0;
			},
			__wbindgen_cast_0000000000000012: function(arg0, arg1) {
				var v0 = getArrayJsValueFromWasm0(arg0, arg1).slice();
				wasm.__wbindgen_free(arg0, arg1 * 4, 4);
				return v0;
			},
			__wbindgen_cast_0000000000000013: function(arg0, arg1) {
				var v0 = getArrayJsValueFromWasm0(arg0, arg1).slice();
				wasm.__wbindgen_free(arg0, arg1 * 4, 4);
				return v0;
			},
			__wbindgen_cast_0000000000000014: function(arg0, arg1) {
				var v0 = getArrayJsValueFromWasm0(arg0, arg1).slice();
				wasm.__wbindgen_free(arg0, arg1 * 4, 4);
				return v0;
			},
			__wbindgen_cast_0000000000000015: function(arg0, arg1) {
				var v0 = getArrayU8FromWasm0(arg0, arg1).slice();
				wasm.__wbindgen_free(arg0, arg1 * 1, 1);
				return v0;
			},
			__wbindgen_init_externref_table: function() {
				const table = wasm.__wbindgen_externrefs;
				const offset = table.grow(4);
				table.set(0, void 0);
				table.set(offset + 0, void 0);
				table.set(offset + 1, null);
				table.set(offset + 2, true);
				table.set(offset + 3, false);
			}
		}
	};
}
function wasm_bindgen__convert__closures_____invoke__h484cd36e13f37bd7(arg0, arg1) {
	wasm.wasm_bindgen__convert__closures_____invoke__h484cd36e13f37bd7(arg0, arg1);
}
function wasm_bindgen__convert__closures_____invoke__h3b28fbbc8b451a25(arg0, arg1, arg2) {
	wasm.wasm_bindgen__convert__closures_____invoke__h3b28fbbc8b451a25(arg0, arg1, arg2);
}
function wasm_bindgen__convert__closures_____invoke__h3b28fbbc8b451a25_2(arg0, arg1, arg2) {
	wasm.wasm_bindgen__convert__closures_____invoke__h3b28fbbc8b451a25_2(arg0, arg1, arg2);
}
function wasm_bindgen__convert__closures_____invoke__h3b28fbbc8b451a25_3(arg0, arg1, arg2) {
	wasm.wasm_bindgen__convert__closures_____invoke__h3b28fbbc8b451a25_3(arg0, arg1, arg2);
}
function wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375(arg0, arg1, arg2) {
	const ret = wasm.wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375(arg0, arg1, arg2);
	if (ret[1]) throw takeFromExternrefTable0(ret[0]);
}
function wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375_4(arg0, arg1, arg2) {
	const ret = wasm.wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375_4(arg0, arg1, arg2);
	if (ret[1]) throw takeFromExternrefTable0(ret[0]);
}
function wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375_5(arg0, arg1, arg2) {
	const ret = wasm.wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375_5(arg0, arg1, arg2);
	if (ret[1]) throw takeFromExternrefTable0(ret[0]);
}
function wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375_6(arg0, arg1, arg2) {
	const ret = wasm.wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375_6(arg0, arg1, arg2);
	if (ret[1]) throw takeFromExternrefTable0(ret[0]);
}
function wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375_7(arg0, arg1, arg2) {
	const ret = wasm.wasm_bindgen__convert__closures_____invoke__h0a7e586e9273e375_7(arg0, arg1, arg2);
	if (ret[1]) throw takeFromExternrefTable0(ret[0]);
}
function wasm_bindgen__convert__closures_____invoke__h41057d61edf43a32(arg0, arg1, arg2, arg3) {
	wasm.wasm_bindgen__convert__closures_____invoke__h41057d61edf43a32(arg0, arg1, arg2, arg3);
}
var __wbindgen_enum_BinaryType = ["blob", "arraybuffer"];
var __wbindgen_enum_ReadableStreamType = ["bytes"];
var __wbindgen_enum_ReferrerPolicy = [
	"",
	"no-referrer",
	"no-referrer-when-downgrade",
	"origin",
	"origin-when-cross-origin",
	"unsafe-url",
	"same-origin",
	"strict-origin",
	"strict-origin-when-cross-origin"
];
var __wbindgen_enum_RequestCache = [
	"default",
	"no-store",
	"reload",
	"no-cache",
	"force-cache",
	"only-if-cached"
];
var __wbindgen_enum_RequestCredentials = [
	"omit",
	"same-origin",
	"include"
];
var __wbindgen_enum_RequestMode = [
	"same-origin",
	"no-cors",
	"cors",
	"navigate"
];
var __wbindgen_enum_RequestRedirect = [
	"follow",
	"error",
	"manual"
];
var BitcoinChainServiceHandleFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_bitcoinchainservicehandle_free(ptr, 1));
var BreezSdkFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_breezsdk_free(ptr, 1));
var DefaultCpfpSignerFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_defaultcpfpsigner_free(ptr, 1));
var DefaultSessionStoreFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_defaultsessionstore_free(ptr, 1));
var ExternalBreezSignerHandleFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_externalbreezsignerhandle_free(ptr, 1));
var ExternalSignersFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_externalsigners_free(ptr, 1));
var ExternalSigningSignerHandleFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_externalsigningsignerhandle_free(ptr, 1));
var ExternalSparkSignerHandleFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_externalsparksignerhandle_free(ptr, 1));
var IntoUnderlyingByteSourceFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_intounderlyingbytesource_free(ptr, 1));
var IntoUnderlyingSinkFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_intounderlyingsink_free(ptr, 1));
var IntoUnderlyingSourceFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_intounderlyingsource_free(ptr, 1));
var PasskeyClientFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_passkeyclient_free(ptr, 1));
var PasskeyLabelsFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_passkeylabels_free(ptr, 1));
var SdkBuilderFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_sdkbuilder_free(ptr, 1));
var SigningOnlyExternalSignersFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_signingonlyexternalsigners_free(ptr, 1));
var TokenIssuerFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_tokenissuer_free(ptr, 1));
var WasmSdkContextFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_wasmsdkcontext_free(ptr, 1));
var WasmStorageConfigFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_wasmstorageconfig_free(ptr, 1));
function addToExternrefTable0(obj) {
	const idx = wasm.__externref_table_alloc();
	wasm.__wbindgen_externrefs.set(idx, obj);
	return idx;
}
function _assertClass(instance, klass) {
	if (!(instance instanceof klass)) throw new Error(`expected instance of ${klass.name}`);
}
var CLOSURE_DTORS = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((state) => wasm.__wbindgen_destroy_closure(state.a, state.b));
function debugString(val) {
	const type = typeof val;
	if (type == "number" || type == "boolean" || val == null) return `${val}`;
	if (type == "string") return `"${val}"`;
	if (type == "symbol") {
		const description = val.description;
		if (description == null) return "Symbol";
		else return `Symbol(${description})`;
	}
	if (type == "function") {
		const name = val.name;
		if (typeof name == "string" && name.length > 0) return `Function(${name})`;
		else return "Function";
	}
	if (Array.isArray(val)) {
		const length = val.length;
		let debug = "[";
		if (length > 0) debug += debugString(val[0]);
		for (let i = 1; i < length; i++) debug += ", " + debugString(val[i]);
		debug += "]";
		return debug;
	}
	const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
	let className;
	if (builtInMatches && builtInMatches.length > 1) className = builtInMatches[1];
	else return toString.call(val);
	if (className == "Object") try {
		return "Object(" + JSON.stringify(val) + ")";
	} catch (_) {
		return "Object";
	}
	if (val instanceof Error) return `${val.name}: ${val.message}\n${val.stack}`;
	return className;
}
function getArrayJsValueFromWasm0(ptr, len) {
	ptr = ptr >>> 0;
	const mem = getDataViewMemory0();
	const result = [];
	for (let i = ptr; i < ptr + 4 * len; i += 4) result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
	wasm.__externref_drop_slice(ptr, len);
	return result;
}
function getArrayU8FromWasm0(ptr, len) {
	ptr = ptr >>> 0;
	return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
var cachedDataViewMemory0 = null;
function getDataViewMemory0() {
	if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
	return cachedDataViewMemory0;
}
function getStringFromWasm0(ptr, len) {
	return decodeText(ptr >>> 0, len);
}
var cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
	if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
	return cachedUint8ArrayMemory0;
}
function handleError(f, args) {
	try {
		return f.apply(this, args);
	} catch (e) {
		const idx = addToExternrefTable0(e);
		wasm.__wbindgen_exn_store(idx);
	}
}
function isLikeNone(x) {
	return x === void 0 || x === null;
}
function makeMutClosure(arg0, arg1, f) {
	const state = {
		a: arg0,
		b: arg1,
		cnt: 1
	};
	const real = (...args) => {
		state.cnt++;
		const a = state.a;
		state.a = 0;
		try {
			return f(a, state.b, ...args);
		} finally {
			state.a = a;
			real._wbg_cb_unref();
		}
	};
	real._wbg_cb_unref = () => {
		if (--state.cnt === 0) {
			wasm.__wbindgen_destroy_closure(state.a, state.b);
			state.a = 0;
			CLOSURE_DTORS.unregister(state);
		}
	};
	CLOSURE_DTORS.register(real, state, state);
	return real;
}
function passArray8ToWasm0(arg, malloc) {
	const ptr = malloc(arg.length * 1, 1) >>> 0;
	getUint8ArrayMemory0().set(arg, ptr / 1);
	WASM_VECTOR_LEN = arg.length;
	return ptr;
}
function passArrayJsValueToWasm0(array, malloc) {
	const ptr = malloc(array.length * 4, 4) >>> 0;
	for (let i = 0; i < array.length; i++) {
		const add = addToExternrefTable0(array[i]);
		getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
	}
	WASM_VECTOR_LEN = array.length;
	return ptr;
}
function passStringToWasm0(arg, malloc, realloc) {
	if (realloc === void 0) {
		const buf = cachedTextEncoder.encode(arg);
		const ptr = malloc(buf.length, 1) >>> 0;
		getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
		WASM_VECTOR_LEN = buf.length;
		return ptr;
	}
	let len = arg.length;
	let ptr = malloc(len, 1) >>> 0;
	const mem = getUint8ArrayMemory0();
	let offset = 0;
	for (; offset < len; offset++) {
		const code = arg.charCodeAt(offset);
		if (code > 127) break;
		mem[ptr + offset] = code;
	}
	if (offset !== len) {
		if (offset !== 0) arg = arg.slice(offset);
		ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
		const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
		const ret = cachedTextEncoder.encodeInto(arg, view);
		offset += ret.written;
		ptr = realloc(ptr, len, offset, 1) >>> 0;
	}
	WASM_VECTOR_LEN = offset;
	return ptr;
}
function takeFromExternrefTable0(idx) {
	const value = wasm.__wbindgen_externrefs.get(idx);
	wasm.__externref_table_dealloc(idx);
	return value;
}
var cachedTextDecoder = new TextDecoder("utf-8", {
	ignoreBOM: true,
	fatal: true
});
cachedTextDecoder.decode();
var MAX_SAFARI_DECODE_BYTES = 2146435072;
var numBytesDecoded = 0;
function decodeText(ptr, len) {
	numBytesDecoded += len;
	if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
		cachedTextDecoder = new TextDecoder("utf-8", {
			ignoreBOM: true,
			fatal: true
		});
		cachedTextDecoder.decode();
		numBytesDecoded = len;
	}
	return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
var cachedTextEncoder = new TextEncoder();
if (!("encodeInto" in cachedTextEncoder)) cachedTextEncoder.encodeInto = function(arg, view) {
	const buf = cachedTextEncoder.encode(arg);
	view.set(buf);
	return {
		read: arg.length,
		written: buf.length
	};
};
var WASM_VECTOR_LEN = 0;
var wasm;
function __wbg_finalize_init(instance, module) {
	wasm = instance.exports;
	cachedDataViewMemory0 = null;
	cachedUint8ArrayMemory0 = null;
	wasm.__wbindgen_start();
	return wasm;
}
async function __wbg_load(module, imports) {
	if (typeof Response === "function" && module instanceof Response) {
		if (typeof WebAssembly.instantiateStreaming === "function") try {
			return await WebAssembly.instantiateStreaming(module, imports);
		} catch (e) {
			if (module.ok && expectedResponseType(module.type) && module.headers.get("Content-Type") !== "application/wasm") console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
			else throw e;
		}
		const bytes = await module.arrayBuffer();
		return await WebAssembly.instantiate(bytes, imports);
	} else {
		const instance = await WebAssembly.instantiate(module, imports);
		if (instance instanceof WebAssembly.Instance) return {
			instance,
			module
		};
		else return instance;
	}
	function expectedResponseType(type) {
		switch (type) {
			case "basic":
			case "cors":
			case "default": return true;
		}
		return false;
	}
}
async function __wbg_init(module_or_path) {
	if (wasm !== void 0) return wasm;
	if (module_or_path !== void 0) {
		if (Object.getPrototypeOf(module_or_path) === Object.prototype) ({module_or_path} = module_or_path);
		else console.warn("using deprecated parameters for the initialization function; pass a single object instead");
	}
	if (module_or_path === void 0) module_or_path = new URL("breez_sdk_spark_wasm_bg.wasm", import.meta.url);
	const imports = __wbg_get_imports();
	if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) module_or_path = fetch(module_or_path);
	const { instance, module } = await __wbg_load(await module_or_path, imports);
	return __wbg_finalize_init(instance, module);
}
//#endregion
//#region ../../node_modules/@breeztech/breez-sdk-spark/web/index.js
var storageSetupComplete = false;
var setupWebStorage = async () => {
	if (storageSetupComplete) return;
	try {
		const { createDefaultStorage } = await import("./storage-Bya5b2Xt.js");
		globalThis.createDefaultStorage = createDefaultStorage;
		console.log("Breez SDK: Web IndexedDB storage automatically enabled");
		storageSetupComplete = true;
	} catch (error) {
		console.warn("Breez SDK: Failed to load Web storage:", error.message);
		console.warn("Breez SDK: Storage operations may not work properly. Ignore this warning if you are not using the default storage.");
	}
	try {
		const { createWebTreeStore } = await import("./tree-store-N362nuzZ.js");
		globalThis.createDefaultTreeStore = (dbName, logger) => createWebTreeStore(`${dbName}-tree`, logger);
	} catch (error) {
		console.warn("Breez SDK: Failed to load Web tree store:", error.message);
		console.warn("Breez SDK: Tree state will not be persisted. Ignore this warning if you are not using the default storage.");
	}
};
var initBreezSDK = async () => {
	await setupWebStorage();
	return await __wbg_init();
};
//#endregion
export { connect, initBreezSDK as default, defaultConfig };

//# sourceMappingURL=web-DwgdhfcY.js.map