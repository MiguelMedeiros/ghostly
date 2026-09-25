import { useState } from "react";
import { SPARK_PROVIDER, sparkAddressKind, sparkInvoiceDetails, type PaymentReview as Review } from "@ghostly/core";
import type { WalletPlatform, WalletState } from "../lib/platform";
import { PaymentReview } from "./PaymentReview";
import { BackupRows } from "./wallet/BackupRows";
import { Actions, Address, Amount, Block, Button, Notice, Row, Section, input, type Action } from "./wallet/ui";
import { useRun } from "./wallet/run";
import { pageUnit } from "./walletCardData";

/** Spark transfers cost nothing today; the cap only stops a surprise, and the review shows the real fee. */
const feeCap = (amount: number) => Math.max(100, Math.ceil(amount / 100));
const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

/**
 * Spark: wallet to wallet, instant and off-chain, through the Breez SDK. Its address is the wallet's identity, the
 * same every time; a chat request is paid on a Spark invoice made for it instead.
 */
export function SparkWalletPanel({ wallet, state }: { wallet: WalletPlatform; state: WalletState }) {
 const spark = state.spark;
 const { busy, error, run } = useRun();
 const [action, setAction] = useState<Action>("receive");
 const [to, setTo] = useState(""), [amount, setAmount] = useState(""), [review, setReview] = useState<Review | null>(null);
 const [apiKey, setApiKey] = useState("");
 const network = spark?.network ?? (state.mode === "testnet" ? "regtest" : "bitcoin");
 const mainnet = network === "bitcoin";
 const unit = pageUnit(state, !mainnet);
 const ready = !!spark?.configured && !spark.locked;
 const intents = (state.intents ?? []).filter(i => i.method === "spark");
 const canReplace = intents.length === 0 && ready && !spark.balance && !spark.history?.length;
 const kind = to ? sparkAddressKind(to, network) : undefined;
 // An invoice names its amount (Spark checks it again at review): it is not asked for.
 const invoice = kind === "invoice" ? sparkInvoiceDetails(to, network) : undefined;
 const sats = invoice?.amount ?? Number(amount);
 const breezIsLightning = state.lightning?.providerId === "breez";

 if (spark?.needsKey) return <div className="space-y-4" data-testid="spark-wallet">
  <div className="bg-surface rounded-xl p-6 space-y-3" data-testid="spark-needs-key">
   <p className="text-text-primary">Spark on Mainnet</p>
   <Notice tone="warning">Mainnet moves real bitcoin. Spark on Mainnet needs a Breez API key (free, from Breez), kept sealed on this device.</Notice>
   <input aria-label="Breez API key" type="password" autoComplete="off" spellCheck={false} placeholder="Breez API key" className={`${input} font-mono text-xs`} value={apiKey} onChange={e => setApiKey(e.target.value)} />
   <Button variant="primary" className="w-full" data-testid="spark-mainnet-create" disabled={busy || !apiKey.trim()} onClick={() => void run(async () => { await wallet.sparkCreate({ network: "bitcoin", apiKey }); setApiKey(""); })}>Open a Mainnet Spark wallet</Button>
   <Notice>Or switch the wallets to Testnet: Spark there runs on regtest, with worthless sats and no key.</Notice>
  </div>
  {error && <Notice tone="error">{error}</Notice>}
 </div>;

 return <div className="space-y-6" data-testid="spark-wallet">
  {!ready ? <div className="bg-surface rounded-xl p-6 text-center space-y-2" data-testid="spark-connecting"><p className="text-text-primary">Connecting your Spark wallet…</p><Notice>{spark?.error ?? "The first time loads the Breez SDK and opens a wallet on Spark."}</Notice></div>
  : <div className="space-y-4">
   <p className="text-text-primary" data-testid="spark-balance"><span className="text-4xl font-semibold tabular-nums">{spark.balance.toLocaleString()}</span><span className="text-text-muted text-sm ml-2">{unit}</span>
    {mainnet ? <span className="block text-xs text-danger mt-1" data-testid="spark-mainnet-label">Mainnet · real bitcoin on Spark</span> : <span className="block text-xs text-yellow-500 mt-1">Regtest · Breez's test Spark · worthless sats</span>}</p>
   <Actions value={action} onChange={setAction} />
   {action === "receive" && <div className="bg-surface rounded-xl p-4 space-y-4 animate-fade-in">
    <Address value={spark.address} testId="spark-address" note="From any Spark wallet on the same network: instant, no Lightning hop. It is this wallet's address, the same every time." />
   </div>}
   {action === "send" && <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
    <input aria-label="Spark address or invoice" placeholder={`Spark address or invoice (${mainnet ? "spark1…" : "sparkrt1…"})`} spellCheck={false} className={`${input} font-mono text-xs`} value={to} onChange={e => setTo(e.target.value.trim())} />
    {to && (!kind || invoice?.token) && <Notice tone="warning" testId="spark-address-invalid">{invoice?.token ? "That Spark invoice is for a token, not sats." : `That is not a Spark ${mainnet ? "Mainnet" : "regtest"} address or invoice.`}</Notice>}
    {invoice && !invoice.token && invoice.amount !== undefined ? <p className="text-sm text-text-primary" data-testid="spark-invoice-summary">Invoice for <span className="font-semibold tabular-nums">{invoice.amount.toLocaleString()}</span> {unit}{invoice.memo ? ` · ${invoice.memo}` : ""}</p>
     : <Amount value={amount} onChange={setAmount} unit={unit} testId="spark-amount" />}
    <Button variant="primary" className="w-full" data-testid="spark-review" disabled={busy || !!review || !spark.balance || !kind || !!invoice?.token || !sats} onClick={() => void run(async () => {
     setReview(await wallet.preparePayment({ target: { method: "spark", network, provider: SPARK_PROVIDER, asset: "BTC", unit: "sat", address: to, expiresAt: Date.now() + 5 * 60 * 1000 }, amount: sats, feeCap: feeCap(sats), payee: to }));
    })}>{spark.balance ? "Review payment" : "No balance to send yet"}</Button>
    <Notice>Nothing leaves before you approve. Spark addresses and invoices only; a Lightning invoice goes through the Lightning card.</Notice>
   </div>}
   {review && <PaymentReview key={review.id} review={review} wallet={wallet} onClose={() => { setReview(null); setTo(""); setAmount(""); }} />}
   {intents.filter(i => i.id !== review?.id && i.state !== "settled").map(i => <Button key={i.id} className="block w-full text-left" onClick={() => setReview(i)}>{i.amount.toLocaleString()} sats · {i.state}</Button>)}
   {!!spark.history?.length && <Section title="History">
    <ul className="divide-y divide-border" data-testid="spark-history">
     {spark.history.map(entry => <li key={entry.id} className="flex items-center gap-3 py-2 text-sm" data-testid="spark-history-row">
      <span className={entry.direction === "in" ? "text-green-500" : "text-text-primary"}>{entry.direction === "in" ? "+" : "−"}{entry.amount.toLocaleString()}</span>
      <span className="flex-1 min-w-0 truncate text-text-muted text-xs">{entry.via === "spark" ? "Spark" : entry.via === "lightning" ? "Lightning" : entry.via === "onchain" ? "On-chain" : "Other"}{entry.memo ? ` · ${entry.memo}` : ""}{entry.status !== "completed" ? ` · ${entry.status}` : ""}{entry.fee ? ` · fee ${entry.fee}` : ""}</span>
      <span className="text-text-muted text-xs tabular-nums">{when(entry.at)}</span>
     </li>)}
    </ul>
   </Section>}
  </div>}
  {error && <Notice tone="error">{error}</Notice>}
  {spark?.error && ready && <Notice tone="warning">{spark.error}</Notice>}

  {ready && <Section title="Settings">
   <Row label="Network" hint={mainnet ? "Bitcoin, through Breez (your API key)" : "Regtest, run by Breez and Lightspark: test sats only"}><span className="text-sm text-text-secondary">{mainnet ? "Mainnet" : "Regtest"}</span></Row>
   {!mainnet && <Row label="Lightning" hint={breezIsLightning ? "Breez (Spark) is your Lightning source: with this wallet's phrase, one wallet behind both cards" : "Pay and receive Lightning invoices with this same wallet (one phrase, one balance)"}>
    {breezIsLightning ? <span className="text-sm text-text-secondary" data-testid="spark-lightning-on">In use</span>
     : <Button data-testid="spark-use-lightning" disabled={busy} onClick={() => void run(() => wallet.sparkUseForLightning())}>Use for Lightning too</Button>}
   </Row>}
   <BackupRows name="Spark" busy={busy} run={run} canReplace={canReplace}
    reveal={async () => (await wallet.sparkBackup()).mnemonic} exportBackup={pw => wallet.sparkExportBackup(pw)}
    restorePhrase={mnemonic => wallet.sparkCreate({ network, mnemonic })} restoreFile={(text, pw) => wallet.sparkRestoreBackup(text, pw)} />
   <Block><Notice>Spark's operators hold nothing of yours: the phrase brings the sats back in any Spark wallet. Payment history comes from the backup file.</Notice></Block>
  </Section>}
 </div>;
}
