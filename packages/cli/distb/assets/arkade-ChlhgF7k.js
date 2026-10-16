import { bn as validatePaymentTarget, gn as arkAddressPrefix, vn as assertWholeSats } from "./src-dfGE33hw.js";
import { ArkAddress, EsploraProvider, IndexedDBContractRepository, IndexedDBWalletRepository, MnemonicIdentity, RestArkProvider, RestIndexerProvider, Transaction, Wallet, assertAllowedSighashTypes, assertSubmittedArkTxid, canRecoverOnchain, isRecoverable, matchServerCheckpoints, verifyTapscriptSignatures } from "@arkade-os/sdk";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
//#region ../browser/src/engine/paymentAdapters/arkade.ts
var unbase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
var base64 = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
var hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
var PreparedOnly = class extends Error {};
var ARK_NETWORKS = [
	"bitcoin",
	"mutinynet",
	"signet",
	"regtest"
];
/** Payments go through review and approval; only the SDK's own settlement (renewal, onboarding) reaches the provider directly. */
var PreviewProvider = class extends RestArkProvider {
	authorizedFinalize;
	captured;
	take() {
		return this.captured;
	}
	async submitTx(signedTx, checkpoints) {
		this.captured = {
			signedTx,
			checkpoints
		};
		throw new PreparedOnly();
	}
	async finalizeTx(txid, checkpoints) {
		if (this.authorizedFinalize?.txid !== txid) throw new Error("Preview cannot finalize an unapproved payment");
		await this.authorizedFinalize.run(checkpoints);
	}
};
var ArkadeAdapter = class ArkadeAdapter {
	config;
	identity;
	wallet;
	preview;
	provider;
	indexer;
	repository;
	method = "arkade";
	pending = Promise.resolve();
	serial(run) {
		const next = this.pending.then(run, run);
		this.pending = next.catch(() => {});
		return next;
	}
	prepare(target, amount, feeCap) {
		return this.serial(() => this.prepareOperation(target, amount, feeCap));
	}
	execute(review, prepared, persist) {
		return this.serial(() => this.executeOperation(review, prepared, persist));
	}
	reconcile(review, prepared, persist) {
		return this.serial(() => this.reconcileOperation(review, prepared, persist));
	}
	constructor(config, identity, wallet, preview, provider, indexer, repository) {
		this.config = config;
		this.identity = identity;
		this.wallet = wallet;
		this.preview = preview;
		this.provider = provider;
		this.indexer = indexer;
		this.repository = repository;
	}
	static async connect(config, mnemonic, storage) {
		if (!ARK_NETWORKS.includes(config.network)) throw new Error("Unsupported Ark network");
		validatePaymentTarget({
			method: "arkade",
			network: config.network,
			provider: config.provider,
			asset: "BTC",
			unit: "sat",
			address: `${arkAddressPrefix(config.network)}configuration`,
			expiresAt: Date.now() + 6e4
		});
		validatePaymentTarget({
			method: "arkade",
			network: config.network,
			provider: config.explorer,
			asset: "BTC",
			unit: "sat",
			address: `${arkAddressPrefix(config.network)}configuration`,
			expiresAt: Date.now() + 6e4
		});
		const provider = new RestArkProvider(config.provider);
		const info = await provider.getInfo();
		if (info.network !== config.network || info.signerPubkey !== config.serverKey) throw new Error("Ark provider network or signing key changed. Review the wallet configuration.");
		const identity = MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet: config.network === "bitcoin" });
		const preview = new PreviewProvider(config.provider);
		const indexer = new RestIndexerProvider(config.provider);
		const repositories = {
			...storage,
			walletRepository: storage?.walletRepository ?? new IndexedDBWalletRepository(`ghostly-ark-${config.walletId}`),
			contractRepository: storage?.contractRepository ?? new IndexedDBContractRepository(`ghostly-ark-${config.walletId}`)
		};
		const wallet = await Wallet.create({
			identity,
			arkProvider: preview,
			indexerProvider: indexer,
			onchainProvider: new EsploraProvider(config.explorer),
			settlementConfig: config.network === "regtest" ? false : { boardingUtxoSweep: true },
			walletMode: "hd",
			storage: repositories
		});
		return new ArkadeAdapter(config, identity, wallet, preview, provider, indexer, repositories.walletRepository);
	}
	async address() {
		return this.wallet.getAddress();
	}
	requestAddress() {
		return this.serial(async () => (await this.wallet.getNewAddresses({
			types: ["default"],
			forceNew: true
		}))[0].address);
	}
	async balance() {
		return (await this.wallet.getBalance()).available;
	}
	/**
	* Sats whose batch expired before they were renewed, in three kinds, as a person can act on them:
	* - `sweeping`: past their expiry, but the server has not swept their batch yet (with any swept ones: none can be
	*   recovered meanwhile). The SDK (0.4.76) counts them as
	*   recoverable already, but it settles an unswept coin without the forfeit the server still asks for (arkd wants
	*   one until the sweep): the batch fails ("missing forfeit transactions") and the server bans the coin for a while.
	*   The sweep waits for the chain's time to pass the expiry: an hour or more on a real network, the expiry's blocks
	*   on regtest.
	* - `recoverable`: swept, and a recovery takes them now.
	* - `small`: swept, but together under the server's dust limit: a recovery makes one new coin and the server makes
	*   none that small, so `recoverVtxos` answers "No recoverable VTXOs found". They wait for more coins to expire.
	*/
	async expired() {
		const now = { timestamp: /* @__PURE__ */ new Date() };
		let swept = 0, sweeping = 0;
		for (const vtxo of await this.wallet.getVtxos({
			withRecoverable: true,
			withUnrolled: false
		})) if (isRecoverable(vtxo)) swept += vtxo.value;
		else if (!vtxo.isSwept && canRecoverOnchain(vtxo, now)) sweeping += vtxo.value;
		const takes = !sweeping && swept > 0 && (await (await this.wallet.getVtxoManager()).getRecoverableBalance()).recoverable >= this.wallet.dustAmount;
		return sweeping ? {
			recoverable: 0,
			sweeping: sweeping + swept,
			small: 0
		} : {
			recoverable: takes ? swept : 0,
			sweeping: 0,
			small: takes ? 0 : swept
		};
	}
	/**
	* When the first coin still spendable expires (ms), or undefined with none: a coin left alone past it is swept by the
	* server and comes back only through a recovery. An expiry in blocks is read against the explorer's tip, at about ten
	* minutes a block.
	*/
	async expiresAt() {
		let at, height;
		for (const vtxo of await this.wallet.getVtxos({
			withRecoverable: false,
			withUnrolled: false
		})) {
			if (vtxo.isSwept || vtxo.isSpent) continue;
			if (vtxo.expiresAt instanceof Date) {
				const ms = vtxo.expiresAt.getTime();
				if (Number.isFinite(ms)) at = Math.min(at ?? ms, ms);
			} else if (typeof vtxo.expiresAtHeight === "number") height = Math.min(height ?? vtxo.expiresAtHeight, vtxo.expiresAtHeight);
		}
		if (height !== void 0) {
			const tip = (await new EsploraProvider(this.config.explorer).getChainTip()).height;
			const ms = Date.now() + Math.max(0, height - tip) * 6e5;
			at = Math.min(at ?? ms, ms);
		}
		return at;
	}
	/**
	* Moves swept outputs back into the balance, through the server's next batch. Refused while any expired coin is
	* not swept yet (`recoverVtxos` would name it too, and that batch fails for all of them), and when what is swept
	* is too little for a batch.
	*/
	recover() {
		return this.serial(async () => {
			const { recoverable, sweeping, small } = await this.expired();
			if (sweeping) throw new Error("Expired coins can be recovered once the Ark server has swept their batch. Try again later.");
			if (small) throw new Error("Too few expired sats to recover on their own. They are recovered with the next coins that expire.");
			if (!recoverable) throw new Error("Nothing to recover");
			return (await this.wallet.getVtxoManager()).recoverVtxos();
		});
	}
	/** On-chain deposits land here; the SDK's settlement moves them into Ark once confirmed. */
	boardingAddress() {
		return this.wallet.getBoardingAddress();
	}
	/** Sats sent on-chain to the boarding address that are not in Ark yet. */
	async incoming() {
		return (await this.wallet.getBalance()).boarding.total;
	}
	async dispose() {
		await this.wallet.dispose();
	}
	async prepareOperation(target, amount, feeCap) {
		validatePaymentTarget(target);
		assertWholeSats(amount);
		this.checkTarget(target);
		const info = await this.provider.getInfo();
		if (info.network !== this.config.network || info.signerPubkey !== this.config.serverKey) throw new Error("Ark provider configuration changed");
		if (await this.balance() < amount) throw new Error("Insufficient Ark balance");
		this.preview.captured = void 0;
		try {
			await this.wallet.send({
				address: target.address,
				amount
			});
		} catch (error) {
			if (!(error instanceof PreparedOnly)) throw new Error("Could not prepare this Ark payment. Check funds, address and provider.");
		}
		const capture = this.preview.take();
		if (!capture) throw new Error("The Ark adapter did not prepare a transaction");
		const tx = Transaction.fromPSBT(unbase64(capture.signedTx));
		const destination = ArkAddress.decode(target.address);
		let received = 0n, input = 0n, output = 0n;
		for (let i = 0; i < tx.inputsLength; i++) {
			const prev = tx.getInput(i).witnessUtxo;
			if (!prev) throw new Error("Missing Ark input amount");
			input += prev.amount;
		}
		for (let i = 0; i < tx.outputsLength; i++) {
			const out = tx.getOutput(i);
			output += out.amount ?? 0n;
			if (out.script && [hex(destination.pkScript), hex(destination.subdustPkScript)].includes(hex(out.script))) received += out.amount ?? 0n;
		}
		const fee = Number(input - output);
		if (received !== BigInt(amount) || !Number.isSafeInteger(fee) || fee < 0 || fee > feeCap) throw new Error("Prepared amount or fee does not match your review");
		return {
			fee,
			prepared: {
				...capture,
				txid: tx.id,
				address: target.address,
				amount,
				fee
			}
		};
	}
	async executeOperation(review, p, persist) {
		this.checkPrepared(review, p);
		const info = await this.provider.getInfo();
		if (info.network !== this.config.network || info.signerPubkey !== this.config.serverKey) throw new Error("Ark provider configuration changed");
		const tx = Transaction.fromPSBT(unbase64(p.signedTx));
		const response = await this.provider.submitTx(p.signedTx, p.checkpoints);
		assertSubmittedArkTxid(response, tx, "Ghostly Ark submission");
		if (!response.finalArkTx) throw new Error("Provider returned no signed transaction");
		this.verifyServer(Transaction.fromPSBT(unbase64(response.finalArkTx)), tx);
		const matched = matchServerCheckpoints(response.signedCheckpointTxs, p.checkpoints.map((c) => Transaction.fromPSBT(unbase64(c))), "Ghostly Ark checkpoints");
		const contracts = await (await this.wallet.getContractManager()).getContracts();
		const final = await Promise.all(matched.map(async ({ server, local }) => {
			assertAllowedSighashTypes(server);
			this.verifyServer(server, local);
			let signed = server;
			for (let index = 0; index < local.inputsLength; index++) {
				const script = local.getInput(index).witnessUtxo?.script;
				const contract = script && contracts.find((c) => c.script === hex(script));
				if (!contract || contract.type !== "default") throw new Error("Checkpoint is not owned by this wallet profile");
				const descriptor = contract.metadata?.signingDescriptor;
				const signer = typeof descriptor === "string" ? await this.wallet.signerForDescriptor(descriptor) : contract.params.pubKey === hex(await this.identity.xOnlyPublicKey()) ? this.identity : void 0;
				if (!signer) throw new Error("Checkpoint signing descriptor missing");
				signed = await signer.sign(signed, [index]);
			}
			return base64(signed.toPSBT());
		}));
		p.finalCheckpoints = final;
		await persist?.();
		await this.provider.finalizeTx(p.txid, final);
		return {
			txid: p.txid,
			settled: true
		};
	}
	async reconcileOperation(review, p, persist) {
		this.checkPrepared(review, p);
		if (await this.verifyReceipt(p.txid, p.address, p.amount)) return {
			txid: p.txid,
			settled: true
		};
		if (!p.finalCheckpoints) {
			const state = await this.repository.getWalletState();
			if (!state) throw new Error("Ark wallet state is unavailable");
			await this.repository.saveWalletState({
				...state,
				settings: {
					...state.settings,
					hasPendingTx: true
				}
			});
			this.preview.authorizedFinalize = {
				txid: p.txid,
				run: async (checkpoints) => {
					const matched = matchServerCheckpoints(checkpoints, p.checkpoints.map((c) => Transaction.fromPSBT(unbase64(c))), "Ghostly pending recovery");
					for (const { server, local } of matched) {
						assertAllowedSighashTypes(server);
						this.verifyServer(server, local);
					}
					p.finalCheckpoints = checkpoints;
					await persist?.();
					await this.provider.finalizeTx(p.txid, checkpoints);
				}
			};
			try {
				await this.wallet.finalizePendingTxs();
			} finally {
				this.preview.authorizedFinalize = void 0;
			}
		}
		if (p.finalCheckpoints) try {
			await this.provider.finalizeTx(p.txid, p.finalCheckpoints);
		} catch {}
		return {
			txid: p.txid,
			settled: await this.verifyReceipt(p.txid, p.address, p.amount)
		};
	}
	/**
	* A virtual output paying `address` at least `amount`, made after `since` and none of `claimed`: how a
	* request paid from another Ark wallet is seen, with no receipt from the payer.
	*/
	async received(address, amount, since, claimed) {
		const destination = ArkAddress.decode(address);
		const scripts = [hex(destination.pkScript), hex(destination.subdustPkScript)];
		const { vtxos } = await this.indexer.getVtxos({ scripts });
		return vtxos.find((v) => /^[a-f0-9]{64}$/.test(v.txid) && v.value >= amount && scripts.includes(v.script) && !claimed.has(v.txid) && v.createdAt.getTime() >= since - 6e4)?.txid;
	}
	async verifyReceipt(txid, address, amount) {
		if (!/^[a-f0-9]{64}$/.test(txid)) return false;
		const destination = ArkAddress.decode(address);
		return (await this.indexer.getVtxos({ outpoints: [{
			txid,
			vout: 0
		}] })).vtxos.some((v) => v.txid === txid && v.value === amount && [hex(destination.pkScript), hex(destination.subdustPkScript)].includes(v.script));
	}
	checkTarget(t) {
		if (t.method !== this.method || t.provider !== this.config.provider || t.network !== this.config.network || t.asset !== "BTC" || t.unit !== "sat") throw new Error("Payment method, network or provider does not match this wallet");
		const decoded = ArkAddress.decode(t.address);
		const pinned = this.config.serverKey.replace(/^(02|03)(?=[a-f0-9]{64}$)/, "");
		if (hex(decoded.serverPubKey) !== pinned || decoded.hrp !== (this.config.network === "bitcoin" ? "ark" : "tark")) throw new Error("Ark address belongs to another provider or network");
	}
	verifyServer(server, local) {
		const key = this.config.serverKey.replace(/^(02|03)(?=[a-f0-9]{64}$)/, "");
		for (let index = 0; index < local.inputsLength; index++) {
			const leaf = local.getInput(index).tapLeafScript?.[0]?.[1];
			if (!leaf) throw new Error("Missing reviewed spend leaf");
			verifyTapscriptSignatures(server, index, [key], void 0, void 0, tapLeafHash(leaf.subarray(0, -1), leaf[leaf.length - 1]));
		}
	}
	checkPrepared(r, p) {
		this.checkTarget(r);
		if (p.address !== r.address || p.amount !== r.amount || p.fee !== r.fee || p.fee > r.feeCap || Transaction.fromPSBT(unbase64(p.signedTx)).id !== p.txid) throw new Error("Prepared payment does not match the approved review");
	}
};
//#endregion
export { ARK_NETWORKS, ArkadeAdapter };

//# sourceMappingURL=arkade-ChlhgF7k.js.map