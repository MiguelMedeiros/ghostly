import { useState } from "react";
import { SPARK_PROVIDER, sparkAddressKind, sparkInvoiceDetails, type PaymentReview as Review } from "@ghostly/core";
import type { WalletPlatform, WalletState } from "../lib/platform";
import { PaymentReview } from "./PaymentReview";
import { paymentStateLabel } from "./paymentWords";
import { BackupRows } from "./wallet/BackupRows";
import { Actions, Address, Amount, Block, Button, Notice, Row, Section, input, type Action } from "./wallet/ui";
import { useRun } from "./wallet/run";
import { useI18n } from "../contexts/I18nContext";
import { satsIn } from "./NetworkTag";
import { fillNodes } from "../lib/fillNodes";
import { formatAmount } from "../lib/amount";
import { formatAt } from "../lib/time";

/** Spark transfers cost nothing today; the cap only stops a surprise, and the review shows the real fee. */
const feeCap = (amount: number) => Math.max(100, Math.ceil(amount / 100));
const WHEN: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "short" };

/**
 * Spark: wallet to wallet, instant and off-chain, through the Breez SDK. Its address is the wallet's identity, the
 * same every time; a chat request is paid on a Spark invoice made for it instead.
 */
export function SparkWalletPanel({ wallet, state, backupNow = false }: { wallet: WalletPlatform; state: WalletState; backupNow?: boolean }) {
 const spark = state.spark;
 const { t } = useI18n();
 const { busy, error, run } = useRun();
 const [action, setAction] = useState<Action>("receive");
 const [to, setTo] = useState(""), [amount, setAmount] = useState(""), [review, setReview] = useState<Review | null>(null);
 const [apiKey, setApiKey] = useState("");
 const network = spark?.network ?? (state.mode === "testnet" ? "regtest" : "bitcoin");
 const mainnet = network === "bitcoin";
 const unit = satsIn(t, mainnet ? "mainnet" : "testnet");
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
   <p className="text-text-primary">{t("wallet.spark.mainnetTitle")}</p>
   <Notice tone="warning">{t("wallet.spark.mainnetWarning")}</Notice>
   <input aria-label={t("wallet.spark.apiKey")} type="password" autoComplete="off" spellCheck={false} placeholder={t("wallet.spark.apiKey")} className={`${input} font-mono text-xs`} value={apiKey} onChange={e => setApiKey(e.target.value)} />
   <Button variant="primary" className="w-full" data-testid="spark-mainnet-create" disabled={busy || !apiKey.trim()} onClick={() => void run(async () => { await wallet.sparkCreate({ network: "bitcoin", apiKey }); setApiKey(""); })}>{t("wallet.spark.openMainnet")}</Button>
   <Notice>{t("wallet.spark.orTestnet")}</Notice>
  </div>
  {error && <Notice tone="error">{error}</Notice>}
 </div>;

 return <div className="space-y-6" data-testid="spark-wallet">
  {!ready ? <div className="bg-surface rounded-xl p-6 text-center space-y-2" data-testid="spark-connecting"><p className="text-text-primary">{t("wallet.panel.connecting", { wallet: "Spark" })}</p><Notice>{spark?.error ?? t("wallet.spark.connectingNote")}</Notice></div>
  : <div className="space-y-4">
   <p className="text-text-primary" data-testid="spark-balance"><span className="text-4xl font-semibold tabular-nums">{formatAmount(spark.balance, t.language)}</span><span className="text-text-muted text-sm ms-2">{unit}</span>
    {mainnet ? <span className="block text-xs text-danger mt-1" data-testid="spark-mainnet-label">{t("wallet.spark.mainnetLabel")}</span> : <span className="block text-xs text-yellow-500 mt-1">{t("wallet.spark.regtestLabel")}</span>}</p>
   <Actions value={action} onChange={setAction} />
   {action === "receive" && <div className="bg-surface rounded-xl p-4 space-y-4 animate-fade-in">
    <Address value={spark.address} testId="spark-address" note={t("wallet.spark.addressNote")} />
   </div>}
   {action === "send" && <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
    <input aria-label={t("wallet.spark.to")} placeholder={t("wallet.spark.toPlaceholder", { prefix: mainnet ? "spark1…" : "sparkrt1…" })} spellCheck={false} className={`${input} font-mono text-xs`} value={to} onChange={e => setTo(e.target.value.trim())} />
    {to && (!kind || invoice?.token) && <Notice tone="warning" testId="spark-address-invalid">{invoice?.token ? t("wallet.spark.tokenInvoice") : mainnet ? t("wallet.spark.notMainnet") : t("wallet.spark.notRegtest")}</Notice>}
    {invoice && !invoice.token && invoice.amount !== undefined ? <p className="text-sm text-text-primary" data-testid="spark-invoice-summary">{fillNodes(invoice.memo ? t("wallet.spark.invoiceForMemo", { unit, memo: invoice.memo }) : t("wallet.spark.invoiceFor", { unit }), { amount: <span className="font-semibold tabular-nums">{formatAmount(invoice.amount, t.language)}</span> })}</p>
     : <Amount value={amount} onChange={setAmount} unit={unit} testId="spark-amount" />}
    <Button variant="primary" className="w-full" data-testid="spark-review" disabled={busy || !!review || !spark.balance || !kind || !!invoice?.token || !sats} onClick={() => void run(async () => {
     setReview(await wallet.preparePayment({ target: { method: "spark", network, provider: SPARK_PROVIDER, asset: "BTC", unit: "sat", address: to, expiresAt: Date.now() + 5 * 60 * 1000 }, amount: sats, feeCap: feeCap(sats), payee: to }));
    })}>{spark.balance ? t("wallet.panel.review") : t("wallet.panel.noBalance")}</Button>
    <Notice>{t("wallet.spark.approve")}</Notice>
   </div>}
   {review && <PaymentReview key={review.id} review={review} wallet={wallet} onClose={() => { setReview(null); setTo(""); setAmount(""); }} />}
   {intents.filter(i => i.id !== review?.id && i.state !== "settled").map(i => <Button key={i.id} className="block w-full text-start" onClick={() => setReview(i)}>{t("wallet.panel.intent", { amount: formatAmount(i.amount, t.language), unit, state: paymentStateLabel(t, i.state) })}</Button>)}
   {!!spark.history?.length && <Section title={t("wallet.spark.history")}>
    <ul className="divide-y divide-border" data-testid="spark-history">
     {spark.history.map(entry => <li key={entry.id} className="flex items-center gap-3 py-2 text-sm" data-testid="spark-history-row">
      <span className={entry.direction === "in" ? "text-green-500" : "text-text-primary"}>{entry.direction === "in" ? "+" : "−"}{formatAmount(entry.amount, t.language)} <span className="text-xs text-text-muted">{unit}</span></span>
      <span className="flex-1 min-w-0 truncate text-text-muted text-xs">{[entry.via === "spark" ? "Spark" : entry.via === "lightning" ? "Lightning" : entry.via === "onchain" ? t("wallet.spark.via.onchain") : t("wallet.spark.via.other"), entry.memo, entry.status !== "completed" ? entry.status : "", entry.fee ? t("wallet.spark.fee", { fee: entry.fee }) : ""].filter(Boolean).join(" · ")}</span>
      <span className="text-text-muted text-xs tabular-nums">{formatAt(entry.at, WHEN, t.language)}</span>
     </li>)}
    </ul>
   </Section>}
  </div>}
  {error && <Notice tone="error">{error}</Notice>}
  {spark?.error && ready && <Notice tone="warning">{spark.error}</Notice>}

  {ready && <Section title={t("wallet.panel.settings")}>
   <Row label={t("wallet.panel.network")} hint={mainnet ? t("wallet.spark.networkHintMainnet") : t("wallet.spark.networkHintRegtest")}><span className="text-sm text-text-secondary">{mainnet ? "Mainnet" : "Regtest"}</span></Row>
   {!mainnet && <Row label="Lightning" hint={breezIsLightning ? t("wallet.spark.lnHintOn") : t("wallet.spark.lnHint")}>
    {breezIsLightning ? <span className="text-sm text-text-secondary" data-testid="spark-lightning-on">{t("wallet.panel.inUse")}</span>
     : <Button data-testid="spark-use-lightning" disabled={busy} onClick={() => void run(() => wallet.sparkUseForLightning())}>{t("wallet.spark.useForLightning")}</Button>}
   </Row>}
   <BackupRows name="Spark" busy={busy} run={run} canReplace={canReplace} focusFirst={backupNow}
    reveal={async () => (await wallet.sparkBackup()).mnemonic} exportBackup={pw => wallet.sparkExportBackup(pw)}
    restorePhrase={mnemonic => wallet.sparkCreate({ network, mnemonic })} restoreFile={(text, pw) => wallet.sparkRestoreBackup(text, pw)} />
   <Block><Notice>{t("wallet.spark.phraseNote")}</Notice></Block>
  </Section>}
 </div>;
}
