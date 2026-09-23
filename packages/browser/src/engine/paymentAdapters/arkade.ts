import {
  Wallet, MnemonicIdentity, RestArkProvider, RestIndexerProvider, EsploraProvider,
  IndexedDBWalletRepository, IndexedDBContractRepository, ArkAddress, Transaction,
  assertSubmittedArkTxid, matchServerCheckpoints, assertAllowedSighashTypes, verifyTapscriptSignatures,
  type StorageConfig,
} from "@arkade-os/sdk";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { assertWholeSats, validatePaymentTarget, type PaymentAdapter, type PaymentReview, type PaymentTarget } from "@ghostly/core";

export interface ArkConfig { network: "bitcoin" | "regtest" | "signet" | "mutinynet"; provider: string; explorer: string; serverKey: string; walletId: string }
export interface ArkPrepared { signedTx: string; checkpoints: string[]; txid: string; address: string; amount: number; fee: number; finalCheckpoints?: string[] }
const unbase64 = (s: string) => Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(""));
const hex = (bytes: Uint8Array) => Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
class PreparedOnly extends Error {}
export const ARK_NETWORKS: ArkConfig["network"][] = ["bitcoin", "mutinynet", "signet", "regtest"];
/** Payments go through review and approval; only the SDK's own settlement (renewal, onboarding) reaches the provider directly. */
class PreviewProvider extends RestArkProvider {
  authorizedFinalize?:{txid:string;run:(checkpoints:string[])=>Promise<void>};
  captured?: { signedTx:string; checkpoints:string[] };
  take() { return this.captured; }
  override async submitTx(signedTx:string,checkpoints:string[]):Promise<never> { this.captured={signedTx,checkpoints};throw new PreparedOnly(); }
  override async finalizeTx(txid:string,checkpoints:string[]):Promise<void> {
    if(this.authorizedFinalize?.txid!==txid)throw new Error("Preview cannot finalize an unapproved payment");
    await this.authorizedFinalize.run(checkpoints);
  }
}
export class ArkadeAdapter implements PaymentAdapter<ArkPrepared> {
  readonly method = "arkade" as const;
  private pending:Promise<unknown>=Promise.resolve();
  private serial<T>(run:()=>Promise<T>):Promise<T>{const next=this.pending.then(run,run);this.pending=next.catch(()=>{});return next;}
  prepare(target:PaymentTarget,amount:number,feeCap:number){return this.serial(()=>this.prepareOperation(target,amount,feeCap));}
  execute(review:PaymentReview,prepared:ArkPrepared,persist?:()=>Promise<void>){return this.serial(()=>this.executeOperation(review,prepared,persist));}
  reconcile(review:PaymentReview,prepared:ArkPrepared,persist?:()=>Promise<void>){return this.serial(()=>this.reconcileOperation(review,prepared,persist));}
  private constructor(readonly config: ArkConfig, private identity: MnemonicIdentity, private wallet: Wallet, private preview: PreviewProvider, private provider: RestArkProvider, private indexer: RestIndexerProvider,private repository:NonNullable<StorageConfig["walletRepository"]>) {}
  static async connect(config: ArkConfig, mnemonic: string, storage?: StorageConfig): Promise<ArkadeAdapter> {
    if (!ARK_NETWORKS.includes(config.network)) throw new Error("Unsupported Ark network");
    validatePaymentTarget({method:"arkade",network:config.network,provider:config.provider,asset:"BTC",unit:"sat",address:"configuration",expiresAt:Date.now()+60000});
    validatePaymentTarget({method:"arkade",network:config.network,provider:config.explorer,asset:"BTC",unit:"sat",address:"configuration",expiresAt:Date.now()+60000});
    const provider=new RestArkProvider(config.provider);
    const info=await provider.getInfo();
    if(info.network!==config.network || info.signerPubkey!==config.serverKey) throw new Error("Ark provider network or signing key changed. Review the wallet configuration.");
    const identity=MnemonicIdentity.fromMnemonic(mnemonic,{isMainnet:config.network==="bitcoin"});
    const preview=new PreviewProvider(config.provider);
    const indexer=new RestIndexerProvider(config.provider);
    const repositories={...storage,walletRepository:storage?.walletRepository??new IndexedDBWalletRepository(`ghostly-ark-${config.walletId}`),contractRepository:storage?.contractRepository??new IndexedDBContractRepository(`ghostly-ark-${config.walletId}`)};
    const wallet=await Wallet.create({identity,arkProvider:preview,indexerProvider:indexer,onchainProvider:new EsploraProvider(config.explorer),
      // Renews VTXOs before they expire and settles on-chain deposits into Ark, so a wallet left alone keeps its funds.
      // A local regtest server expires batches within minutes; there the test drives settlement itself.
      settlementConfig:config.network==="regtest"?false:{boardingUtxoSweep:true},walletMode:"hd",storage:repositories});
    return new ArkadeAdapter(config,identity,wallet,preview,provider,indexer,repositories.walletRepository);
  }
  async address() { return this.wallet.getAddress(); }
  requestAddress() { return this.serial(async()=>(await this.wallet.getNewAddresses({types:["default"],forceNew:true}))[0].address); }
  async balance() { return (await this.wallet.getBalance()).available; }
  /** Sats whose batch expired before they were renewed: still this wallet's, but only after a recovery. */
  async recoverable() { return Number((await this.wallet.getBalance()).recoverable ?? 0); }
  /** Moves expired (swept) outputs back into the balance, through the server's next batch. */
  recover() { return this.serial(async()=>(await this.wallet.getVtxoManager()).recoverVtxos()); }
  /** On-chain deposits land here; the SDK's settlement moves them into Ark once confirmed. */
  boardingAddress() { return this.wallet.getBoardingAddress(); }
  /** Sats sent on-chain to the boarding address that are not in Ark yet. */
  async incoming() { return (await this.wallet.getBalance()).boarding.total; }
  async dispose() { await this.wallet.dispose(); }
  private async prepareOperation(target:PaymentTarget,amount:number,feeCap:number):Promise<{fee:number;prepared:ArkPrepared}> {
    validatePaymentTarget(target); assertWholeSats(amount); this.checkTarget(target);
    const info=await this.provider.getInfo();
    if(info.network!==this.config.network || info.signerPubkey!==this.config.serverKey)throw new Error("Ark provider configuration changed");
    if(await this.balance()<amount)throw new Error("Insufficient Ark balance");
    this.preview.captured=undefined;
    try { await this.wallet.send({address:target.address,amount}); }
    catch(error) {
      if(!(error instanceof PreparedOnly)) {
        // Provider errors may embed signed payment material; expose only this bounded message.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("Could not prepare this Ark payment. Check funds, address and provider.");
      }
    }
    const capture=this.preview.take();
    if(!capture)throw new Error("The Ark adapter did not prepare a transaction");
    const tx=Transaction.fromPSBT(unbase64(capture.signedTx));
    const destination=ArkAddress.decode(target.address);
    let received=0n,input=0n,output=0n;
    for(let i=0;i<tx.inputsLength;i++){const prev=tx.getInput(i).witnessUtxo;if(!prev)throw new Error("Missing Ark input amount");input+=prev.amount;}
    for(let i=0;i<tx.outputsLength;i++){const out=tx.getOutput(i);output+=out.amount??0n;if(out.script && [hex(destination.pkScript),hex(destination.subdustPkScript)].includes(hex(out.script)))received+=out.amount??0n;}
    const fee=Number(input-output);
    if(received!==BigInt(amount) || !Number.isSafeInteger(fee) || fee<0 || fee>feeCap)throw new Error("Prepared amount or fee does not match your review");
    return {fee,prepared:{...capture,txid:tx.id,address:target.address,amount,fee}};
  }
  private async executeOperation(review:PaymentReview,p:ArkPrepared,persist?:()=>Promise<void>) {
    this.checkPrepared(review,p);
    const info=await this.provider.getInfo();
    if(info.network!==this.config.network || info.signerPubkey!==this.config.serverKey)throw new Error("Ark provider configuration changed");
    const tx=Transaction.fromPSBT(unbase64(p.signedTx));
    const response=await this.provider.submitTx(p.signedTx,p.checkpoints);
    assertSubmittedArkTxid(response,tx,"Ghostly Ark submission");
    if(!response.finalArkTx)throw new Error("Provider returned no signed transaction");
    this.verifyServer(Transaction.fromPSBT(unbase64(response.finalArkTx)),tx);
    const matched=matchServerCheckpoints(response.signedCheckpointTxs,p.checkpoints.map(c=>Transaction.fromPSBT(unbase64(c))),"Ghostly Ark checkpoints");
    const contracts=await (await this.wallet.getContractManager()).getContracts();
    const final=await Promise.all(matched.map(async ({server,local})=>{
      assertAllowedSighashTypes(server);this.verifyServer(server,local);
      let signed=server;
      for(let index=0;index<local.inputsLength;index++){
        const script=local.getInput(index).witnessUtxo?.script;
        const contract=script && contracts.find(c=>c.script===hex(script));
        if(!contract || contract.type!=="default")throw new Error("Checkpoint is not owned by this wallet profile");
        const descriptor=contract.metadata?.signingDescriptor;
        const signer=typeof descriptor==="string" ? await this.wallet.signerForDescriptor(descriptor) : contract.params.pubKey===hex(await this.identity.xOnlyPublicKey()) ? this.identity : undefined;
        if(!signer)throw new Error("Checkpoint signing descriptor missing");
        signed=await signer.sign(signed,[index]);
      }
      return base64(signed.toPSBT());
    }));
    p.finalCheckpoints=final;
    await persist?.();
    await this.provider.finalizeTx(p.txid,final);
    return {txid:p.txid,settled:true};
  }
  private async reconcileOperation(review:PaymentReview,p:ArkPrepared,persist?:()=>Promise<void>) {
    this.checkPrepared(review,p);
    if(await this.verifyReceipt(p.txid,p.address,p.amount))return {txid:p.txid,settled:true};
    if(!p.finalCheckpoints){
      // An empty, lagging indexer result can clear the SDK hint. The durable
      // Ghostly journal is authoritative that this approved attempt is unresolved.
      const state=await this.repository.getWalletState();
      if(!state)throw new Error("Ark wallet state is unavailable");
      await this.repository.saveWalletState({...state,settings:{...state.settings,hasPendingTx:true}});
      // Ask for pending transactions using SDK ownership proofs. Only the previously
      // approved transaction may finalize; submitTx remains permanently blocked here.
      this.preview.authorizedFinalize={txid:p.txid,run:async checkpoints=>{
        const matched=matchServerCheckpoints(checkpoints,p.checkpoints.map(c=>Transaction.fromPSBT(unbase64(c))),"Ghostly pending recovery");
        for(const {server,local} of matched){assertAllowedSighashTypes(server);this.verifyServer(server,local);}
        p.finalCheckpoints=checkpoints;await persist?.();
        await this.provider.finalizeTx(p.txid,checkpoints);
      }};
      try {await this.wallet.finalizePendingTxs();}finally{this.preview.authorizedFinalize=undefined;}
    }
    // Resume only the same finalization, never a new send/submit after ambiguity.
    if(p.finalCheckpoints) {
      try {await this.provider.finalizeTx(p.txid,p.finalCheckpoints);}
      catch { /* A finalized transaction can reject repeated finalization; verify its receipt. */ }
    }
    return {txid:p.txid,settled:await this.verifyReceipt(p.txid,p.address,p.amount)};
  }
  async verifyReceipt(txid:string,address:string,amount:number):Promise<boolean> {
    if(!/^[a-f0-9]{64}$/.test(txid))return false;
    const destination=ArkAddress.decode(address);
    const result=await this.indexer.getVtxos({outpoints:[{txid,vout:0}]});
    return result.vtxos.some(v=>v.txid===txid && v.value===amount && [hex(destination.pkScript),hex(destination.subdustPkScript)].includes(v.script));
  }
  private checkTarget(t:PaymentTarget) {
    if(t.method!==this.method || t.provider!==this.config.provider || t.network!==this.config.network || t.asset!=="BTC" || t.unit!=="sat")throw new Error("Payment method, network or provider does not match this wallet");
    const decoded=ArkAddress.decode(t.address);
    const pinned=this.config.serverKey.replace(/^(02|03)(?=[a-f0-9]{64}$)/,"");
    if(hex(decoded.serverPubKey)!==pinned || decoded.hrp!==(this.config.network==="bitcoin"?"ark":"tark"))throw new Error("Ark address belongs to another provider or network");
  }
  private verifyServer(server:Transaction,local:Transaction) {
    const key=this.config.serverKey.replace(/^(02|03)(?=[a-f0-9]{64}$)/,"");
    for(let index=0;index<local.inputsLength;index++){
      const leaf=local.getInput(index).tapLeafScript?.[0]?.[1];
      if(!leaf)throw new Error("Missing reviewed spend leaf");
      verifyTapscriptSignatures(server,index,[key],undefined,undefined,tapLeafHash(leaf.subarray(0,-1),leaf[leaf.length-1]));
    }
  }
  private checkPrepared(r:PaymentReview,p:ArkPrepared) {
    this.checkTarget(r);
    if(p.address!==r.address || p.amount!==r.amount || p.fee!==r.fee || p.fee>r.feeCap || Transaction.fromPSBT(unbase64(p.signedTx)).id!==p.txid)throw new Error("Prepared payment does not match the approved review");
  }
}
