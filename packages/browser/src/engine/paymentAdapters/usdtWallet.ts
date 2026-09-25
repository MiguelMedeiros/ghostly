import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { ETHEREUM_USDT, EVM_TEST_CHAINS, SEPOLIA_TEST_USDT, type WalletNetwork } from '@ghostly/core';
import type { WalletMode } from '../../shared/mints';
import { ModeChanged, ModeGate, WrongNetworkError, networkLabel } from './modeGate';
import { walletKey } from './walletNetworks';
import { STORES, store, transact, wrap } from '../../shared/idb';
import { UsdtAdapter, type UsdtConfig } from './usdt';
import { intentRepository, newDeviceKey, sealSeed, unsealSeed, type EncryptedSeed } from './persistence';
import type { SavedIntent } from './coordinator';

export interface UsdtWalletView {
  configured:boolean; locked:boolean; automatic?:boolean; network?:UsdtConfig['network']; provider?:string;
  chainId?:number; token?:string; decimals?:number; address?:string;
  balance:string; gasBalance:string; error?:string;
}
export interface UsdtCreate {network:UsdtConfig['network'];provider:string;token:string;password?:string;mnemonic?:string}
/** Every new profile starts with this wallet: an address to receive on, nothing to set up. */
export const DEFAULT_USDT = {network:'ethereum',provider:'https://ethereum.publicnode.com',token:ETHEREUM_USDT} as const satisfies Omit<UsdtCreate,'password'|'mnemonic'>;
/** A Testnet USDT wallet starts on Sepolia, with Aave's test USDT (anyone can mint it from their faucet). */
export const TESTNET_USDT = {network:'sepolia',provider:'https://ethereum-sepolia-rpc.publicnode.com',token:SEPOLIA_TEST_USDT} as const satisfies Omit<UsdtCreate,'password'|'mnemonic'>;
/** Ethereum carries real USDT; Sepolia and a local chain carry worthless test tokens. */
export const usdtMode=(network:UsdtConfig['network']):WalletMode=>network==='ethereum'?'mainnet':'testnet';
/** A wallet with a device key opens by itself; one sealed with a password (older profiles) waits for it. */
interface SavedWallet {config:UsdtConfig;seed:EncryptedSeed;deviceKey?:string}
/** The defaults a new wallet of this network is made with, in one click. */
export const usdtDefaults=(network:WalletNetwork)=>network==='testnet'?TESTNET_USDT:DEFAULT_USDT;
/** The USDT wallet of one network: Mainnet's and Testnet's are both open at once, each under its own key. */
export class UsdtWallet {
  private readonly key:string;
  private saved?:SavedWallet;
  private epoch = 0;
  private timer?:ReturnType<typeof setTimeout>;
  private retry?:ReturnType<typeof setTimeout>;
  private readying?:Promise<void>;
  private stopped = false;
  private queue:Promise<unknown> = Promise.resolve();
  private gate=new ModeGate();
  adapter?:UsdtAdapter;
  view:UsdtWalletView={configured:false,locked:true,balance:'0',gasBalance:'0'};
  constructor(readonly network:WalletNetwork,private changed:()=>void) {this.key=walletKey('usdtWallet',network);}
  /** Creating, replacing and restoring never interleave: two of them could each think the profile is empty. */
  private serial<T>(run:()=>Promise<T>):Promise<T> {const next=this.queue.then(run,run);this.queue=next.catch(()=>{});return next;}
  async start() {this.saved=await wrap<SavedWallet|undefined>((await store(STORES.settings,'readonly')).get(this.key));this.view={...this.view,configured:!!this.saved,automatic:!!this.saved?.deviceKey,...this.saved?.config,locked:true};}
  /**
   * Opens the wallet when it needs no password; `create`: makes the default one first when there is none. Retries
   * while the RPC is unreachable.
   */
  ensureReady(create=false):Promise<void> {
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
      this.view={...this.view,error:`Connecting to Ethereum… ${error instanceof Error?error.message:''}`.trim()};this.changed();
      this.retry=setTimeout(()=>void this.ensureReady(create),30000);
    }
  }
  private createDefault() {return this.serial(async()=>{if(!this.saved)await this.createNow({...usdtDefaults(this.network)});});}
  /** A wallet of this network on its default chain and RPC, made now: it answers first, or nothing is saved. */
  createDefaultNow() {return this.serial(async()=>{if(this.saved)throw new Error(`There is already a ${networkLabel(this.network)} USDT wallet`);await this.createNow({...usdtDefaults(this.network)});});}
  get configured() {return !!this.saved;}
  /** A creation waiting on its RPC gives up now, saving nothing. */
  cutShort() {this.gate.interrupt();}
  create(params:UsdtCreate) {return this.serial(()=>this.createNow(params));}
  private async createNow(params:UsdtCreate) {
    if(usdtMode(params.network)!==this.network)throw new WrongNetworkError(usdtMode(params.network),`${params.network==='ethereum'?'Ethereum':params.network} is a ${networkLabel(usdtMode(params.network))} network: this is the ${networkLabel(this.network)} USDT wallet`);
    const mnemonic=params.mnemonic?.trim() || generateMnemonic(wordlist);
    if(!validateMnemonic(mnemonic,wordlist))throw new Error('Invalid recovery phrase');
    const deviceKey=params.password?undefined:newDeviceKey();
    const seed=await sealSeed(mnemonic,params.password??deviceKey!);
    const config=await this.gate.within(UsdtAdapter.inspect({network:params.network,chainId:params.network==='ethereum'?1:EVM_TEST_CHAINS[params.network],provider:params.provider.replace(/\/$/,''),token:params.token}));
    const replaced=this.saved && await this.retirable('This USDT wallet already has funds or payments; it will not be replaced');
    const saved:SavedWallet={config,seed,deviceKey};
    const epoch=++this.epoch;
    let adapter:UsdtAdapter|undefined;
    try {adapter=await this.gate.within(UsdtAdapter.connect(config,mnemonic),a=>a.dispose());await this.save(saved,replaced||undefined);}
    catch(error){await adapter?.dispose();if(replaced)void this.ensureReady();throw error;}
    this.saved=saved;
    if(epoch!==this.epoch){await adapter!.dispose();this.view={configured:true,locked:true,automatic:!!deviceKey,...config,balance:'0',gasBalance:'0'};this.changed();return;}
    this.adapter=adapter;await this.refresh();
  }
  async unlock(password?:string) {
    if(!this.saved)throw new Error('Create a USDT wallet first');
    if(this.adapter)return;
    const key=this.saved.deviceKey??password;
    if(!key)throw new Error('Enter the USDT wallet password');
    const epoch=++this.epoch;const mnemonic=await unsealSeed(this.saved.seed,key);const adapter=await this.gate.within(UsdtAdapter.connect(this.saved.config,mnemonic),a=>a.dispose());
    if(epoch!==this.epoch){await adapter.dispose();return;}
    this.adapter=adapter;await this.refresh();
  }
  /** Shutting down: nothing reconnects afterwards. */
  async stop() {this.stopped=true;this.gate.close();await this.serial(()=>this.lock());}
  async lock() {++this.epoch;clearTimeout(this.timer);clearTimeout(this.retry);const adapter=this.adapter;this.adapter=undefined;this.view={...this.view,locked:true};this.changed();await adapter?.dispose();}
  /** Stopping ends it where it is: a wallet shutting down needs no balance. */
  async refresh() {
    clearTimeout(this.timer);const adapter=this.adapter;if(!adapter)return;
    try {const address=await this.gate.within(adapter.address()),balances=await this.gate.within(adapter.balances());if(adapter!==this.adapter)return;this.view={configured:true,locked:false,automatic:!!this.saved?.deviceKey,...adapter.config,address,...balances};}
    catch(error) {if(error instanceof ModeChanged||adapter!==this.adapter)return;this.view={...this.view,error:'RPC unavailable. Balance may be stale.'};}
    this.changed();if(this.adapter)this.timer=setTimeout(()=>void this.refresh(),8000);
  }
  /** Testnet on Sepolia: 1,000 TEST-USDT from Aave's faucet, paid with this wallet's own test ETH. */
  async getTestTokens():Promise<string> {const hash=await this.require().mintTestTokens();void this.refresh();return hash;}
  require() {if(!this.adapter)throw new Error('Unlock your USDT wallet or wait for it to connect');return this.adapter;}
  target() {return this.require().target();}
  async reveal(password?:string) {if(!this.saved)throw new Error('No USDT wallet');return unsealSeed(this.saved.seed,this.saved.deviceKey??password??'');}
  /** The backup file is always sealed with a password the person chooses, even for a wallet that opens by itself. */
  async exportBackup(password:string) {
    if(!this.saved)throw new Error('No USDT wallet to back up');
    if(password.length<12)throw new Error('Use at least 12 characters for the backup password');
    const mnemonic=await this.reveal(password);
    const intents=(await intentRepository.list()).filter(i=>this.ours(i));
    const plaintext=JSON.stringify({format:'ghostly-usdt',version:1,config:this.saved.config,mnemonic,intents});
    return JSON.stringify({format:'ghostly-usdt-encrypted',version:1,vault:await sealSeed(plaintext,password)});
  }
  restoreBackup(text:string,password:string):Promise<void> {return this.serial(async()=>{
    if(text.length>16*1024*1024)throw new Error('Backup is too large');
    const envelope=JSON.parse(text);
    if(envelope.format!=='ghostly-usdt-encrypted'||envelope.version!==1)throw new Error('Unsupported USDT backup');
    const payload=JSON.parse(await unsealSeed(envelope.vault,password)) as {format:string;version:number;config:UsdtConfig;mnemonic:string;intents:SavedIntent[]};
    if(payload.format!=='ghostly-usdt'||payload.version!==1||!validateMnemonic(payload.mnemonic,wordlist)||!Array.isArray(payload.intents))throw new Error('Invalid USDT backup');
    if(usdtMode(payload.config.network)!==this.network)throw new WrongNetworkError(usdtMode(payload.config.network),`This backup is a ${networkLabel(usdtMode(payload.config.network))} USDT wallet`);
    const config=await UsdtAdapter.inspect(payload.config);
    if(config.codeHash!==payload.config.codeHash||config.decimals!==payload.config.decimals||payload.intents.some(i=>i.review.method!=='usdt'||i.review.chainId!==config.chainId||i.review.token?.toLowerCase()!==config.token.toLowerCase()))throw new Error('Backup token or network mismatch');
    const deviceKey=newDeviceKey();
    const saved:SavedWallet={config,seed:await sealSeed(payload.mnemonic,deviceKey),deviceKey};
    const replaced=this.saved && await this.retirable('Restore into a fresh profile or an unused wallet; this wallet will not be replaced');
    await this.save(saved,replaced||undefined,payload.intents.map(intent=>({...intent,review:{...intent.review,state:['pending','submitted','unknown'].includes(intent.review.state)?'unknown':intent.review.state}})));
    this.saved=saved;this.view={configured:true,locked:true,automatic:true,...config,balance:'0',gasBalance:'0'};this.changed();
  });}
  /**
   * The current wallet may make way for another network or a restore only while it has never paid or been paid
   * and holds neither tokens nor gas. It is archived, not deleted, so its seed survives a mistake.
   */
  private async retirable(refusal:string):Promise<SavedWallet> {
    const saved=this.saved!;
    if((await intentRepository.list()).some(i=>this.ours(i)))throw new Error(refusal);
    if(this.adapter){const {balance,gasBalance}=await this.gate.within(this.adapter.balances());if(BigInt(balance)>0n||BigInt(gasBalance)>0n)throw new Error(refusal);}
    await this.lock();
    return saved;
  }
  /** A payment of this wallet's network (the other network's wallet has its own). */
  private ours(intent:SavedIntent) {return intent.review.method==='usdt'&&usdtMode(intent.review.network as UsdtConfig['network'])===this.network;}
  private async save(saved:SavedWallet,retired?:SavedWallet,intents:SavedIntent[]=[]) {
    await transact([STORES.settings,STORES.intents],s=>{
      if(retired)s[STORES.settings].put(retired,`usdtWallet-retired-${Date.now()}`);
      s[STORES.settings].put(saved,this.key);
      for(const intent of intents)s[STORES.intents].add(intent);
    });
  }
}
