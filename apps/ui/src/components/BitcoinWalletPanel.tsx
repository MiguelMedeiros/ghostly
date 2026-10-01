import { useState } from "react";
import type { PaymentReview as Review } from "@ghostly/core";
import type { WalletPlatform, WalletState } from "../lib/platform";
import { PaymentReview } from "./PaymentReview";
import { paymentStateLabel } from "./paymentWords";
import { Actions, Address, Amount, Button, Notice, Row, Section, input, type Action } from "./wallet/ui";
import { useRun } from "./wallet/run";
import { SourcePicker } from "./wallet/providers/SourcePicker";
import { changeableFields } from "./wallet/providers/sourceStatus";
import { useI18n } from "../contexts/I18nContext";
import { formatAt } from "../lib/time";
import { satsIn } from "./NetworkTag";
import { fillNodes } from "../lib/fillNodes";
import { formatAmount } from "../lib/amount";
import { useAmountText } from "../hooks/useAmountText";

/** The most the person accepts to pay in fees unless they change it; the review shows the real fee. */
const DEFAULT_FEE_CAP = 2_000;

/**
 * On-chain Bitcoin, through the mode's Bitcoin source (a node, a wallet library). There is none until
 * one is set up; the card then says so and offers the providers that run here.
 */
export function BitcoinWalletPanel({ wallet, state }: { wallet: WalletPlatform; state: WalletState }) {
  const bt = state.bitcoin;
  const { t } = useI18n();
  const { busy, error, run } = useRun();
  const [action, setAction] = useState<Action>("receive");
  const [address, setAddress] = useState(""), [amount, setAmount] = useState(""), [feeCap, setFeeCap] = useState(String(DEFAULT_FEE_CAP));
  const [review, setReview] = useState<Review | null>(null);
  /** The fee limit typed the person's way; `feeCap` is what it means, or "" while unclear. */
  const feeField = useAmountText(feeCap, setFeeCap, t.language ?? "en", 0, t);
  const [changing, setChanging] = useState(false);
  const ready = bt?.status === "ready";
  // On-chain Bitcoin goes through its network's source: a Testnet wallet's coins are test sats.
  const unit = satsIn(t, state.mode === "testnet" ? "testnet" : "mainnet");
  const intents = (state.intents ?? []).filter((i) => i.method === "bitcoin" && i.id !== review?.id);

  return (
    <div className="space-y-6" data-testid="bitcoin-wallet">
      {!bt || bt.status === "none" ? (
        <div className="bg-surface rounded-xl p-6 text-center space-y-2" data-testid="bitcoin-empty">
          <p className="text-text-primary">{t("wallet.bitcoin.empty")}</p>
          <Notice>{t("wallet.bitcoin.emptyNote")}</Notice>
        </div>
      ) : !ready ? (
        // Not connected: "Connecting…" while it is tried again by itself (with the last balance it read), not
        // connected once that has failed for a while; either way, Retry now or move to another server.
        <div className="bg-surface rounded-xl p-6 text-center space-y-3" data-testid="bitcoin-connecting" data-status={bt.status}>
          <p className="text-text-primary">{bt.status === "error" ? (bt.label ? t("wallet.bitcoin.notConnected", { label: bt.label }) : t("wallet.bitcoin.notConnectedDefault")) : bt.label ? t("wallet.bitcoin.connectingTo", { label: bt.label }) : t("wallet.bitcoin.connectingDefault")}</p>
          {bt.balance !== undefined && (
            <p className="text-text-secondary text-sm" data-testid="bitcoin-last-balance">
              {fillNodes(bt.balanceAt ? t("wallet.bitcoin.lastBalanceAt", { unit, date: formatAt(bt.balanceAt, { dateStyle: "medium", timeStyle: "short" }, t.language) }) : t("wallet.bitcoin.lastBalance", { unit }), { balance: <span className="tabular-nums">{formatAmount(bt.balance, t.language)}</span> })}
            </p>
          )}
          {bt.error && <Notice tone={bt.status === "error" ? "error" : "warning"} testId="bitcoin-connect-error">{bt.status === "connecting" ? t("wallet.bitcoin.retrying", { error: bt.error }) : bt.error}</Notice>}
          {(bt.status === "error" || !!bt.failures) && (
            <div className="flex flex-wrap justify-center gap-2">
              <Button disabled={busy} data-testid="bitcoin-retry" onClick={() => void run(() => wallet.bitcoinRetrySource())}>{t("wallet.bitcoin.retry")}</Button>
              {changeableFields(bt).length > 0 && <Button disabled={busy} data-testid="bitcoin-change-server" onClick={() => setChanging(true)}>{t("wallet.bitcoin.changeServer")}</Button>}
            </div>
          )}
          {error && <Notice tone="error" testId="bitcoin-error">{error}</Notice>}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-text-primary" data-testid="bitcoin-balance">
            <span className="text-4xl font-semibold tabular-nums">{formatAmount(bt.balance ?? 0, t.language)}</span>
            <span className="text-text-muted text-sm ms-2">{unit}</span>
            {!!bt.unconfirmed && <span className="block text-xs text-yellow-500 mt-1">{t("wallet.bitcoin.unconfirmed", { amount: formatAmount(bt.unconfirmed, t.language), unit })}</span>}
            {bt.network !== "bitcoin" && <span className="block text-xs text-yellow-500 mt-1">{t("wallet.panel.testCoins", { network: bt.network ?? "" })}</span>}
          </p>
          <Actions value={action} onChange={setAction} actions={["receive", "send", "history"]} />
          {action === "receive" && (
            <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
              {bt.address ? <Address value={bt.address} qr={`bitcoin:${bt.address}`} testId="bitcoin-address" note={t("wallet.bitcoin.confirmedAfter")} />
                : <Notice>{t("wallet.bitcoin.askAddress")}</Notice>}
              <Button disabled={busy} data-testid="bitcoin-new-address" onClick={() => void run(() => wallet.bitcoinReceiveAddress())}>{bt.address ? t("wallet.bitcoin.newAddress") : t("wallet.bitcoin.getAddress")}</Button>
            </div>
          )}
          {action === "send" && (
            <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
              <input aria-label={t("wallet.panel.recipient", { wallet: "Bitcoin" })} placeholder={t("wallet.panel.recipientPlaceholder", { wallet: "Bitcoin" })} spellCheck={false} className={`${input} font-mono text-xs`} value={address} onChange={(e) => setAddress(e.target.value.trim())} />
              <Amount value={amount} onChange={setAmount} unit={unit} testId="bitcoin-amount" />
              <label className="flex flex-wrap items-center gap-2 text-xs text-text-secondary"><span className="min-w-0">{t("wallet.bitcoin.maxFee")}</span>
                <input aria-label={t("wallet.bitcoin.maxFeeInput")} inputMode="numeric" className={`${input} !w-28 shrink-0`} aria-invalid={feeField.hint ? true : undefined} value={feeField.text} onChange={(e) => feeField.change(e.target.value)} /> sats
              </label>
              {feeField.hint && <Notice tone="error" testId="amount-unclear">{feeField.hint}</Notice>}
              <Button variant="primary" className="w-full" disabled={busy || !!review || !address || !Number(amount) || !feeCap} onClick={() => void run(async () => {
                setReview(await wallet.preparePayment({ target: { method: "bitcoin", network: bt.network!, provider: "onchain", asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 15 * 60 * 1000 }, amount: Number(amount), feeCap: Number(feeCap), payee: address }));
              })}>{t("wallet.panel.review")}</Button>
              <Notice>{t("wallet.bitcoin.reviewNote")}</Notice>
            </div>
          )}
          {action === "history" && (
            <div className="bg-surface rounded-xl p-4 space-y-2 animate-fade-in" data-testid="bitcoin-history">
              {bt.history.length === 0 ? <Notice>{t("wallet.bitcoin.nothingYet")}</Notice> : bt.history.map((tx) => (
                <div key={tx.txid} className="text-sm py-1 flex flex-wrap justify-between gap-x-2" data-testid="bitcoin-tx">
                  <span className="min-w-0 flex-1 font-mono text-xs text-text-muted truncate">{tx.txid}</span>
                  <span className={`tabular-nums shrink-0 ${tx.amount > 0 ? "text-accent" : "text-text-primary"}`}>{tx.confirmations ? t("wallet.bitcoin.tx.confirmed", { sign: tx.amount > 0 ? "+" : "−", amount: formatAmount(Math.abs(tx.amount), t.language), count: tx.confirmations }) : t("wallet.bitcoin.tx.unconfirmed", { sign: tx.amount > 0 ? "+" : "−", amount: formatAmount(Math.abs(tx.amount), t.language) })}</span>
                </div>
              ))}
            </div>
          )}
          {review && <PaymentReview key={review.id} review={review} wallet={wallet} onClose={() => setReview(null)} />}
          {intents.map((i) => <Button key={i.id} className="block w-full text-start" onClick={() => setReview(i)}>{t("wallet.panel.intent", { amount: formatAmount(i.amount, t.language), unit, state: paymentStateLabel(t, i.state) })}</Button>)}
          {error && <Notice tone="error" testId="bitcoin-error">{error}</Notice>}
        </div>
      )}
      {bt && <SourcePicker kind="onchain" view={bt} onSet={(id, values) => wallet.bitcoinSetSource(id, values)} onClear={() => wallet.bitcoinClearSource()}
        onRetry={() => wallet.bitcoinRetrySource()} onReconfigure={(values) => wallet.bitcoinReconfigureSource(values)} changing={changing} onChanging={setChanging} />}
      {bt?.status === "ready" && (
        <Section title={t("wallet.panel.settings")}><Row label={t("wallet.bitcoin.refresh")} hint={t("wallet.bitcoin.refreshHint")}><Button disabled={busy} onClick={() => void run(() => wallet.bitcoinRefresh())}>{t("wallet.bitcoin.refreshNow")}</Button></Row></Section>
      )}
    </div>
  );
}
