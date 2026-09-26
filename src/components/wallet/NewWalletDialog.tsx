import { useEffect, useRef, useState } from "react";
import type { WalletInstanceView, WalletNetwork, WalletOffer, WalletPlatform, WalletType } from "../../lib/platform";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { WalletMark } from "../WalletCards";
import { MONEY_LABEL } from "../NetworkTag";
import { Select } from "../ui/Select";
import { Button, Notice, input } from "./ui";
import { NETWORK_NAME, WALLET_NAME } from "./names";
import { ProviderConfigForm } from "./providers/SourcePicker";
import { PROVIDER_FORMS } from "./providers/forms";
import "./new-wallet.css";

/** What each kind of wallet is, in a line, on each network. */
const ABOUT: Record<WalletType, (network: WalletNetwork) => string> = {
  cashu: (n) => n === "testnet" ? "Ecash over Lightning, on the public test mint." : "Ecash over Lightning, held at well-audited mints.",
  lightning: () => "Your own Lightning wallet or node: NWC, LND, Core Lightning and more.",
  arkade: (n) => n === "testnet" ? "Arkade on Mutinynet: fast, cheap payments off the chain." : "Arkade on Bitcoin: fast, cheap payments off the chain.",
  bark: () => "Second's Ark, on signet.",
  spark: () => "A Spark wallet (Breez), on regtest.",
  bitcoin: () => "On-chain bitcoin: a BDK wallet, or your own node.",
  fedimint: () => "Ecash of a federation you join with its invite code.",
  usdt: (n) => n === "testnet" ? "Test USDT on Sepolia." : "USDT on Ethereum.",
};
/**
 * What making each kind does, step by step, as the dialog shows it while it waits: the first step is quick and local,
 * the second waits on the network (the engine checks the server before anything is saved), then Ready.
 */
