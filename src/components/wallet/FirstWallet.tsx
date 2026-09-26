import { useState } from "react";
import type { WalletNetwork, WalletPlatform, WalletType } from "../../lib/platform";
import { WalletMark } from "../WalletCards";
import { Button, Notice } from "./ui";

/** What the first setup makes: payments over Lightning (Cashu) and a dollar token, each ready in one click. */
const FIRST: WalletType[] = ["cashu", "usdt"];
const NAME: Record<WalletType, string> = { cashu: "Cashu", lightning: "Lightning", arkade: "Ark", bark: "Bark", spark: "Spark", bitcoin: "Bitcoin", fedimint: "Fedimint", usdt: "USDT" };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A profile with no wallet yet: not a dead end. One choice, the network, and the first wallets are made: Cashu over
 * Lightning and USDT, each checked before its card appears. Any other kind is one click away under New.
 */
export function FirstWallet({ wallet, onNew, onStart, onMade }: {
  wallet: WalletPlatform;
  onNew: () => void;
  /** The setup began: the page keeps this in view until it ends, though the first card may already be there. */
  onStart: () => void;
  onMade: (id: string) => void;
}) {
  const [busy, setBusy] = useState<WalletNetwork | null>(null);
  const [made, setMade] = useState<string[]>([]);
  const [failed, setFailed] = useState<{ type: WalletType; network: WalletNetwork; text: string }[]>([]);

  const start = async (network: WalletNetwork, types: WalletType[] = FIRST) => {
    setBusy(network); setFailed([]); onStart();
    const done: string[] = [], problems: typeof failed = [];
    // One after the other: each is whole or not there at all, and a failure says which.
    for (const type of types) {
      try { done.push((await wallet.create({ type, network })).id); }
      catch (e) { problems.push({ type, network, text: message(e) }); }
    }
    setBusy(null); setMade((m) => [...m, ...done]); setFailed(problems);
    if (done.length && !problems.length) onMade(done[0]);
  };

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-panel-header p-5" data-testid="wallet-first" aria-labelledby="wallet-first-title">
      <div className="flex items-center gap-2 text-text-muted">
        {FIRST.map((type) => <span key={type} className={`wallet-card-${type} grid place-items-center w-9 h-9 rounded-lg`} style={{ color: "rgb(var(--card-rgb))", background: "rgba(var(--card-rgb), .14)" }} aria-hidden="true"><WalletMark rail={type} /></span>)}
      </div>
      <div className="space-y-1">
        <h2 id="wallet-first-title" className="text-base font-medium text-text-primary">Create your first wallet</h2>
        <p className="text-sm text-text-secondary">Each wallet has its own network. Start with Cashu, to pay and be paid over Lightning, and USDT: one click, on the network you choose.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" data-testid="wallet-first-testnet" disabled={!!busy} onClick={() => void start("testnet")}>{busy === "testnet" ? "Creating…" : "Start on Testnet"}</Button>
        <Button data-testid="wallet-first-mainnet" disabled={!!busy} onClick={() => void start("mainnet")}>{busy === "mainnet" ? "Creating…" : "Start on Mainnet"}</Button>
      </div>
      <p className="text-xs text-text-muted">Testnet: test coins, worth nothing, to try things out. Mainnet: real money.</p>
      {busy && <Notice testId="wallet-first-progress">Creating your wallets and checking their servers…</Notice>}
      {failed.map((f) => (
        <div key={f.type} className="flex flex-wrap items-center gap-2">
          <Notice tone="error" testId={`wallet-first-error-${f.type}`}>{f.text}</Notice>
          <Button data-testid={`wallet-first-retry-${f.type}`} disabled={!!busy} onClick={() => void start(f.network, [f.type])}>Try {NAME[f.type]} again</Button>
        </div>
      ))}
      {made.length > 0 && failed.length > 0 && <Button onClick={() => onMade(made[0])}>Open what was made</Button>}
      <p className="text-sm text-text-secondary">Or pick any kind of wallet with <button type="button" data-testid="wallet-first-new" onClick={onNew} className="text-accent underline underline-offset-2 cursor-pointer">New</button>: Ark, Lightning, Bitcoin, Fedimint and more.</p>
    </section>
  );
}
