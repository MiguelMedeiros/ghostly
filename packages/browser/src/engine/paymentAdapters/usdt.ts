import { mnemonicToSeedSync } from '@scure/bip39';
import WalletManagerEvm, { type WalletAccountEvm } from '@tetherto/wdk-wallet-evm';
import { Interface, Transaction, getAddress, keccak256 } from 'ethers';
import { ETHEREUM_USDT, EVM_TEST_CHAINS, SEPOLIA_TEST_USDT, SEPOLIA_TEST_USDT_FAUCET, TEST_USDT_FAUCET_AMOUNT, PaymentPreflightError, validatePaymentTarget, type PaymentAdapter, type PaymentExecution, type PaymentReview, type PaymentTarget } from '@ghostly/core';
import { sealSeed, unsealSeed, type EncryptedSeed } from './persistence';

export interface UsdtConfig {
  network: 'ethereum' | 'sepolia' | 'evm-local';
  provider: string;
  chainId: 1 | 11155111 | 31337;
  token: string;
  decimals: number;
  codeHash: string;
}
export interface UsdtPrepared {
  from: string; to: string; data: string; value: string; chainId: number; nonce: number;
  gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string;
  signed?: EncryptedSeed; hash?: string;
}
const faucet = new Interface(['function mint(address token,address to,uint256 amount) returns (uint256)']);
const erc20 = new Interface(['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const CONFIRMATIONS = 2;

/** Each chain's public RPC, which needs no key: the defaults, and what a request names as its `provider`. */
export const PUBLIC_USDT_RPC = { ethereum: 'https://ethereum.publicnode.com', sepolia: 'https://ethereum-sepolia-rpc.publicnode.com' } as const;

/**
 * The `provider` a request carries to the contact. Which RPC pays is the payer's own choice, so it names none of
 * this wallet's: a typed RPC URL may hold an API key (`/v3/<key>`), and every contact would read it. Older apps
 * require a URL here and pay only when it equals their own RPC, so it is the chain's public RPC (the default both
 * start with), and a local test chain's origin, without its path.
 */
export function wireProvider(config: Pick<UsdtConfig, 'network' | 'provider'>): string {
  return config.network === 'evm-local' ? new URL(config.provider).origin : PUBLIC_USDT_RPC[config.network];
}

/** WDK signs locally. Every network call uses the configured RPC, never a peer-supplied URL. */
export class UsdtAdapter implements PaymentAdapter<UsdtPrepared> {
  readonly method = 'usdt' as const;
  private manager?: WalletManagerEvm;
  private account?: WalletAccountEvm;
  private mnemonic = '';
  private nextId = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(readonly config: UsdtConfig) {}

  static async inspect(config: Omit<UsdtConfig, 'decimals' | 'codeHash'>): Promise<UsdtConfig> {
    if (config.network === 'ethereum' ? config.chainId !== 1 || !same(config.token, ETHEREUM_USDT) : !(config.network in EVM_TEST_CHAINS) || config.chainId !== EVM_TEST_CHAINS[config.network]) throw new Error('Unsupported USDT network or contract');
    const token = getAddress(config.token);
    const url = new URL(config.provider);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error('Use HTTPS or a loopback test RPC');
    const adapter = new UsdtAdapter({...config, token, decimals: 6, codeHash: ''});
    await adapter.chain();
    const code = await adapter.rpc<string>('eth_getCode', [token, 'latest']);
    if (code === '0x') throw new Error('No token contract exists on this chain');
    const result = await adapter.rpc<string>('eth_call', [{to: token, data: erc20.encodeFunctionData('decimals')}, 'latest']);
    const decimals = Number(erc20.decodeFunctionResult('decimals', result)[0]);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || (config.chainId === 1 && decimals !== 6)) throw new Error('Unexpected token decimals');
    return {...config, token, decimals, codeHash: keccak256(code)};
  }
  static async connect(config: UsdtConfig, mnemonic: string): Promise<UsdtAdapter> {
    const inspected = await UsdtAdapter.inspect(config);
    if (inspected.decimals !== config.decimals || inspected.codeHash !== config.codeHash) throw new Error('Token metadata changed; do not use this wallet configuration');
    const adapter = new UsdtAdapter(config);
    adapter.mnemonic = mnemonic;
    // Pass standard BIP-39 seed bytes: WDK's string helper assumes a Node Buffer global.
    const seed = mnemonicToSeedSync(mnemonic);
    try { adapter.manager = new WalletManagerEvm(seed, {provider: {request: ({method, params}) => adapter.rpc(method, params as unknown[] ?? [])}, chainId: config.chainId}); } finally { seed.fill(0); }
    adapter.account = await adapter.manager.getAccount(0);
    return adapter;
  }
  async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(this.config.provider, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:++this.nextId,method,params}), signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error('USDT RPC unavailable');
    const result = await response.json();
    if (result.error || !Object.prototype.hasOwnProperty.call(result, 'result')) throw new Error('USDT RPC rejected the operation');
    return result.result as T;
  }
  private async chain() {
    if (BigInt(await this.rpc<string>('eth_chainId')) !== BigInt(this.config.chainId)) throw new Error('RPC chain does not match this wallet');
  }
  private async assertToken() {
    await this.chain();
    const code = await this.rpc<string>('eth_getCode', [this.config.token, 'latest']);
    if (code === '0x' || keccak256(code) !== this.config.codeHash) throw new Error('Token contract changed');
  }
  /**
   * Sepolia only: asks Aave's public faucet for test USDT, to this wallet, paid with its own test ETH.
   * Everything is fixed here (chain, contract, token, amount, recipient): nothing comes from outside.
   */
  mintTestTokens(): Promise<string> { return this.serial(async () => {
    if (this.config.chainId !== EVM_TEST_CHAINS.sepolia || !same(this.config.token, SEPOLIA_TEST_USDT)) throw new Error('Test USDT comes from a faucet on Sepolia only');
    await this.chain();
    const account = this.current(), from = await account.getAddress();
    const data = faucet.encodeFunctionData('mint', [SEPOLIA_TEST_USDT, from, BigInt(TEST_USDT_FAUCET_AMOUNT)]);
    const nonce = Number(BigInt(await this.rpc<string>('eth_getTransactionCount', [from, 'pending'])));
    const estimate = BigInt(await this.rpc<string>('eth_estimateGas', [{ from, to: SEPOLIA_TEST_USDT_FAUCET, data, value: '0x0' }]));
    const block = await this.rpc<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false]);
    if (!block.baseFeePerGas) throw new Error('This wallet requires an EIP-1559 chain');
    const priority = BigInt(await this.rpc<string>('eth_maxPriorityFeePerGas'));
    const maxFeePerGas = BigInt(block.baseFeePerGas) * 2n + priority, gasLimit = (estimate * 120n + 99n) / 100n;
    if (BigInt((await this.balances()).gasBalance) < gasLimit * maxFeePerGas) throw new Error('This needs a little Sepolia ETH for gas first');
    const raw = await account.signTransaction({ type: 2, to: SEPOLIA_TEST_USDT_FAUCET, data, value: 0n, chainId: this.config.chainId, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas: priority });
    await account.sendTransaction(raw);
    return Transaction.from(raw).hash!;
  }); }
  private current(): WalletAccountEvm { if (!this.account) throw new Error('Unlock the USDT wallet first'); return this.account; }
  address() { return this.current().getAddress(); }
  async balances() {
    await this.assertToken();
    const address = await this.address();
    const [token, gas] = await Promise.all([this.rpc<string>('eth_call',[{to:this.config.token,data:erc20.encodeFunctionData('balanceOf',[address])},'latest']),this.rpc<string>('eth_getBalance',[address,'pending'])]);
    return {balance:erc20.decodeFunctionResult('balanceOf',token)[0].toString(),gasBalance:BigInt(gas).toString()};
  }
  async target(): Promise<PaymentTarget> {
    const now = Date.now();
    return {method:'usdt',network:this.config.network,provider:wireProvider(this.config),asset:this.config.chainId === 1 ? 'USDT':'TEST-USDT',unit:'token-base',address:await this.address(),chainId:this.config.chainId,token:this.config.token,decimals:this.config.decimals,issuedAt:now,expiresAt:now+15*60*1000};
  }
  /** The request is for this wallet's token on its chain. Its `provider` is not compared: this wallet's own RPC pays. */
  private matches(target: PaymentTarget) {
    validatePaymentTarget(target);
    if (target.method !== 'usdt' || target.network !== this.config.network || target.chainId !== this.config.chainId || !same(target.token!,this.config.token) || target.decimals !== this.config.decimals) throw new Error('Request does not match the configured token and network');
  }
  prepare(target: PaymentTarget, amount: number, feeCap: number) { return this.serial(async () => {
    this.matches(target);
    await this.assertToken();
    const from = await this.address(), to = this.config.token;
    if (same(target.address, from) || same(target.address, to)) throw new Error('Choose a different recipient address');
    const {balance,gasBalance} = await this.balances();
    if (BigInt(balance) < BigInt(amount)) throw new Error('Insufficient token balance');
    const data = erc20.encodeFunctionData('transfer', [getAddress(target.address),BigInt(amount)]);
    const nonce = Number(BigInt(await this.rpc<string>('eth_getTransactionCount',[from,'pending'])));
    if (!Number.isSafeInteger(nonce)) throw new Error('Invalid account nonce');
    const estimate = BigInt(await this.rpc<string>('eth_estimateGas',[{from,to,data,value:'0x0'}]));
    const block = await this.rpc<{baseFeePerGas?:string}>('eth_getBlockByNumber',['latest',false]);
    if (!block.baseFeePerGas) throw new Error('This wallet requires an EIP-1559 chain');
    const priority = BigInt(await this.rpc<string>('eth_maxPriorityFeePerGas'));
    const maxFee = BigInt(block.baseFeePerGas)*2n + priority;
    const gasLimit = (estimate*120n+99n)/100n;
    const maximum = gasLimit*maxFee;
    if (maximum > BigInt(feeCap) || maximum > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Estimated maximum gas exceeds your limit');
    if (BigInt(gasBalance) < maximum) throw new Error('Insufficient ETH for gas');
    const prepared:UsdtPrepared = {from,to,data,value:'0',chainId:this.config.chainId,nonce,gasLimit:gasLimit.toString(),maxFeePerGas:maxFee.toString(),maxPriorityFeePerGas:priority.toString()};
    return {fee:Number(maximum),prepared,evm:{from,nonce,gasLimit:prepared.gasLimit,maxFeePerGas:prepared.maxFeePerGas,maxPriorityFeePerGas:prepared.maxPriorityFeePerGas,confirmations:CONFIRMATIONS}};
  }); }
  private verifyPrepared(review: PaymentReview, tx: UsdtPrepared) {
    if (tx.chainId !== this.config.chainId || !same(tx.to,this.config.token) || tx.value !== '0' || tx.data !== erc20.encodeFunctionData('transfer',[getAddress(review.address),BigInt(review.amount)]) || BigInt(tx.gasLimit)*BigInt(tx.maxFeePerGas) !== BigInt(review.fee) || review.fee > review.feeCap || tx.nonce !== review.evm?.nonce || !same(tx.from,review.evm?.from ?? '')) throw new Error('Transaction no longer matches the approved review');
  }
  private verifySigned(raw: string, saved: UsdtPrepared) {
    const tx = Transaction.from(raw);
    if (!tx.hash || !tx.from || !same(tx.from,saved.from) || tx.chainId !== BigInt(saved.chainId) || !tx.to || !same(tx.to,saved.to) || tx.data !== saved.data || tx.value !== 0n || tx.nonce !== saved.nonce || tx.gasLimit !== BigInt(saved.gasLimit) || tx.maxFeePerGas !== BigInt(saved.maxFeePerGas) || tx.maxPriorityFeePerGas !== BigInt(saved.maxPriorityFeePerGas)) throw new Error('Signature does not match the approved transaction');
    return tx.hash;
  }
  execute(review: PaymentReview, prepared: UsdtPrepared, persist?:()=>Promise<void>) { return this.serial(async () => {
    let account:WalletAccountEvm;
    try {
      this.matches(review); this.verifyPrepared(review,prepared);
      await this.assertToken(); account=this.current();
      if (!same(await account.getAddress(),prepared.from)) throw new Error('Wrong wallet');
      const nonce = Number(BigInt(await this.rpc<string>('eth_getTransactionCount',[prepared.from,'pending'])));
      if (nonce !== prepared.nonce) throw new Error('Account nonce changed. Create a new review');
      const balances = await this.balances();
      if (BigInt(balances.balance)<BigInt(review.amount) || BigInt(balances.gasBalance)<BigInt(review.fee)) throw new Error('Token or gas balance changed. Create a new review');
      if (!persist) throw new Error('Durable payment journal required');
    } catch (error) { throw new PaymentPreflightError(error instanceof Error ? error.message : 'Could not validate payment'); }
    const raw = await account.signTransaction({type:2,to:prepared.to,data:prepared.data,value:0n,chainId:prepared.chainId,nonce:prepared.nonce,gasLimit:BigInt(prepared.gasLimit),maxFeePerGas:BigInt(prepared.maxFeePerGas),maxPriorityFeePerGas:BigInt(prepared.maxPriorityFeePerGas)});
    prepared.hash = this.verifySigned(raw,prepared);
    prepared.signed = await sealSeed(raw,this.mnemonic);
    await persist!(); // Nothing may broadcast before the encrypted bytes are durable.
    await account.sendTransaction(raw);
    return this.receipt(prepared.hash,review,prepared.from);
  }); }
  reconcile(review: PaymentReview, prepared: UsdtPrepared) { return this.serial(async () => {
    await this.assertToken(); this.verifyPrepared(review,prepared);
    if (!prepared.signed || !prepared.hash) return {settled:false,failed:true,error:'No signed transaction was submitted. Create a new review.'};
    const result = await this.receipt(prepared.hash,review,prepared.from);
    if (result.settled || result.failed || result.pending) return result;
    // An uncertain network response permits only replay of exactly the saved bytes.
    const nonce = Number(BigInt(await this.rpc<string>('eth_getTransactionCount',[prepared.from,'pending'])));
    if (nonce > prepared.nonce) return result;
    const raw = await unsealSeed(prepared.signed,this.mnemonic);
    if (this.verifySigned(raw,prepared) !== prepared.hash || !same(await this.address(),prepared.from)) throw new Error('Recovery wallet mismatch');
    await this.current().sendTransaction(raw);
    return this.receipt(prepared.hash,review,prepared.from);
  }); }
  async receipt(hash: string, target: PaymentTarget & {amount:number}, expectedFrom?:string): Promise<PaymentExecution> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash) || target.chainId !== this.config.chainId || !same(target.token ?? '',this.config.token) || target.decimals !== this.config.decimals) throw new Error('Invalid receipt target');
    await this.assertToken();
    const tx = await this.rpc<{from:string;to:string;input:string;value:string;nonce:string}|null>('eth_getTransactionByHash',[hash]);
    if (!tx) return {txid:hash,settled:false};
    if (!same(tx.to,this.config.token) || (expectedFrom && !same(tx.from,expectedFrom)) || BigInt(tx.value)!==0n || tx.input !== erc20.encodeFunctionData('transfer',[getAddress(target.address),BigInt(target.amount)])) throw new Error('Transaction is not the requested token transfer');
    const receipt = await this.rpc<{status:string;blockNumber:string;blockHash:string;logs:Array<{address:string;topics:string[];data:string}>}|null>('eth_getTransactionReceipt',[hash]);
    if (!receipt) return {txid:hash,settled:false,pending:true};
    const block = await this.rpc<{hash:string;timestamp:string}>('eth_getBlockByNumber',[receipt.blockNumber,false]);
    if (!block || block.hash !== receipt.blockHash || BigInt(block.timestamp)*1000n < BigInt((target.issuedAt ?? 0)-1000)) return {txid:hash,settled:false};
    const height = BigInt(await this.rpc<string>('eth_blockNumber'));
    if (height-BigInt(receipt.blockNumber)+1n < BigInt(CONFIRMATIONS)) return {txid:hash,settled:false,pending:true};
    if (BigInt(receipt.status)!==1n) return {txid:hash,settled:false,failed:true,error:'Transaction reverted. Tokens were not sent; gas was spent.'};
    const transfer = receipt.logs.some(log=>{
      if (!same(log.address,this.config.token)) return false;
      try {const event=erc20.parseLog(log);return event?.name==='Transfer' && same(event.args[0],tx.from) && same(event.args[1],target.address) && event.args[2]===BigInt(target.amount);} catch {return false;}
    });
    if (!transfer) throw new Error('Receipt has no matching token Transfer');
    return {txid:hash,settled:true};
  }
  async dispose() { await this.queue.catch(()=>{}); this.account=undefined;this.manager?.dispose();this.manager=undefined;this.mnemonic=''; }
  private serial<T>(work:()=>Promise<T>):Promise<T> { const operation=this.queue.then(work,work);this.queue=operation.catch(()=>{});return operation; }
}
