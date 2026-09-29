import { useEffect, useRef, useState } from "react";
import type { WalletInstanceView, WalletNetwork, WalletOffer, WalletPlatform, WalletType } from "../../lib/platform";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { WalletMark } from "../WalletCards";
import { moneyLabel } from "../NetworkTag";
import { useI18n, type Translate } from "../../contexts/I18nContext";
import { Select } from "../ui/Select";
import { Button, Notice, input } from "./ui";
import { NETWORK_NAME, WALLET_NAME } from "./names";
import { ProviderConfigForm } from "./providers/SourcePicker";
import { PROVIDER_FORMS } from "./providers/forms";
import "./new-wallet.css";

type Key = Parameters<Translate>[0];
/** What each kind of wallet is, in a line, on each network. */
const ABOUT: Record<WalletType, (network: WalletNetwork) => Key> = {
  cashu: (n) => n === "testnet" ? "wallet.new.about.cashuTestnet" : "wallet.new.about.cashu",
  lightning: () => "wallet.new.about.lightning",
  arkade: (n) => n === "testnet" ? "wallet.new.about.arkadeTestnet" : "wallet.new.about.arkade",
  bark: (n) => n === "testnet" ? "wallet.new.about.barkTestnet" : "wallet.new.about.bark",
  spark: (n) => n === "testnet" ? "wallet.new.about.sparkTestnet" : "wallet.new.about.spark",
  bitcoin: () => "wallet.new.about.bitcoin",
  fedimint: () => "wallet.new.about.fedimint",
  usdt: (n) => n === "testnet" ? "wallet.new.about.usdtTestnet" : "wallet.new.about.usdt",
};
/**
 * What making each kind does, step by step, as the dialog shows it while it waits: the first step is quick and local,
 * the second waits on the network (the engine checks the server before anything is saved), then Ready.
 */
const STEPS: Record<WalletType, [Key, Key]> = {
  cashu: ["wallet.new.step.reachMint", "wallet.new.step.checkMint"],
  lightning: ["wallet.new.step.connectSource", "wallet.new.step.checkNetwork"],
  arkade: ["wallet.new.step.createKeys", "wallet.new.step.reachArk"],
  bark: ["wallet.new.step.createKeys", "wallet.new.step.reachBark"],
  spark: ["wallet.new.step.createKeys", "wallet.new.step.reachSpark"],
  bitcoin: ["wallet.new.step.connectSource", "wallet.new.step.checkNetwork"],
  fedimint: ["wallet.new.step.readInvite", "wallet.new.step.joinFederation"],
  usdt: ["wallet.new.step.createKeys", "wallet.new.step.checkToken"],
};
/** The deck's order. */
const TYPES: WalletType[] = ["cashu", "lightning", "arkade", "bark", "spark", "bitcoin", "fedimint", "usdt"];
const NETWORKS: WalletNetwork[] = ["mainnet", "testnet"];
/** How long the first step shows before the wait on the network does. */
const FIRST_STEP_MS = 700;
/** How long Ready shows before the dialog closes and the new card is dealt into its deck. */
const READY_MS = 650;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Why a kind is not there yet, in one line: the reason's first sentence. */
const shortReason = (reason: string) => reason.split(/(?<=\.)\s/)[0];

type Phase = { type: WalletType; state: "busy" | "done" | "error"; step: number; text?: string; made?: WalletInstanceView };
type Action = "create" | "key" | "connect" | "add-another" | "join" | "join-another" | "added" | "off";

/** What clicking a kind does on this network, as its button says it. */
function actionOf(type: WalletType, offer: WalletOffer | undefined): Action {
  if (!offer?.available) return "off";
  if (offer.exists && type === "fedimint") return "join-another";
  // A network takes several Lightning cards: another source (or the same source's other wallet) is one more.
  if (offer.several) return offer.exists ? "add-another" : "connect";
  if (offer.exists) return "added";
  return offer.needs === "invite" ? "join" : offer.needs === "provider" ? "connect" : offer.needs === "apiKey" ? "key" : "create";
}
const ACTION_LABEL: Record<Action, Key> = {
  create: "wallet.new.action.create", key: "wallet.new.action.key", connect: "wallet.new.action.connect", "add-another": "wallet.new.action.addAnother",
  join: "wallet.new.action.join", "join-another": "wallet.new.action.joinAnother", added: "wallet.new.action.added", off: "wallet.new.action.off",
};
const BUSY_LABEL: Record<WalletType, Key> = {
  cashu: "wallet.new.busy.creating", lightning: "wallet.new.busy.connecting", arkade: "wallet.new.busy.creating", bark: "wallet.new.busy.creating",
  spark: "wallet.new.busy.creating", bitcoin: "wallet.new.busy.connecting", fedimint: "wallet.new.busy.joining", usdt: "wallet.new.busy.creating",
};

