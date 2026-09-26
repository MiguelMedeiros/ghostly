import {useState} from 'react';
import {ETHEREUM_USDT,SEPOLIA_TEST_USDT,formatPaymentAmount,parsePaymentAmount,type PaymentReview as Review} from '@ghostly/core';
import type {WalletPlatform,WalletState} from '../lib/platform';
import {PaymentReview} from './PaymentReview';
import {BackupRows} from './wallet/BackupRows';
import {Actions,Address,Amount,Block,Button,Notice,Row,Section,Segmented,input,type Action} from './wallet/ui';
import {useRun} from './wallet/run';
import {ButtonGroup,InputGroup,Truncate} from './layout';

type Network='ethereum'|'sepolia'|'evm-local';
const RPC:Record<Network,string>={ethereum:'https://ethereum.publicnode.com',sepolia:'https://ethereum-sepolia-rpc.publicnode.com','evm-local':'http://127.0.0.1:47070'};
const TOKEN:Record<Network,string>={ethereum:ETHEREUM_USDT,sepolia:SEPOLIA_TEST_USDT,'evm-local':''};
const PLACE:Record<Network,string>={ethereum:'Ethereum',sepolia:'Sepolia','evm-local':'this local chain'};
export function UsdtWalletPanel({wallet,state}:{wallet:WalletPlatform;state:WalletState}) {
 const usdt=state.usdt;
 const {busy,error,run}=useRun();
 const [action,setAction]=useState<Action>('receive');
 const [recipient,setRecipient]=useState(''),[amount,setAmount]=useState(''),[gas,setGas]=useState('0.001'),[review,setReview]=useState<Review|null>(null);
 const [password,setPassword]=useState('');
 /** A network being set up that needs more than a click: a local chain has no well-known token. */
 const [pending,setPending]=useState<Network|null>(null),[provider,setProvider]=useState(''),[token,setToken]=useState('');
 const label=usdt?.chainId&&usdt.chainId!==1?'TEST-USDT':'USDT';
 const network:Network=usdt?.network??'ethereum';
 const ready=!!usdt?.configured&&!usdt.locked;
 const intents=(state.intents??[]).filter(i=>i.method==='usdt');
 const stuck=!!usdt?.configured&&!!usdt.automatic&&!ready;
 const canReplace=intents.length===0&&(stuck||(ready&&BigInt(usdt.balance)===0n&&BigInt(usdt.gasBalance)===0n));
 const funded=ready&&BigInt(usdt.balance)>0n;
 const use=(next:Network,params:{provider?:string;token?:string;mnemonic?:string}={})=>wallet.usdtCreate({network:next,provider:params.provider??RPC[next],token:params.token??TOKEN[next],mnemonic:params.mnemonic});
 /** Back to the network in use only closes the form; a network that needs a token contract asks for it first. */
 const choose=(next:Network)=>{setPending(null);if(next===network)return;if(next==='ethereum')void run(()=>use('ethereum'));else{setPending(next);setProvider(RPC[next]);setToken(TOKEN[next]);}};

 return <div className="space-y-6" data-testid="usdt-wallet" aria-label="USDT wallet">
  {!usdt?.configured||(usdt.locked&&usdt.automatic)?<div className="bg-surface rounded-xl p-6 text-center space-y-2" data-testid="usdt-connecting"><p className="text-text-primary">Connecting your USDT wallet…</p><Notice>{usdt?.error??'This takes a few seconds the first time.'}</Notice></div>
  :!ready?<Section title="Unlock"><Row label="This wallet was created with a password"/><Block><InputGroup><input aria-label="USDT wallet password" type="password" autoComplete="current-password" className={input} value={password} onChange={e=>setPassword(e.target.value)}/><Button variant="primary" disabled={busy} onClick={()=>void run(async()=>{await wallet.usdtUnlock(password);setPassword('');})}>Unlock USDT</Button></InputGroup></Block></Section>
  :<div className="space-y-4">
   <div>
    <p className="text-text-primary break-words" data-testid="usdt-balance"><span className="text-4xl font-semibold tabular-nums">{formatPaymentAmount(usdt.balance,usdt.decimals)}</span> <span className="text-text-muted text-sm">{label}</span></p>
    <p className="mt-1 text-xs text-text-muted" data-testid="usdt-gas">{formatPaymentAmount(usdt.gasBalance,18)} ETH for network fees</p>
    {usdt.chainId!==1&&<p className="mt-1 text-xs text-yellow-500">{PLACE[network]==='Sepolia'?'Sepolia test network':'Local test chain'} · worthless token, not issued by Tether</p>}
   </div>
   <Actions value={action} onChange={setAction}/>
   {action==='receive'&&<div className="bg-surface rounded-xl p-4 animate-fade-in"><Address value={usdt.address} qr={usdt.address ? `ethereum:${usdt.address}@${usdt.chainId}` : undefined} testId="usdt-address" note={`Only ${label} on ${PLACE[network]}. Incoming transfers show up by themselves.`}/></div>}
   {action==='send'&&<div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
    <input aria-label="USDT recipient address" placeholder="Recipient address (0x…)" spellCheck={false} className={`${input} font-mono text-xs`} value={recipient} onChange={e=>setRecipient(e.target.value.trim())}/>
    <Amount value={amount} onChange={setAmount} unit={label} decimals={usdt.decimals}/>
    <label className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-sm text-text-secondary">Network fee limit<span className="flex items-center gap-2"><input aria-label="Maximum gas in ETH" inputMode="decimal" className={`${input} w-28 text-right`} value={gas} onChange={e=>setGas(e.target.value.replace(/[^0-9.]/g,''))}/>ETH</span></label>
    <Button variant="primary" className="w-full" disabled={busy||!!review||!funded||!recipient||!Number(amount)} onClick={()=>void run(async()=>{const now=Date.now();setReview(await wallet.preparePayment({target:{method:'usdt',network:usdt.network!,provider:usdt.provider!,asset:usdt.chainId===1?'USDT':'TEST-USDT',unit:'token-base',address:recipient,token:usdt.token,decimals:usdt.decimals,chainId:usdt.chainId,issuedAt:now,expiresAt:now+15*60*1000},amount:parsePaymentAmount(amount,usdt.decimals!),feeCap:parsePaymentAmount(gas,18),payee:recipient}));})}>{funded?'Review payment':'No balance to send yet'}</Button>
    <Notice>{BigInt(usdt.gasBalance)===0n?'Sending needs a little ETH at this same address to pay the network fee.':'Nothing is sent until you approve the review.'}</Notice>
   </div>}
   {review&&<PaymentReview key={review.id} review={review} wallet={wallet} onClose={()=>setReview(null)}/>}
   {intents.filter(i=>i.id!==review?.id).map(i=><Button key={i.id} className="block w-full text-left" onClick={()=>setReview(i)}>{formatPaymentAmount(i.amount,i.decimals)} {i.asset} · {i.state==='settled'?'confirmed':i.state}</Button>)}
  </div>}
  {error&&<Notice tone="error">{error}</Notice>}
  {usdt?.error&&ready&&<Notice tone="warning">{usdt.error}</Notice>}
  {/* Test USDT from Aave's Sepolia faucet: "Get test coins" above the panel (wallet/TestCoins.tsx). */}

  {(ready||stuck)&&<Section title="Settings">
   {/* A Mainnet wallet is Ethereum only; a Testnet wallet may move between the test chains while empty. */}
   {state.mode==='testnet'&&<Row label="Network" hint={stuck?'This network is not answering. You can switch to another one.':canReplace?'Sepolia and the local chain carry worthless test tokens.':'Only while this wallet is empty and has no payments.'}>
    <Segmented label="USDT network" value={pending??network} disabled={busy||!canReplace} options={[{value:'sepolia',label:'Sepolia'},{value:'evm-local',label:'Local test chain'}]} onChange={choose}/>
   </Row>}
   {pending&&<Block>
    <input aria-label="RPC URL" className={`${input} font-mono text-xs`} value={provider} onChange={e=>setProvider(e.target.value)} spellCheck={false}/>
    <input aria-label="Token contract" placeholder="Token contract (0x…)" className={`${input} font-mono text-xs`} value={token} onChange={e=>setToken(e.target.value.trim())} spellCheck={false}/>
    <ButtonGroup><Button variant="primary" disabled={busy||!token} onClick={()=>void run(async()=>{await use(pending,{provider,token});setPending(null);})}>Switch network</Button><Button onClick={()=>setPending(null)}>Cancel</Button></ButtonGroup>
   </Block>}
   {ready&&<><Row label="RPC provider" hint={<><Truncate className="font-mono">{usdt.provider??''}</Truncate>Sees your public address</>}/>
   <Row label="Token" hint={<><Truncate className="font-mono">{usdt.token??''}</Truncate>{`${usdt.decimals} decimals${usdt.chainId===1?' · Tether can freeze USDT':''}`}</>}/>
   <BackupRows name="USDT" busy={busy} run={run} canReplace={canReplace}
    reveal={()=>wallet.usdtReveal()} exportBackup={pw=>wallet.usdtExportBackup(pw)}
    restorePhrase={mnemonic=>use(network,{provider:usdt.provider,token:usdt.token,mnemonic})} restoreFile={(text,pw)=>wallet.usdtRestoreBackup(text,pw)}/></>}
  </Section>}
 </div>;
}
