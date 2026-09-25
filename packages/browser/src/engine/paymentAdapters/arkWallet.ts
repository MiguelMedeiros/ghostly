import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { RestArkProvider } from "@arkade-os/sdk";
import { validatePaymentTarget, type PaymentTarget } from "@ghostly/core";
import { store, STORES, transact, wrap } from "../../shared/idb";
import { ARK_NETWORKS, ArkadeAdapter, type ArkConfig } from "./arkade";
import { newDeviceKey, sealSeed, unsealSeed, type EncryptedSeed } from "./persistence";
import { snapshotArkDatabase,restoreArkDatabase,encodeBackup,decodeBackup,type ArkDatabaseSnapshot } from "./backup";
import type { SavedIntent } from "./coordinator";
import type { WalletNetwork } from "@ghostly/core";
import type { WalletMode } from "../../shared/mints";
import { ModeChanged, ModeGate, WrongNetworkError, networkLabel } from "./modeGate";
import { walletKey } from "./walletNetworks";
export interface ArkWalletView { configured:boolean; locked:boolean; automatic?:boolean; network?:ArkConfig["network"]; provider?:string; address?:string; boardingAddress?:string; incoming?:number; balance:number; recoverable?:number; error?:string }
/** A wallet with a device key opens by itself; one sealed with a password (older profiles) waits for it. */
interface StoredArk {config:ArkConfig;seed:EncryptedSeed;deviceKey?:string}
export interface ArkCreate {network:ArkConfig["network"];provider:string;explorer:string;password?:string;mnemonic?:string}
/** Every new profile starts with this wallet: nothing to set up before receiving. */
export const DEFAULT_ARK = {network:"bitcoin",provider:"https://arkade.computer",explorer:"https://mempool.space/api"} as const satisfies Omit<ArkCreate,"password"|"mnemonic">;
const checkProviders=(network:ArkConfig["network"],...urls:string[])=>{for(const provider of urls)validatePaymentTarget({method:"arkade",network,provider,asset:"BTC",unit:"sat",address:"configuration",expiresAt:Date.now()+60000});};
/** A Testnet Ark wallet starts on Mutinynet: a public test network with its own Ark server. */
export const TESTNET_ARK = {network:"mutinynet",provider:"https://mutinynet.arkade.sh",explorer:"https://mutinynet.com/api"} as const satisfies Omit<ArkCreate,"password"|"mnemonic">;
/** Bitcoin is real money; every other Ark network is for testing. */
export const arkMode=(network:ArkConfig["network"]):WalletMode=>network==="bitcoin"?"mainnet":"testnet";
/** The defaults a new wallet of this network is made with, in one click. */
export const arkDefaults=(network:WalletNetwork)=>network==="testnet"?TESTNET_ARK:DEFAULT_ARK;
/**
 * The Ark wallet of one network: a profile has one for Mainnet and one for Testnet, both open at once, each
 * stored under its own key (see walletNetworks.ts).
 */
