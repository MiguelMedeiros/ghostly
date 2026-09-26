import { useRef, useState } from "react";
import type { WalletInstanceView, WalletNetwork, WalletOffer, WalletPlatform, WalletType } from "../../lib/platform";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { WalletMark } from "../WalletCards";
import { FieldGrid } from "../layout";
import { Select } from "../ui/Select";
import { Button, Notice, Segmented, input } from "./ui";
import { ProviderConfigForm } from "./providers/SourcePicker";
import { PROVIDER_FORMS } from "./providers/forms";

/** What each kind of wallet is, in a line, on each network. */
const ABOUT: Record<WalletType, { name: string; line: (network: WalletNetwork) => string }> = {
  cashu: { name: "Cashu", line: (n) => n === "testnet" ? "Ecash over Lightning, on the public test mint." : "Ecash over Lightning, held at well-audited mints." },
  lightning: { name: "Lightning", line: () => "Your own Lightning wallet or node: NWC, LND, Core Lightning and more." },
  arkade: { name: "Ark", line: (n) => n === "testnet" ? "Arkade on Mutinynet: fast, cheap payments off the chain." : "Arkade on Bitcoin: fast, cheap payments off the chain." },
  bark: { name: "Bark", line: () => "Second's Ark, on signet." },
  spark: { name: "Spark", line: () => "A Spark wallet (Breez), on regtest." },
  bitcoin: { name: "Bitcoin", line: () => "On-chain bitcoin: a BDK wallet, or your own node." },
  fedimint: { name: "Fedimint", line: () => "Ecash of a federation you join with its invite code." },
  usdt: { name: "USDT", line: (n) => n === "testnet" ? "Test USDT on Sepolia." : "USDT on Ethereum." },
};
/** The deck's order. */
const TYPES: WalletType[] = ["cashu", "lightning", "arkade", "bark", "spark", "bitcoin", "fedimint", "usdt"];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Wallets → New: a network, then a kind of wallet. One that needs nothing is made on that click, with the network's
 * known-good defaults, and checked before its card appears; one that needs one thing (an invite, a source's form)
 * asks for just that. A failure says why once, and nothing is left half made.
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
  const [busy, setBusy] = useState<WalletType | null>(null);
  const [error, setError] = useState<{ type: WalletType; text: string } | null>(null);
  const [invite, setInvite] = useState("");
  const [providerId, setProviderId] = useState("");
  const close = () => { if (!busy) onClose(); };
  useDialogFocus(dialog, close);
  const backdrop = useBackdropDismiss(close);
  const offer = (type: WalletType) => offers.find((o) => o.type === type && o.network === network);

  const create = async (type: WalletType, extra: { invite?: string; providerId?: string; values?: Record<string, string> } = {}) => {
    setBusy(type); setError(null);
    try { onCreated(await wallet.create({ type, network, ...extra })); }
    catch (e) { setError({ type, text: message(e) }); }
    finally { setBusy(null); }
  };
  const pick = (type: WalletType) => {
    const o = offer(type);
    if (!o?.available || busy || (o.exists && type !== "fedimint")) return;
    setError(null);
    // One click: nothing to ask, so it is made now.
    if (!o.needs) { setChosen(type); void create(type); return; }
    setChosen(type);
    setProviderId(o.providers?.[0]?.id ?? "");
  };
  const status = (o: WalletOffer | undefined, type: WalletType) =>
    busy === type ? "Creating…" : !o ? "Unavailable" : o.exists && type !== "fedimint" ? "Added" : !o.available ? "Not yet" : o.needs === "invite" ? "Needs an invite" : o.needs === "provider" ? "Choose a source" : "One click";

  const chosenOffer = chosen ? offer(chosen) : undefined;
  const descriptor = chosenOffer?.providers?.find((p) => p.id === providerId);
  const Form = descriptor ? PROVIDER_FORMS[descriptor.id] ?? ProviderConfigForm : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in" {...backdrop}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="new-wallet-title" data-testid="new-wallet"
        className="focus:outline-none w-full max-w-lg max-h-[90dvh] overflow-y-auto bg-panel-header border border-border rounded-2xl shadow-2xl p-5 space-y-4 @container">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="new-wallet-title" className="text-lg font-medium text-text-primary">New wallet</h2>
            <p className="text-xs text-text-muted mt-1">Each wallet has its own network. Test coins and real money never mix: a Testnet wallet never pays for real money.</p>
          </div>
          <button type="button" aria-label="Close" onClick={close} className="grid place-items-center w-10 h-10 shrink-0 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-alt cursor-pointer">×</button>
        </div>
        <div data-testid="new-wallet-network" data-network={network}>
          <Segmented label="Network" value={network} disabled={!!busy}
            options={[{ value: "testnet", label: "Testnet" }, { value: "mainnet", label: "Mainnet" }]}
            onChange={(next) => { setNetwork(next); setChosen(null); setError(null); }} />
          <p className="text-xs text-text-muted mt-1.5">{network === "testnet" ? "Test networks and test coins, worth nothing: for trying things out." : "Real money. Start small: these wallets are young."}</p>
        </div>
        <div role="group" aria-label="Kinds of wallet">
          <FieldGrid min="14rem" max={2}>
            {TYPES.map((type) => {
              const o = offer(type), off = !o?.available || (o.exists && type !== "fedimint");
              return (
                <button key={type} type="button" data-testid={`new-wallet-type-${type}`} data-state={busy === type ? "busy" : off ? "off" : "on"}
                  aria-disabled={off || undefined} aria-pressed={chosen === type} title={!o?.available ? o?.reason : undefined} disabled={!!busy && busy !== type}
                  onClick={() => pick(type)}
                  className={`text-left flex items-start gap-3 rounded-xl border p-3 min-h-11 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${off ? "opacity-55 cursor-not-allowed border-border" : chosen === type ? "border-accent bg-accent/5" : "border-border hover:bg-surface-alt"}`}>
                  <span className={`wallet-card-${type} shrink-0 grid place-items-center w-9 h-9 rounded-lg`} style={{ color: "rgb(var(--card-rgb))", background: "rgba(var(--card-rgb), .14)" }} aria-hidden="true"><WalletMark rail={type} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-text-primary">{ABOUT[type].name}</span>
                      <span className="text-[11px] text-text-muted whitespace-nowrap" data-testid={`new-wallet-type-${type}-status`}>{status(o, type)}</span>
                    </span>
                    <span className="block text-xs text-text-secondary mt-0.5">{!o?.available && o?.reason ? o.reason : ABOUT[type].line(network)}</span>
                  </span>
                </button>
              );
            })}
          </FieldGrid>
        </div>
        {chosen && chosenOffer?.needs === "invite" && (
          <form className="space-y-2" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void create("fedimint", { invite }); }}>
            <label className="block text-xs text-text-secondary">Federation invite code
              <input data-testid="new-wallet-invite" className={`${input} mt-1 font-mono text-xs`} value={invite} placeholder="fed11…" spellCheck={false} autoFocus disabled={!!busy} onChange={(e) => setInvite(e.target.value)} />
            </label>
            <p className="text-[11px] text-text-muted">Joining trusts the federation's guardians with the sats, like a Cashu mint.</p>
            <Button type="submit" variant="primary" className="w-full" disabled={!!busy || !invite.trim()} data-testid="new-wallet-create">{busy ? "Joining…" : "Join and create"}</Button>
          </form>
        )}
        {chosen && chosenOffer?.needs === "provider" && (
          <div className="space-y-3" data-testid="new-wallet-provider">
            {(chosenOffer.providers?.length ?? 0) > 1 && (
              <Select aria-label="Source" data-testid="new-wallet-provider-select" value={providerId} disabled={!!busy} onChange={(id) => { setProviderId(id); setError(null); }}
                options={(chosenOffer.providers ?? []).map((p) => ({ value: p.id, label: p.label }))} />
            )}
            {descriptor?.description && <p className="text-xs text-text-secondary">{descriptor.description}</p>}
            {descriptor && Form && <Form key={`${network}-${descriptor.id}`} descriptor={descriptor} mode={network} busy={!!busy} onSubmit={(values) => void create(chosen, { providerId: descriptor.id, values })} />}
          </div>
        )}
        {busy && !chosenOffer?.needs && <Notice testId="new-wallet-progress">Creating your {network === "testnet" ? "Testnet" : "Mainnet"} {ABOUT[busy].name} wallet and checking its server…</Notice>}
        {error && (
          <div className="space-y-2">
            <Notice tone="error" testId="new-wallet-error">{error.text}</Notice>
            {!offer(error.type)?.needs && <Button onClick={() => void create(error.type)} data-testid="new-wallet-retry">Try again</Button>}
          </div>
        )}
      </div>
    </div>
  );
}
