import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { removalRisksFunds, walletRemoval, type WalletRemoval } from "@ghostly/browser/shared/walletRemoval";
import type { WalletNetwork, WalletPlatform, WalletState, WalletType } from "../../lib/platform";
import { useBackdropDismiss } from "../../hooks/useDismiss";
import { useI18n } from "../../contexts/I18nContext";
import { NetworkTag } from "../NetworkTag";
import { networkState } from "../walletCardData";
import { BackupRows } from "./BackupRows";
import { exportBackup, reveal } from "./walletPhrase";
import { NETWORK_NAME, WALLET_NAME, walletLabel } from "./names";
import { useRun } from "./run";
import { removalWords } from "./removalWords";
import { Block, Button, Notice, Row, Section } from "./ui";

/**
 * The last section of a wallet's details: remove it. A card that comes with another wallet (Lightning through the
 * Cashu mints) says which one to remove instead.
 */
export function RemoveWalletSection({ type, network, card, wallet, state, onRemoved, onOpen }: {
  type: WalletType;
  network: WalletNetwork;
  /** One Lightning card of several on its network. */
  card?: string;
  wallet: WalletPlatform;
  state: WalletState;
  onRemoved: () => void;
  /** Brings up another card (the wallet this one comes with). */
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  const removal = walletRemoval(type, network, networkState(state, network), state.intents, card, removalWords(t));
  const label = card ? networkState(state, network, card).lightning?.name || walletLabel(type, network) : walletLabel(type, network);
  return (
    <Section title={t("wallet.remove.title")} testId="wallet-remove-section">
      {removal.comesWith ? (
        <Row label={t("wallet.remove.comesWith", { network: NETWORK_NAME[network], wallet: WALLET_NAME[removal.comesWith] })} hint={t("wallet.remove.comesWithHint")}>
          <Button data-testid="wallet-remove-open-cashu" onClick={() => onOpen(`${removal.comesWith}:${network}`)}>{t("wallet.remove.open", { wallet: WALLET_NAME[removal.comesWith] })}</Button>
        </Row>
      ) : (
        <Row label={t("wallet.remove.label")} hint={removal.custody === "elsewhere" ? t("wallet.remove.hintElsewhere") : t("wallet.remove.hintDevice")}>
          <Button variant="danger" data-testid="wallet-remove" aria-haspopup="dialog" onClick={() => setAsking(true)}>{t("wallet.remove.ask", { label })}</Button>
        </Row>
      )}
      {asking && <RemoveWalletDialog removal={removal} wallet={wallet.forNetwork(network)} source={sourceName(type, network, state, card)} onClose={() => setAsking(false)} onRemoved={() => { setAsking(false); onRemoved(); }} />}
    </Section>
  );
}

/** Where a Lightning or on-chain wallet keeps its money (the source's name), for "the money stays in …". */
function sourceName(type: WalletType, network: WalletNetwork, state: WalletState, card?: string): string | undefined {
  const view = networkState(state, network, card), source = type === "lightning" ? view.lightning : type === "bitcoin" ? view.bitcoin : undefined;
  return source?.alias ?? source?.label ?? undefined;
}

/**
 * Asks before a wallet goes: what it holds and on which network, a backup first where the wallet has one, and a
 * confirmation in words when the money on this device goes with it. An empty test wallet is one plain confirm. The
 * engine checks the same again (walletRemove): nothing here is the only guard.
 */
export function RemoveWalletDialog({ removal, wallet, source, lead, onClose, onRemoved }: {
  removal: WalletRemoval;
  /** Why this removal takes the whole wallet (its last mint was asked to go), said first. */
  lead?: string;
  /** Bound to the wallet's network. */
  wallet: WalletPlatform;
  source?: string;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const { type, network } = removal;
  const label = walletLabel(type, network), real = network === "mainnet";
  const risks = removalRisksFunds(removal), held = removal.held;
  const [understood, setUnderstood] = useState(false);
  const { busy, error, run } = useRun();
  const backup = useRun();
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const close = () => { if (!busy) onClose(); };
  const backdrop = useBackdropDismiss(close);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal(); cancel.current?.focus();
    return () => { element.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  const remove = () => void run(async () => { await wallet.remove({ type, network, ...(removal.card ? { card: removal.card } : {}), ...(risks ? { acceptLoss: true } : {}) }); onRemoved(); });

  const what = removal.custody === "elsewhere"
    ? source ? t("wallet.remove.held.elsewhereIn", { source }) : t("wallet.remove.held.elsewhere")
    : held === "unknown" ? t("wallet.remove.held.unknown")
    : held.empty ? t("wallet.remove.held.empty")
    : t(real ? "wallet.remove.held.real" : "wallet.remove.held.test", { amount: held.text, network: NETWORK_NAME[network] });
  const { awaiting, returnable } = removal;
  // What goes (the money held, the money still coming, or both), each case one whole sentence.
  const waits = awaiting.length > 0;
  const consent = held === "unknown" ? t(waits ? "wallet.remove.consent.unknownWaits" : "wallet.remove.consent.unknown", { label })
    : !held.empty ? t(real ? (waits ? "wallet.remove.consent.realWaits" : "wallet.remove.consent.real") : (waits ? "wallet.remove.consent.testWaits" : "wallet.remove.consent.test"), { amount: held.text })
    : t(real ? "wallet.remove.consent.waitsReal" : "wallet.remove.consent.waits");
  const requests = awaiting.some((i) => i.kind === "request");
  const afterwards = removal.custody === "elsewhere"
    ? source ? t("wallet.remove.afterwards.reaches", { source }) : t("wallet.remove.afterwards.reachesWallet")
    : t(real ? "wallet.remove.afterwards.lostReal" : "wallet.remove.afterwards.lost");
  // A backup is offered whenever something could be lost, and for any real-money wallet: an address shared before
  // may still be paid, and only its recovery phrase reaches what arrives there.
  const offerBackup = removal.custody === "device" && (risks || real);

  return createPortal(
    <dialog ref={dialog} {...backdrop} onCancel={(e) => { e.preventDefault(); close(); }} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); close(); } }} data-testid="wallet-remove-dialog" data-network={network}
      aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
      className="m-auto w-[calc(100%_-_2rem)] max-w-md max-h-[90dvh] overflow-y-auto rounded-2xl border border-border bg-panel-header p-5 text-text-primary shadow-2xl backdrop:bg-black/60 space-y-4">
      <div className="space-y-2">
        <NetworkTag network={network} testId="wallet-remove-network" />
        <h2 id={`${id}-title`} className="text-base font-semibold">{t("wallet.remove.question", { label })}</h2>
        {lead && <p className="text-sm text-text-primary" data-testid="wallet-remove-lead">{lead}</p>}
        <p id={`${id}-body`} className="text-sm text-text-secondary" data-testid="wallet-remove-held">{what}</p>
      </div>
      {awaiting.length > 0 && (
        <div className="space-y-2" data-testid="wallet-remove-awaiting">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t("wallet.remove.awaiting")}</h3>
          <ul className="bg-surface rounded-xl divide-y divide-border text-sm">
            {awaiting.map((item, i) => <li key={`${item.kind}-${item.paymentId ?? i}`} className="px-3 py-2" data-testid="wallet-remove-awaiting-item" data-kind={item.kind}>{item.text}</li>)}
          </ul>
          <p className="text-xs text-text-secondary" data-testid="wallet-remove-awaiting-note">{requests ? t("wallet.remove.closesRequests", { afterwards }) : afterwards}</p>
        </div>
      )}
      {returnable.length > 0 && (
        <Notice testId="wallet-remove-returnable">
          {t("wallet.remove.returnable", { amounts: returnable.map((i) => i.amount).join(", ") })}
        </Notice>
      )}
      {removal.pending > 0 && <Notice tone="error" testId="wallet-remove-pending">{t("wallet.remove.pending", { count: removal.pending })}</Notice>}
      {offerBackup && (
        <div className="space-y-2" data-testid="wallet-remove-backup">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t("wallet.remove.backupFirst")}</h3>
          {removal.backup === "phrase" ? (
            <div className="bg-surface rounded-xl divide-y divide-border">
              <BackupRows name={WALLET_NAME[type]} busy={backup.busy || busy} run={backup.run} reveal={() => reveal(wallet, type)} exportBackup={(password) => exportBackup(wallet, type, password)} />
            </div>
          ) : removal.backup === "tokens" ? (
            <Block>
              <p className="text-xs text-text-secondary">{t("wallet.remove.tokensHint")}</p>
              <Button data-testid="wallet-remove-copy-tokens" disabled={backup.busy || busy} onClick={() => void backup.run(async () => { const tokens = await wallet.exportTokens(); await navigator.clipboard.writeText(tokens.map((token) => token.token).join("\n")); setNotice(tokens.length ? t("wallet.remove.tokensCopied") : t("wallet.remove.noTokens")); })}>{t("wallet.remove.copyTokens")}</Button>
            </Block>
          ) : (
            <Notice testId="wallet-remove-no-backup">{t("wallet.remove.noBackup")}</Notice>
          )}
          {notice && <Notice testId="wallet-remove-notice">{notice}</Notice>}
          {backup.error && <Notice tone="error" testId="wallet-remove-backup-error">{backup.error}</Notice>}
        </div>
      )}
      {risks && (
        <label className="flex items-start gap-2.5 text-sm text-text-primary cursor-pointer">
          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-danger)]" data-testid="wallet-remove-understood" checked={understood} disabled={busy} onChange={(e) => setUnderstood(e.target.checked)} />
          <span data-testid="wallet-remove-consent">{consent}</span>
        </label>
      )}
      {error && <Notice tone="error" testId="wallet-remove-error">{error}</Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={cancel} data-testid="wallet-remove-cancel" disabled={busy} onClick={close}>{t("common.cancel")}</Button>
        <Button variant="danger" data-testid="wallet-remove-confirm" disabled={busy || removal.pending > 0 || (risks && !understood)} onClick={remove}>{busy ? t("wallet.remove.removing") : t("wallet.remove.confirm", { label })}</Button>
      </div>
    </dialog>,
    document.body,
  );
}
