import { useState } from "react";
import type { WalletNetwork, WalletOffer, WalletPlatform, WalletType } from "../../lib/platform";
import { DEFAULT_WALLETS } from "@ghostly/browser/engine/walletSetup";
import { useI18n } from "../../contexts/I18nContext";
import { fillNodes } from "../../lib/fillNodes";
import { WalletMark } from "../WalletCards";
import { Button, Notice } from "./ui";
import { WALLET_NAME as NAME } from "./names";

/** What the first setup makes: payments over Lightning (Cashu) and a dollar token, each ready in one click. */
const FIRST: WalletType[] = ["cashu", "usdt"];
/**
 * On Mainnet, the wallets a new profile gets by itself: these two, and Bitcoin on-chain where a Mainnet on-chain wallet
 * is made in one click here (not yet: until then it is skipped, as the setup skips it). Testnet: these two.
 */
const firstKinds = (network: WalletNetwork, offers: WalletOffer[] = []): WalletType[] => network === "testnet" ? FIRST
  : DEFAULT_WALLETS.filter((type) => FIRST.includes(type) || offers.some((o) => o.type === type && o.network === network && o.available && !o.needs));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A profile with no wallet yet: not a dead end. One choice, the network, and the first wallets are made: Cashu over
 * Lightning and USDT, each checked before its card appears. Any other kind is one click away under New.
 */
export function FirstWallet({ wallet, offers, onNew, onStart, onMade }: {
  wallet: WalletPlatform;
  /** What New can make: Mainnet's Bitcoin on-chain joins the first wallets where it is made in one click. */
  offers?: WalletOffer[];
  onNew: () => void;
  /** The setup began: the page keeps this in view until it ends, though the first card may already be there. */
  onStart: () => void;
  onMade: (id: string) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<WalletNetwork | null>(null);
  const [made, setMade] = useState<string[]>([]);
  const [failed, setFailed] = useState<{ type: WalletType; network: WalletNetwork; text: string }[]>([]);

  const start = async (network: WalletNetwork, types: WalletType[] = firstKinds(network, offers)) => {
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
        <h2 id="wallet-first-title" className="text-base font-medium text-text-primary">{t("wallet.first.title")}</h2>
        <p className="text-sm text-text-secondary">{t("wallet.first.text")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" data-testid="wallet-first-testnet" disabled={!!busy} onClick={() => void start("testnet")}>{busy === "testnet" ? t("wallet.first.creating") : t("wallet.first.startTestnet")}</Button>
        <Button data-testid="wallet-first-mainnet" disabled={!!busy} onClick={() => void start("mainnet")}>{busy === "mainnet" ? t("wallet.first.creating") : t("wallet.first.startMainnet")}</Button>
      </div>
      <p className="text-xs text-text-muted">{t("wallet.first.networks")}</p>
      {busy && <Notice testId="wallet-first-progress">{t("wallet.first.progress")}</Notice>}
      {failed.map((f) => (
        <div key={f.type} className="flex flex-wrap items-center gap-2">
          <Notice tone="error" testId={`wallet-first-error-${f.type}`}>{f.text}</Notice>
          <Button data-testid={`wallet-first-retry-${f.type}`} disabled={!!busy} onClick={() => void start(f.network, [f.type])}>{t("wallet.first.retry", { wallet: NAME[f.type] })}</Button>
        </div>
      ))}
      {made.length > 0 && failed.length > 0 && <Button onClick={() => onMade(made[0])}>{t("wallet.first.openMade")}</Button>}
      <p className="text-sm text-text-secondary">{fillNodes(t("wallet.first.orNew"), {
        new: <button type="button" data-testid="wallet-first-new" onClick={onNew} className="text-accent underline underline-offset-2 cursor-pointer">{t("sidebar.new")}</button>,
      })}</p>
    </section>
  );
}
