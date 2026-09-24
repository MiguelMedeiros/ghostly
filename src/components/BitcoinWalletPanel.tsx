import { useState } from "react";
import type { PaymentReview as Review } from "@ghostly/core";
import type { WalletPlatform, WalletState } from "../lib/platform";
import { PaymentReview } from "./PaymentReview";
import { Actions, Address, Amount, Button, Notice, Row, Section, input, type Action } from "./wallet/ui";
import { useRun } from "./wallet/run";
import { SourcePicker, changeableFields } from "./wallet/providers/SourcePicker";

/** The most the person accepts to pay in fees unless they change it; the review shows the real fee. */
const DEFAULT_FEE_CAP = 2_000;

/**
 * On-chain Bitcoin, through the mode's Bitcoin source (a node, a wallet library). There is none until
 * one is set up; the card then says so and offers the providers that run here.
 */
export function BitcoinWalletPanel({ wallet, state }: { wallet: WalletPlatform; state: WalletState }) {
  const bt = state.bitcoin;
  const { busy, error, run } = useRun();
  const [action, setAction] = useState<Action>("receive");
  const [address, setAddress] = useState(""), [amount, setAmount] = useState(""), [feeCap, setFeeCap] = useState(String(DEFAULT_FEE_CAP));
  const [review, setReview] = useState<Review | null>(null);
  const [changing, setChanging] = useState(false);
  const ready = bt?.status === "ready";
  // On-chain Bitcoin goes through the mode's source: in Testnet, under the page's badge, plain sats.
  const unit = "sats";
  const intents = (state.intents ?? []).filter((i) => i.method === "bitcoin" && i.id !== review?.id);

  return (
    <div className="space-y-6" data-testid="bitcoin-wallet">
      {!bt || bt.status === "none" ? (
        <div className="bg-surface rounded-xl p-6 text-center space-y-2" data-testid="bitcoin-empty">
          <p className="text-text-primary">No Bitcoin source configured</p>
          <Notice>On-chain Bitcoin goes through a wallet or node you choose below. Nothing is set up by default.</Notice>
        </div>
      ) : !ready ? (
        // Not connected: "Connecting…" while it is tried again by itself (with the last balance it read), not
        // connected once that has failed for a while; either way, Retry now or move to another server.
        <div className="bg-surface rounded-xl p-6 text-center space-y-3" data-testid="bitcoin-connecting" data-status={bt.status}>
          <p className="text-text-primary">{bt.status === "error" ? `${bt.label ?? "The Bitcoin source"} is not connected` : `Connecting to ${bt.label ?? "the Bitcoin source"}…`}</p>
          {bt.balance !== undefined && (
            <p className="text-text-secondary text-sm" data-testid="bitcoin-last-balance">
              Last known balance: <span className="tabular-nums">{bt.balance.toLocaleString()}</span> {unit}{bt.balanceAt ? ` · ${new Date(bt.balanceAt).toLocaleString()}` : ""}
            </p>
          )}
          {bt.error && <Notice tone={bt.status === "error" ? "error" : "warning"} testId="bitcoin-connect-error">{bt.error}{bt.status === "connecting" ? " · trying again by itself" : ""}</Notice>}
          {(bt.status === "error" || !!bt.failures) && (
            <div className="flex flex-wrap justify-center gap-2">
              <Button disabled={busy} data-testid="bitcoin-retry" onClick={() => void run(() => wallet.bitcoinRetrySource())}>Retry</Button>
              {changeableFields(bt).length > 0 && <Button disabled={busy} data-testid="bitcoin-change-server" onClick={() => setChanging(true)}>Change server</Button>}
            </div>
          )}
          {error && <Notice tone="error" testId="bitcoin-error">{error}</Notice>}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-text-primary" data-testid="bitcoin-balance">
            <span className="text-4xl font-semibold tabular-nums">{(bt.balance ?? 0).toLocaleString()}</span>
            <span className="text-text-muted text-sm ml-2">{unit}</span>
            {!!bt.unconfirmed && <span className="block text-xs text-yellow-500 mt-1">{bt.unconfirmed.toLocaleString()} {unit} unconfirmed</span>}
            {bt.network !== "bitcoin" && <span className="block text-xs text-yellow-500 mt-1">{bt.network} · test coins, worthless</span>}
          </p>
          <Actions value={action} onChange={setAction} actions={["receive", "send", "history"]} />
          {action === "receive" && (
            <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
              {bt.address ? <Address value={bt.address} qr={`bitcoin:${bt.address}`} testId="bitcoin-address" note="Confirmed after one block." />
                : <Notice>Ask the source for an address to be paid on.</Notice>}
              <Button disabled={busy} data-testid="bitcoin-new-address" onClick={() => void run(() => wallet.bitcoinReceiveAddress())}>{bt.address ? "New address" : "Get an address"}</Button>
            </div>
          )}
          {action === "send" && (
            <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
              <input aria-label="Bitcoin recipient address" placeholder="Recipient Bitcoin address" spellCheck={false} className={`${input} font-mono text-xs`} value={address} onChange={(e) => setAddress(e.target.value.trim())} />
              <Amount value={amount} onChange={setAmount} unit={unit} testId="bitcoin-amount" />
              <label className="flex flex-wrap items-center gap-2 text-xs text-text-secondary"><span className="min-w-0">Most you accept in fees</span>
                <input aria-label="Maximum fee in sats" inputMode="numeric" className={`${input} !w-28 shrink-0`} value={feeCap} onChange={(e) => setFeeCap(e.target.value.replace(/\D/g, ""))} /> sats
              </label>
              <Button variant="primary" className="w-full" disabled={busy || !!review || !address || !Number(amount)} onClick={() => void run(async () => {
                setReview(await wallet.preparePayment({ target: { method: "bitcoin", network: bt.network!, provider: "onchain", asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 15 * 60 * 1000 }, amount: Number(amount), feeCap: Number(feeCap), payee: address }));
              })}>Review payment</Button>
              <Notice>The transaction is built and signed for your review; nothing is broadcast before you approve.</Notice>
            </div>
          )}
          {action === "history" && (
            <div className="bg-surface rounded-xl p-4 space-y-2 animate-fade-in" data-testid="bitcoin-history">
              {bt.history.length === 0 ? <Notice>Nothing yet</Notice> : bt.history.map((tx) => (
                <div key={tx.txid} className="text-sm py-1 flex flex-wrap justify-between gap-x-2" data-testid="bitcoin-tx">
                  <span className="min-w-0 flex-1 font-mono text-xs text-text-muted truncate">{tx.txid}</span>
                  <span className={`tabular-nums shrink-0 ${tx.amount > 0 ? "text-accent" : "text-text-primary"}`}>{tx.amount > 0 ? "+" : "−"}{Math.abs(tx.amount).toLocaleString()} · {tx.confirmations ? `${tx.confirmations} conf.` : "unconfirmed"}</span>
                </div>
              ))}
            </div>
          )}
          {review && <PaymentReview key={review.id} review={review} wallet={wallet} onClose={() => setReview(null)} />}
          {intents.map((i) => <Button key={i.id} className="block w-full text-left" onClick={() => setReview(i)}>{i.amount.toLocaleString()} {unit} · {i.state}</Button>)}
          {error && <Notice tone="error" testId="bitcoin-error">{error}</Notice>}
        </div>
      )}
      {bt && <SourcePicker kind="onchain" view={bt} onSet={(id, values) => wallet.bitcoinSetSource(id, values)} onClear={() => wallet.bitcoinClearSource()}
        onRetry={() => wallet.bitcoinRetrySource()} onReconfigure={(values) => wallet.bitcoinReconfigureSource(values)} changing={changing} onChanging={setChanging} />}
      {bt?.status === "ready" && (
        <Section title="Settings"><Row label="Refresh" hint="Balance and history are read from the source every few seconds."><Button disabled={busy} onClick={() => void run(() => wallet.bitcoinRefresh())}>Refresh now</Button></Row></Section>
      )}
    </div>
  );
}