/**
 * Wallets → New: whose money first (Real money on Mainnet, or Test money on Testnet), then a kind of wallet, each a
 * card that says what clicking it does: Create (one click, with the network's known-good defaults), Create… (Spark on
 * Mainnet: the person's Breez API key first), Connect… (a source's form), Join with invite…, or why it is not there yet; the ones already made say Added. While a wallet is
 * made the chosen card says so and the steps show; the engine checks the server before the card appears, and a
 * failure says why once, with Try again, leaving nothing half made. Made, it closes by itself (every kind, real money
 * too) and `onCreated` shows the wallet: the page selects its card, and a wallet to back up opens on its backup rows.
 * Focus then goes to what the page chose, not back to New. On a phone it is a sheet.
 */
export function NewWalletDialog({ wallet, offers, initialNetwork = "testnet", onClose, onCreated }: {
  wallet: WalletPlatform;
  offers: WalletOffer[];
  initialNetwork?: WalletNetwork;
  onClose: () => void;
  onCreated: (made: WalletInstanceView) => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDivElement>(null);
  const [network, setNetwork] = useState<WalletNetwork>(initialNetwork);
  const [chosen, setChosen] = useState<WalletType | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [invite, setInvite] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [providerId, setProviderId] = useState("");
  const busy = phase?.state === "busy";
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, run: () => void) => { timers.current.push(setTimeout(run, ms)); };
  // Made: the page decides where the focus goes (the new card, or its backup), so the dialog does not hand it back to New.
  const finished = useRef(false);
  const finish = (made: WalletInstanceView) => { timers.current.forEach(clearTimeout); finished.current = true; onCreated(made); };
  // Closing while it is being made would leave it made unseen: the dialog waits. Once it is made, closing shows it.
  const close = () => { if (phase?.state === "done" && phase.made) finish(phase.made); else if (!busy) onClose(); };
  useDialogFocus(dialog, close, () => !finished.current);
  const backdrop = useBackdropDismiss(close);
  const offer = (type: WalletType) => offers.find((o) => o.type === type && o.network === network);

  const create = async (type: WalletType, extra: { invite?: string; apiKey?: string; providerId?: string; values?: Record<string, string> } = {}) => {
    if (busy) return;
    setPhase({ type, state: "busy", step: 0 });
    later(FIRST_STEP_MS, () => setPhase((p) => p?.type === type && p.state === "busy" ? { ...p, step: 1 } : p));
    try {
      const made = await wallet.create({ type, network, ...extra });
      setPhase({ type, state: "done", step: 2, made });
      later(READY_MS, () => finish(made));
    } catch (e) { setPhase({ type, state: "error", step: 1, text: message(e) }); }
  };
  const pick = (type: WalletType) => {
    const action = actionOf(type, offer(type));
    if (busy || phase?.state === "done" || action === "off" || action === "added") return;
    if (action === "create") { setChosen(null); void create(type); return; }
    setPhase(null); setChosen(type);
    setProviderId(offer(type)?.providers?.[0]?.id ?? "");
  };
  // Leaving the key step forgets the Breez API key typed there.
  const switchNetwork = (next: WalletNetwork) => { if (busy || next === network) return; setNetwork(next); setChosen(null); setPhase(null); setApiKey(""); };

  const chosenOffer = chosen ? offer(chosen) : undefined;
  const descriptor = chosenOffer?.providers?.find((p) => p.id === providerId);
  const Form = descriptor ? PROVIDER_FORMS[descriptor.id] ?? ProviderConfigForm : undefined;
  const error = phase?.state === "error" ? phase : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 max-md:p-0 animate-fade-in" {...backdrop}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="new-wallet-title" aria-describedby="new-wallet-about" data-testid="new-wallet" data-network={network}
        className="new-wallet sheet sheet-padded focus:outline-none w-full max-w-xl max-h-[90dvh] overflow-y-auto bg-panel-header border border-border rounded-2xl shadow-2xl p-5 space-y-5 @container">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="new-wallet-title" className="text-lg font-semibold text-text-primary">{t("wallet.new.title")}</h2>
            <p id="new-wallet-about" className="text-xs text-text-muted mt-1">{t("wallet.new.about.intro")}</p>
          </div>
          <button type="button" aria-label={t("common.close")} onClick={close} disabled={busy} className="grid place-items-center w-10 h-10 shrink-0 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-alt cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">×</button>
        </div>

        <div role="radiogroup" aria-label={t("wallet.new.network")} data-testid="new-wallet-network" data-network={network} className="grid grid-cols-2 gap-2">
          {NETWORKS.map((n) => {
            const on = n === network;
            return (
              <button key={n} type="button" role="radio" aria-checked={on} data-testid={`new-wallet-network-${n}`} data-network={n} disabled={busy && !on}
                onClick={() => switchNetwork(n)} onKeyDown={(e) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) { e.preventDefault(); switchNetwork(n === "mainnet" ? "testnet" : "mainnet"); (e.currentTarget.parentElement?.querySelector(`[data-network=${n === "mainnet" ? "testnet" : "mainnet"}]`) as HTMLElement | null)?.focus(); } }}
                tabIndex={on ? 0 : -1} className="new-wallet-network">
                <span className="new-wallet-network-dot" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="network-tag">{moneyLabel(t, n)}</span>
                  <span className="block text-sm font-semibold text-text-primary mt-1">{NETWORK_NAME[n]}</span>
                  <span className="block text-[11px] leading-snug text-text-secondary mt-0.5">{n === "mainnet" ? t("wallet.new.networkHint.mainnet") : t("wallet.new.networkHint.testnet")}</span>
                </span>
              </button>
            );
          })}
        </div>

        {chosen && chosenOffer ? (
          <div className="space-y-3" data-testid="new-wallet-step">
            <button type="button" data-testid="new-wallet-back" disabled={busy} onClick={() => { setChosen(null); setPhase(null); setApiKey(""); }} className="text-xs text-text-secondary hover:text-text-primary cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">{t("wallet.new.back")}</button>
            <div className="flex items-center gap-3">
              <Mark type={chosen} />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text-primary">{t("wallet.new.kindTitle", { network: NETWORK_NAME[network], wallet: WALLET_NAME[chosen] })}</p>
                <p className="text-xs text-text-secondary">{t(ABOUT[chosen](network))}</p>
              </div>
            </div>
            {chosenOffer.needs === "invite" && (
              <form className="space-y-2" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void create("fedimint", { invite }); }}>
                <label className="block text-xs text-text-secondary">{t("wallet.new.invite")}
                  <input data-testid="new-wallet-invite" className={`${input} mt-1 font-mono text-xs`} value={invite} placeholder="fed11…" spellCheck={false} autoFocus disabled={busy} onChange={(e) => setInvite(e.target.value)} />
                </label>
                <p className="text-[11px] text-text-muted">{t("wallet.new.inviteHint")}</p>
                <Button type="submit" variant="primary" className="w-full" disabled={busy || !invite.trim()} data-testid="new-wallet-create">{busy ? t("wallet.new.busy.joining") : t("wallet.new.joinAndCreate")}</Button>
              </form>
            )}
            {chosenOffer.needs === "apiKey" && (
              <form className="space-y-2" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void create(chosen, { apiKey }); }}>
                <label className="block text-xs text-text-secondary">{t("wallet.source.breez.apiKey")}
                  <input data-testid="new-wallet-api-key" className={`${input} mt-1 font-mono text-xs`} type="password" autoComplete="new-password" value={apiKey} spellCheck={false} autoFocus disabled={busy} onChange={(e) => setApiKey(e.target.value)} />
                </label>
                <p className="text-[11px] text-text-muted">{t("wallet.source.breez.mainnetNeedsKey")}</p>
                <Button type="submit" variant="primary" className="w-full" disabled={busy || !apiKey.trim()} data-testid="new-wallet-create">{busy ? t("wallet.new.busy.creating") : t("wallet.new.action.create")}</Button>
              </form>
            )}
            {chosenOffer.needs === "provider" && (
              <div className="space-y-3" data-testid="new-wallet-provider">
                {(chosenOffer.providers?.length ?? 0) > 1 && (
                  <Select aria-label={t("wallet.source.title")} data-testid="new-wallet-provider-select" value={providerId} disabled={busy} onChange={(id) => { setProviderId(id); setPhase(null); }}
                    options={(chosenOffer.providers ?? []).map((p) => ({ value: p.id, label: p.label }))} />
                )}
                {descriptor?.description && <p className="text-xs text-text-secondary">{descriptor.description}</p>}
                {descriptor && Form && <Form key={`${network}-${descriptor.id}`} descriptor={descriptor} mode={network} busy={busy} onSubmit={(values) => void create(chosen, { providerId: descriptor.id, values })} />}
              </div>
            )}
          </div>
        ) : (
          <div role="group" aria-labelledby="new-wallet-kinds" className="space-y-2">
            <h3 id="new-wallet-kinds" className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t("wallet.new.kinds", { network: NETWORK_NAME[network] })}</h3>
            <div className="new-wallet-kinds">
              {TYPES.map((type) => {
                const o = offer(type), action = actionOf(type, o), mine = phase?.type === type ? phase.state : undefined;
                const off = action === "off" || action === "added";
                const state = mine ?? (off ? action : busy || phase?.state === "done" ? "waiting" : "on");
                return (
                  <button key={type} type="button" data-testid={`new-wallet-type-${type}`} data-state={state} data-action={action}
                    aria-disabled={off || undefined} aria-busy={mine === "busy" || undefined} disabled={(busy || phase?.state === "done") && !mine} title={action === "off" ? o?.reason : undefined}
                    onClick={() => mine === "error" ? void create(type) : pick(type)} className="new-wallet-kind">
                    <Mark type={type} />
                    {/* The name and what clicking does on one line (the action wraps under the name when narrow), what it is below. */}
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                        <span className="text-sm font-semibold text-text-primary">{WALLET_NAME[type]}</span>
                        <span className="new-wallet-action" data-testid={`new-wallet-type-${type}-status`} data-kind={mine ?? action}>
                          {mine === "busy" ? <><span className="new-wallet-spinner" aria-hidden="true" />{t(BUSY_LABEL[type])}</>
                            : mine === "done" ? <><Check />{t("wallet.new.step.ready")}</>
                            : mine === "error" ? t("wallet.new.tryAgain")
                            : action === "added" ? <><Check />{t("wallet.new.action.added")}</> : t(ACTION_LABEL[action])}
                        </span>
                      </span>
                      <span className="block text-xs text-text-secondary mt-1">{action === "off" && o?.reason ? shortReason(o.reason) : t(ABOUT[type](network))}</span>
                    </span>
                    {mine === "busy" && <span className="new-wallet-shimmer" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {phase && phase.state !== "error" && <Progress phase={phase} network={network} />}
        {error && (
          <div className="space-y-2" role="alert">
            <Notice tone="error" testId="new-wallet-error">{error.text}</Notice>
            {!offer(error.type)?.needs && <Button onClick={() => void create(error.type)} data-testid="new-wallet-retry">{t("wallet.new.tryAgain")}</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

/** The steps of the wallet being made, each done, under way or to come; then Ready. */
function Progress({ phase, network }: { phase: Phase; network: WalletNetwork }) {
  const { t } = useI18n();
  const steps: Key[] = [...STEPS[phase.type], "wallet.new.step.ready"];
  const names = { network: NETWORK_NAME[network], wallet: WALLET_NAME[phase.type] };
  const done = phase.state === "done";
  return (
    <div className="new-wallet-progress" role="status" aria-live="polite" data-testid="new-wallet-progress" data-state={phase.state}>
      <p className="text-xs text-text-secondary">{done ? t("wallet.new.ready", names) : t("wallet.new.making", names)}</p>
      <ol className="space-y-1.5 mt-2">
        {steps.map((step, i) => {
          const state = done || i < phase.step ? "done" : i === phase.step ? "active" : "todo";
          return (
            <li key={step} className="flex items-center gap-2 text-sm" data-testid={i === steps.length - 1 ? "new-wallet-ready" : "new-wallet-step"} data-state={state}>
              <span className="new-wallet-step-mark" aria-hidden="true">{state === "done" ? <Check /> : state === "active" ? <span className="new-wallet-spinner" /> : null}</span>
              <span className={state === "todo" ? "text-text-muted" : "text-text-primary"}>{state === "active" ? t("wallet.new.stepActive", { step: t(step) }) : t(step)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Mark({ type }: { type: WalletType }) {
  return <span className={`wallet-card-${type} shrink-0 grid place-items-center w-10 h-10 rounded-xl`} style={{ color: "rgb(var(--card-rgb))", background: "rgba(var(--card-rgb), .14)" }} aria-hidden="true"><WalletMark rail={type} /></span>;
}
function Check() {
  return <svg className="new-wallet-check" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="m2.5 6.2 2.3 2.3 4.7-4.9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