export class ArkWallet {
  private readonly key:string;
  private saved?:StoredArk;
  private timer?:ReturnType<typeof setTimeout>;
  private retry?:ReturnType<typeof setTimeout>;
  private readying?:Promise<void>;
  private stopped=false;
  private queue:Promise<unknown>=Promise.resolve();
  private gate=new ModeGate();
  adapter?:ArkadeAdapter;
  view:ArkWalletView={configured:false,locked:true,balance:0};
  constructor(readonly network:WalletNetwork,private changed:()=>void) {this.key=walletKey("arkWallet",network);}
  /** Creating, replacing and restoring never interleave: two of them could each think the profile is empty. */
  private serial<T>(run:()=>Promise<T>):Promise<T>{const next=this.queue.then(run,run);this.queue=next.catch(()=>{});return next;}
  async start() {this.saved=await wrap<StoredArk|undefined>((await store(STORES.settings,"readonly")).get(this.key));this.view={configured:!!this.saved,locked:true,automatic:!!this.saved?.deviceKey,balance:0,network:this.saved?.config.network,provider:this.saved?.config.provider};}
  /**
   * Opens the wallet when it needs no password; `create`: makes the default one first when there is none. Retries
   * while the provider is unreachable.
   */
  ensureReady(create=false):Promise<void> {
    // One already under way may not have created: once it ends, look again (once).
    if(this.readying)return this.readying.then(()=>this.needsReady(create)?this.startReady(create):undefined);
    return this.startReady(create);
  }
  private startReady(create:boolean):Promise<void> {return this.readying??=this.ready(create).finally(()=>{this.readying=undefined;});}
  private needsReady(create:boolean) {return !this.stopped&&(this.saved?!!this.saved.deviceKey&&!this.adapter:create);}
  private async ready(create:boolean) {
    clearTimeout(this.retry);
    try {
      if(!this.saved){if(create)await this.createDefault();}
      else if(this.saved.deviceKey && !this.adapter)await this.serial(()=>this.stopped?Promise.resolve():this.unlock());
    } catch(error) {
      if(this.stopped||error instanceof ModeChanged)return;
      this.view={...this.view,error:`Connecting to Ark… ${error instanceof Error?error.message:""}`.trim()};this.changed();
      this.retry=setTimeout(()=>void this.ensureReady(create),30000);
    }
  }
  private createDefault() {return this.serial(async()=>{if(!this.saved)await this.createNow({...arkDefaults(this.network)});});}
  /** A wallet of this network with its default Ark server, made now: it answers first, or nothing is saved. */
  createDefaultNow() {return this.serial(async()=>{if(this.saved)throw new Error(`There is already a ${networkLabel(this.network)} Ark wallet`);await this.createNow({...arkDefaults(this.network)});});}
  get configured() {return !!this.saved;}
  /** A creation waiting on its server gives up now, saving nothing. */
  cutShort() {this.gate.interrupt();}
  resume() {this.gate.resume();}
  create(params:ArkCreate) {return this.serial(()=>this.createNow(params));}
  private async createNow(params:ArkCreate) {
    if(!ARK_NETWORKS.includes(params.network))throw new Error("Unsupported Ark network");
    if(arkMode(params.network)!==this.network)throw new WrongNetworkError(arkMode(params.network),`${params.network==="bitcoin"?"Bitcoin":params.network} is a ${networkLabel(arkMode(params.network))} network: this is the ${networkLabel(this.network)} Ark wallet`);
    checkProviders(params.network,params.provider,params.explorer);
    const mnemonic=params.mnemonic?.trim() || generateMnemonic(wordlist);
    if(!validateMnemonic(mnemonic,wordlist))throw new Error("Invalid recovery phrase");
    const deviceKey=params.password?undefined:newDeviceKey();
    const seed=await sealSeed(mnemonic,params.password??deviceKey!);
    const info=await this.gate.within(new RestArkProvider(params.provider).getInfo());
    if(info.network!==params.network)throw new Error(`That Ark provider runs on ${info.network}, not ${params.network}`);
    const config:ArkConfig={network:params.network,provider:params.provider.replace(/\/$/,""),explorer:params.explorer.replace(/\/$/,""),serverKey:info.signerPubkey,walletId:crypto.randomUUID()};
    const replaced=this.saved && await this.retirable("This Ark wallet already has funds or payments; it will not be replaced");
    const saved:StoredArk={config,seed,deviceKey};
    let adapter:ArkadeAdapter|undefined;
    try {adapter=await this.gate.within(ArkadeAdapter.connect(config,mnemonic),a=>a.dispose());await this.save(saved,replaced||undefined);}
    catch(error){await adapter?.dispose();if(replaced)void this.ensureReady();throw error;}
    this.saved=saved;this.adapter=adapter;this.view={configured:true,locked:false,automatic:!!deviceKey,balance:0,network:config.network,provider:config.provider};await this.refresh();
  }
  async unlock(password?:string) {
    if(!this.saved)throw new Error("Create or restore an Ark wallet first");
    if(this.adapter)return;
    const key=this.saved.deviceKey??password;
    if(!key)throw new Error("Enter the Ark wallet password");
    const mnemonic=await unsealSeed(this.saved.seed,key);
    this.adapter=await this.gate.within(ArkadeAdapter.connect(this.saved.config,mnemonic),a=>a.dispose());await this.refresh();
  }
  /** Shutting down: nothing reconnects afterwards. */
  async stop() {this.stopped=true;this.gate.close();await this.serial(()=>this.lock());}
  async lock() {clearTimeout(this.timer);clearTimeout(this.retry);const adapter=this.adapter;this.adapter=undefined;this.view={...this.view,locked:true,address:undefined};this.changed();await adapter?.dispose();}
  async backup(password?:string) {if(!this.saved)throw new Error("No Ark wallet to back up");return {mnemonic:await unsealSeed(this.saved.seed,this.saved.deviceKey??password??""),config:this.saved.config};}
  /** The backup file is always sealed with a password the person chooses, even for a wallet that opens by itself. */
  async exportBackup(password:string):Promise<string> {
    if(password.length<12)throw new Error("Use at least 12 characters for the backup password");
    const {mnemonic,config}=await this.backup(password);
    const database=await snapshotArkDatabase(config.walletId);
    const intents=(await wrap<SavedIntent[]>((await store(STORES.intents,"readonly")).getAll())).filter(i=>this.ours(i));
    const payload=encodeBackup({format:"ghostly-ark",version:1,sdk:"0.4.74",createdAt:Date.now(),mnemonic,config,database,intents});
    return JSON.stringify({format:"ghostly-ark-encrypted",version:1,vault:await sealSeed(payload,password)});
  }
  restoreBackup(text:string,password:string):Promise<void> {return this.serial(async()=>{
    if(text.length>16*1024*1024)throw new Error("Ark backup is too large");
    const envelope=JSON.parse(text);
    if(envelope.format!=="ghostly-ark-encrypted" || envelope.version!==1)throw new Error("Unsupported Ark backup");
    const payload=decodeBackup(await unsealSeed(envelope.vault,password)) as {format:string;version:number;sdk:string;mnemonic:string;config:ArkConfig;database:ArkDatabaseSnapshot;intents:SavedIntent[]};
    if(payload.format!=="ghostly-ark" || payload.version!==1 || payload.sdk!=="0.4.74" || !validateMnemonic(payload.mnemonic,wordlist) || !Array.isArray(payload.intents))throw new Error("Invalid Ark backup payload");
    const config={...payload.config,walletId:crypto.randomUUID()};
    if(!ARK_NETWORKS.includes(config.network))throw new Error("Unsupported Ark network in backup");
    if(arkMode(config.network)!==this.network)throw new WrongNetworkError(arkMode(config.network),`This backup is a ${networkLabel(arkMode(config.network))} Ark wallet`);
    checkProviders(config.network,config.provider,config.explorer);
    if(payload.intents.some(i=>i.review.method!=="arkade" || i.review.provider!==config.provider || i.review.network!==config.network))throw new Error("Backup intents do not match its wallet");
    const deviceKey=newDeviceKey();
    const saved:StoredArk={config,seed:await sealSeed(payload.mnemonic,deviceKey),deviceKey};
    const replaced=this.saved && await this.retirable("Restore into a fresh profile or an unused wallet; this wallet will not be replaced");
    await restoreArkDatabase(config.walletId,payload.database);
    await this.save(saved,replaced||undefined,payload.intents.map(intent=>{
      // An older backup cannot prove an apparently pending attempt was never submitted.
      const state=["pending","submitted","unknown"].includes(intent.review.state)?"unknown":intent.review.state;
      return {...intent,review:{...intent.review,state}};
    }));
    this.saved=saved;
    this.view={configured:true,locked:true,automatic:true,balance:0,network:config.network,provider:config.provider};this.changed();
  });}
  /** Stopping ends it where it is: a wallet shutting down needs no balance. */
  async refresh() {await this.poll().catch(error=>{if(!(error instanceof ModeChanged))throw error;});}
  private async poll() {
    clearTimeout(this.timer);
    const adapter=this.adapter;
    if(!adapter)return;
    // Each part on its own: an address to receive on is useful even while the balance cannot be read.
    const failed:string[]=[];
    const read=async<T>(what:string,work:()=>Promise<T>,previous:T):Promise<T>=>{try{return await this.gate.within(work());}catch(error){if(error instanceof ModeChanged)throw error;failed.push(what);console.warn(`Ark ${what}:`,error instanceof Error?error.message:error);return previous;}};
    const address=await read("address",()=>adapter.address(),this.view.address);
    // Both addresses are this wallet's own; the rest asks an explorer, which can take a while.
    const boardingAddress=await read("boarding address",()=>adapter.boardingAddress(),this.view.boardingAddress);
    if(this.adapter!==adapter)return;
    if(address!==this.view.address||boardingAddress!==this.view.boardingAddress){this.view={...this.view,configured:true,locked:false,address,boardingAddress};this.changed();}
    const balance=await read("balance",()=>adapter.balance(),this.view.balance);
    const incoming=await read("incoming",()=>adapter.incoming(),this.view.incoming);
    const recoverable=await read("recoverable",()=>adapter.recoverable(),this.view.recoverable);
    if(this.adapter!==adapter)return;
    this.view={configured:true,locked:false,automatic:!!this.saved?.deviceKey,network:adapter.config.network,provider:adapter.config.provider,address,boardingAddress,incoming,balance,recoverable,
      error:failed.length?`Could not read the ${failed.join(", ")} from the Ark provider. Last values may be stale.`:undefined};
    this.changed();
    if(this.adapter)this.timer=setTimeout(()=>void this.refresh(),10000);
  }
  /** Expired outputs back into the balance; the next refresh shows them once the batch is done. */
  async recover():Promise<string> {const txid=await this.require().recover();await this.refresh();return txid;}
  async target():Promise<PaymentTarget> {const adapter=this.require();return {method:"arkade",network:adapter.config.network,provider:adapter.config.provider,asset:"BTC",unit:"sat",address:await adapter.requestAddress(),expiresAt:Date.now()+15*60*1000};}
  require() {if(!this.adapter)throw new Error("Unlock your Ark wallet or wait for it to connect");return this.adapter;}
  /**
   * The current wallet may make way for another network or a restore only while it has never paid or been paid
   * and holds nothing. It is archived, not deleted, so its seed survives a mistake.
   */
  private async retirable(refusal:string):Promise<StoredArk> {
    const saved=this.saved!;
    const intents=await wrap<SavedIntent[]>((await store(STORES.intents,"readonly")).getAll());
    if(intents.some(i=>this.ours(i)))throw new Error(refusal);
    if(this.adapter && await this.gate.within(this.adapter.balance())>0)throw new Error(refusal);
    await this.lock();
    return saved;
  }
  /** A payment of this wallet's network (the other network's wallet has its own). */
  private ours(intent:SavedIntent) {return intent.review.method==="arkade"&&arkMode(intent.review.network as ArkConfig["network"])===this.network;}
  private async save(saved:StoredArk,retired?:StoredArk,intents:SavedIntent[]=[]) {
    await transact([STORES.settings,STORES.intents],stores=>{
      if(retired)stores[STORES.settings].put(retired,`arkWallet-retired-${Date.now()}`);
      stores[STORES.settings].put(saved,this.key);
      for(const intent of intents)stores[STORES.intents].add(intent);
    });
  }
}