const STEPS: Record<WalletType, [string, string]> = {
  cashu: ["Reaching the mint", "Checking it is a Cashu mint"],
  lightning: ["Connecting to the source", "Checking its network"],
  arkade: ["Creating keys", "Reaching the Ark server"],
  bark: ["Creating keys", "Reaching the Bark server"],
  spark: ["Creating keys", "Reaching Spark"],
  bitcoin: ["Connecting to the source", "Checking its network"],
  fedimint: ["Reading the invite", "Joining the federation"],
  usdt: ["Creating keys", "Checking the token on its chain"],
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
type Action = "create" | "connect" | "join" | "join-another" | "added" | "off";

/** What clicking a kind does on this network, as its button says it. */
function actionOf(type: WalletType, offer: WalletOffer | undefined): Action {
  if (!offer?.available) return "off";
  if (offer.exists && type === "fedimint") return "join-another";
  if (offer.exists) return "added";
  return offer.needs === "invite" ? "join" : offer.needs === "provider" ? "connect" : "create";
}
const ACTION_LABEL: Record<Action, string> = { create: "Create", connect: "Connect…", join: "Join with invite…", "join-another": "Join another…", added: "Added", off: "Not yet" };
const BUSY_LABEL: Record<WalletType, string> = { cashu: "Creating…", lightning: "Connecting…", arkade: "Creating…", bark: "Creating…", spark: "Creating…", bitcoin: "Connecting…", fedimint: "Joining…", usdt: "Creating…" };

/**
 * Wallets → New: whose money first (Real money on Mainnet, or Test money on Testnet), then a kind of wallet, each a
 * card that says what clicking it does: Create (one click, with the network's known-good defaults), Connect… (a
 * source's form), Join with invite…, or why it is not there yet; the ones already made say Added. While a wallet is
 * made the chosen card says so and the steps show; the engine checks the server before the card appears, and a
 * failure says why once, with Try again, leaving nothing half made. On a phone it is a sheet.
 */
export function NewWalletDialog({ wallet, offers, initialNetwork = "testnet", onClose, onCreated }: {
  wallet: WalletPlatform;
  offers: WalletOffer[];
  initialNetwork?: WalletNetwork;
  onClose: () => void;
  onCreated: (made: WalletInstanceView) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [network, setNetwork] = useState<WalletNetwork>(initialNetwork);
  const [chosen, setChosen] = useState<WalletType | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [invite, setInvite] = useState("");
  const [providerId, setProviderId] = useState("");
  const busy = phase?.state === "busy";
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, run: () => void) => { timers.current.push(setTimeout(run, ms)); };
  const finish = (made: WalletInstanceView) => { timers.current.forEach(clearTimeout); onCreated(made); };
  // Closing while it is being made would leave it made unseen: the dialog waits. Once it is made, closing shows it.
  const close = () => { if (phase?.state === "done" && phase.made) finish(phase.made); else if (!busy) onClose(); };
  useDialogFocus(dialog, close);
  const backdrop = useBackdropDismiss(close);
  const offer = (type: WalletType) => offers.find((o) => o.type === type && o.network === network);

  const create = async (type: WalletType, extra: { invite?: string; providerId?: string; values?: Record<string, string> } = {}) => {
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
  const switchNetwork = (next: WalletNetwork) => { if (busy || next === network) return; setNetwork(next); setChosen(null); setPhase(null); };

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
            <h2 id="new-wallet-title" className="text-lg font-semibold text-text-primary">New wallet</h2>
            <p id="new-wallet-about" className="text-xs text-text-muted mt-1">Each wallet lives on one network. Test coins and real money never mix.</p>
          </div>
          <button type="button" aria-label="Close" onClick={close} disabled={busy} className="grid place-items-center w-10 h-10 shrink-0 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-alt cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">×</button>
        </div>

        <div role="radiogroup" aria-label="Network" data-testid="new-wallet-network" data-network={network} className="grid grid-cols-2 gap-2">
          {NETWORKS.map((n) => {
            const on = n === network;
            return (
              <button key={n} type="button" role="radio" aria-checked={on} data-testid={`new-wallet-network-${n}`} data-network={n} disabled={busy && !on}
                onClick={() => switchNetwork(n)} onKeyDown={(e) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) { e.preventDefault(); switchNetwork(n === "mainnet" ? "testnet" : "mainnet"); (e.currentTarget.parentElement?.querySelector(`[data-network=${n === "mainnet" ? "testnet" : "mainnet"}]`) as HTMLElement | null)?.focus(); } }}
                tabIndex={on ? 0 : -1} className="new-wallet-network">
                <span className="new-wallet-network-dot" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="network-tag">{MONEY_LABEL[n]}</span>
                  <span className="block text-sm font-semibold text-text-primary mt-1">{NETWORK_NAME[n]}</span>
                  <span className="block text-[11px] leading-snug text-text-secondary mt-0.5">{n === "mainnet" ? "Bitcoin and dollars you own. Start small." : "Test coins, worth nothing. Try anything."}</span>
                </span>
              </button>
            );
          })}
        </div>

        {chosen && chosenOffer ? (
          <div className="space-y-3" data-testid="new-wallet-step">
            <button type="button" data-testid="new-wallet-back" disabled={busy} onClick={() => { setChosen(null); setPhase(null); }} className="text-xs text-text-secondary hover:text-text-primary cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">← All kinds of wallet</button>
            <div className="flex items-center gap-3">
              <Mark type={chosen} />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text-primary">{NETWORK_NAME[network]} {WALLET_NAME[chosen]}</p>
                <p className="text-xs text-text-secondary">{ABOUT[chosen](network)}</p>
              </div>
            </div>
            {chosenOffer.needs === "invite" && (
              <form className="space-y-2" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void create("fedimint", { invite }); }}>
                <label className="block text-xs text-text-secondary">Federation invite code
                  <input data-testid="new-wallet-invite" className={`${input} mt-1 font-mono text-xs`} value={invite} placeholder="fed11…" spellCheck={false} autoFocus disabled={busy} onChange={(e) => setInvite(e.target.value)} />
                </label>
                <p className="text-[11px] text-text-muted">Joining trusts the federation's guardians with the sats, like a Cashu mint.</p>
                <Button type="submit" variant="primary" className="w-full" disabled={busy || !invite.trim()} data-testid="new-wallet-create">{busy ? "Joining…" : "Join and create"}</Button>
              </form>
            )}
            {chosenOffer.needs === "provider" && (
              <div className="space-y-3" data-testid="new-wallet-provider">
                {(chosenOffer.providers?.length ?? 0) > 1 && (
                  <Select aria-label="Source" data-testid="new-wallet-provider-select" value={providerId} disabled={busy} onChange={(id) => { setProviderId(id); setPhase(null); }}
                    options={(chosenOffer.providers ?? []).map((p) => ({ value: p.id, label: p.label }))} />
                )}
                {descriptor?.description && <p className="text-xs text-text-secondary">{descriptor.description}</p>}
                {descriptor && Form && <Form key={`${network}-${descriptor.id}`} descriptor={descriptor} mode={network} busy={busy} onSubmit={(values) => void create(chosen, { providerId: descriptor.id, values })} />}
              </div>
            )}
          </div>
        ) : (
          <div role="group" aria-labelledby="new-wallet-kinds" className="space-y-2">
            <h3 id="new-wallet-kinds" className="text-xs font-semibold uppercase tracking-wide text-text-muted">Kinds of wallet on {NETWORK_NAME[network]}</h3>
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
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-text-primary">{WALLET_NAME[type]}</span>
                      <span className="block text-xs text-text-secondary mt-0.5">{action === "off" && o?.reason ? shortReason(o.reason) : ABOUT[type](network)}</span>
                    </span>
                    <span className="new-wallet-action" data-testid={`new-wallet-type-${type}-status`} data-kind={mine ?? action}>
                      {mine === "busy" ? <><span className="new-wallet-spinner" aria-hidden="true" />{BUSY_LABEL[type]}</>
                        : mine === "done" ? <><Check />Ready</>
                        : mine === "error" ? "Try again"
                        : action === "added" ? <><Check />Added</> : ACTION_LABEL[action]}
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
            {!offer(error.type)?.needs && <Button onClick={() => void create(error.type)} data-testid="new-wallet-retry">Try again</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

/** The steps of the wallet being made, each done, under way or to come; then Ready. */
function Progress({ phase, network }: { phase: Phase; network: WalletNetwork }) {
  const steps = [...STEPS[phase.type], "Ready"];
  const done = phase.state === "done";
  return (
    <div className="new-wallet-progress" role="status" aria-live="polite" data-testid="new-wallet-progress" data-state={phase.state}>
      <p className="text-xs text-text-secondary">{done ? `Your ${NETWORK_NAME[network]} ${WALLET_NAME[phase.type]} wallet is ready.` : `Making your ${NETWORK_NAME[network]} ${WALLET_NAME[phase.type]} wallet. Nothing is saved until its server answers.`}</p>
      <ol className="space-y-1.5 mt-2">
        {steps.map((step, i) => {
          const state = done || i < phase.step ? "done" : i === phase.step ? "active" : "todo";
          return (
            <li key={step} className="flex items-center gap-2 text-sm" data-testid={i === steps.length - 1 ? "new-wallet-ready" : "new-wallet-step"} data-state={state}>
              <span className="new-wallet-step-mark" aria-hidden="true">{state === "done" ? <Check /> : state === "active" ? <span className="new-wallet-spinner" /> : null}</span>
              <span className={state === "todo" ? "text-text-muted" : "text-text-primary"}>{step}{state === "active" ? "…" : ""}</span>
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
