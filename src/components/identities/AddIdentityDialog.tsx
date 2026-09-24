import { useEffect, useRef, useState } from "react";
import { identityStatement, type IdentityStatement } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { availableSigners } from "@ghostly/browser/proofs/verify";
import type { IdentityProofProvider, IdentitySigner, SignerContext, SignerInstructions } from "@ghostly/browser/proofs/contract";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { addableProviders, identityPlatform } from "../../lib/identities";
import { FieldGrid } from "../layout";
import { Button, Notice, input } from "../wallet/ui";
import { ProviderMark, StatusPill } from "./ProviderMark";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const VALIDITY = [7, 30, 90, 180, 365];

/** A statement waiting for its evidence: shown to the person (instructions), then checked by the engine. */
interface Pending { draftId: string; statement: IdentityStatement; instructions?: SignerInstructions }

/**
 * Identities → Add. Renders any provider from its descriptor: pick the kind of identity, the
 * signer, the subject and how long it lasts; then the signer's flow by its kind. The engine verifies the
 * evidence exactly as a contact will before anything is saved.
 */
export function AddIdentityDialog({ onClose }: { onClose: () => void }) {
  const providers = addableProviders();
  const platform = identityPlatform();
  // Always the picker first, even with one provider: the flow is the same whatever is registered.
  const [provider, setProvider] = useState<IdentityProofProvider | null>(null);
  /** The card whose details are open in the picker (reading, not adding). */
  const [about, setAbout] = useState<string | null>(null);
  const signers = provider ? availableSigners(provider, platform) : [];
  const [signerId, setSignerId] = useState("");
  const signer: IdentitySigner<unknown> | undefined = signers.find(s => s.id === signerId) ?? signers[0];
  const [subject, setSubject] = useState("");
  const [days, setDays] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [pasted, setPasted] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [progress, setProgress] = useState(""), [authUrl, setAuthUrl] = useState("");
  const abort = useRef<AbortController | null>(null);
  const draft = useRef<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  const close = () => {
    abort.current?.abort();
    if (draft.current) void engine.call("cancelIdentityProof", { draftId: draft.current }).catch(() => {});
    draft.current = null; setValues({}); setPasted("");
    onClose();
  };
  useDialogFocus(dialog, close);
  const backdrop = useBackdropDismiss(close);
  useEffect(() => () => abort.current?.abort(), []);

  const validity = days || provider?.validity.defaultDays || 30;
  const validityOptions = provider ? [...new Set([...VALIDITY.filter(d => d <= provider.validity.maxDays), provider.validity.defaultDays])].sort((a, b) => a - b) : [];
  const choose = (p: IdentityProofProvider) => { setProvider(p); setSignerId(""); setSubject(p.subject.options?.[0]?.value ?? ""); setDays(0); setError(""); };

  async function begin(forSubject: string): Promise<Pending> {
    const { draftId, binding } = await engine.call("beginIdentityProof", { provider: provider!.id, subject: forSubject, validityDays: validity });
    draft.current = draftId;
    return { draftId, statement: identityStatement(binding) };
  }
  async function complete(draftId: string, evidence: unknown) {
    setProgress("Checking it the way your contacts will…");
    await engine.call("completeIdentityProof", { draftId, evidence });
    draft.current = null;
    close();
  }
  async function run(work: (ctx: SignerContext) => Promise<void>) {
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError(""); setProgress(""); setAuthUrl("");
    const ctx: SignerContext = { values, signal: controller.signal, onAuthUrl: setAuthUrl, onProgress: setProgress };
    try { await work(ctx); }
    catch (e) { if (!controller.signal.aborted) setError(message(e)); setProgress(""); }
    finally { setBusy(false); if (abort.current === controller) abort.current = null; setValues(v => Object.fromEntries(Object.keys(v).map(k => [k, signer?.kind === "in-app" && signer.fields?.find(f => f.name === k)?.kind === "secret" ? "" : v[k]]))); }
  }

  const start = () => void run(async ctx => {
    if (!provider || !signer) return;
    if (signer.kind === "in-app") {
      await signer.run(ctx, async session => {
        setProgress("Asking your signer which identity it holds…");
        const p = await begin(await session.subject());
        ctx.signal.throwIfAborted();
        const evidence = await session.sign(p.statement);
        ctx.signal.throwIfAborted();
        await complete(p.draftId, evidence);
      });
    } else {
      // A redirect signer opens its popup in the next click: that needs the click's user activation,
      // which an engine round trip here would use up.
      const p = await begin(subject);
      setPending({ ...p, instructions: signer.kind === "redirect" ? undefined : signer.instructions(p.statement) });
    }
  });
  const finish = () => void run(async ctx => {
    if (!pending || !signer) return;
    if (signer.kind === "redirect") {
      // Called synchronously from the click: nothing is awaited before start().
      const evidence = signer.start(pending.statement, ctx);
      setProgress(`Continue in the ${provider!.label} window…`);
      const token = await evidence;
      ctx.signal.throwIfAborted();
      await complete(pending.draftId, token);
    } else if (signer.kind === "external-tool") await complete(pending.draftId, await signer.parse(pasted, pending.statement));
    else if (signer.kind === "publish") await complete(pending.draftId, await signer.evidence(pending.statement));
  });

  const needsSubject = signer && signer.kind !== "in-app";
  const fieldsFilled = signer?.kind !== "in-app" || (signer.fields ?? []).every(f => f.optional || values[f.name]?.trim());
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in" {...backdrop}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="add-identity-title" data-testid="add-identity"
        className="focus:outline-none w-full max-w-lg max-h-[90dvh] overflow-y-auto bg-panel-header border border-border rounded-2xl shadow-2xl p-5 space-y-4 @container">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="add-identity-title" className="text-lg font-medium text-text-primary">Add an identity</h2>
            <p className="text-xs text-text-muted mt-1">Optional. Nothing is shared until you choose a contact in a chat.</p>
          </div>
          <button type="button" aria-label="Close" onClick={close} className="grid place-items-center w-10 h-10 shrink-0 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-alt cursor-pointer">×</button>
        </div>

        {!provider ? (
          providers.length ? (
            <div role="list" aria-label="Kinds of identity">
              <FieldGrid min="22rem" max={2}>
                {providers.map(p => <ProviderCard key={p.id} provider={p} open={about === p.id} onAbout={() => setAbout(about === p.id ? null : p.id)} onChoose={() => choose(p)} />)}
              </FieldGrid>
            </div>
          ) : <Notice>No kind of identity can be added in this app yet.</Notice>
        ) : pending ? (
          <div className="space-y-3">
            <p className="text-sm text-text-primary">{signer?.label}</p>
            {signer?.kind === "redirect" && <p className="text-sm text-text-secondary">{provider!.label} will ask you to log in. It then vouches for the account to Ghostly with a signed token; your password never reaches Ghostly.</p>}
            <ol className="space-y-3 list-decimal pl-5 text-sm text-text-secondary">
              {pending.instructions?.steps.map((step, i) => (
                <li key={i} className="space-y-2">
                  <p>{step.text}</p>
                  {step.copy && <CopyBlock text={step.copy} testId={`add-identity-copy-${i}`} />}
                </li>
              ))}
            </ol>
            {signer?.kind === "external-tool" && pending.instructions?.paste && (
              <label className="block text-xs text-text-muted">{pending.instructions.paste.label}
                {pending.instructions.paste.multiline
                  ? <textarea data-testid="add-identity-paste" className={`${input} mt-1 h-32 font-mono`} value={pasted} onChange={e => setPasted(e.target.value)} placeholder={pending.instructions.paste.placeholder} spellCheck={false} />
                  : <input data-testid="add-identity-paste" className={`${input} mt-1 font-mono`} value={pasted} onChange={e => setPasted(e.target.value)} placeholder={pending.instructions.paste.placeholder} spellCheck={false} autoComplete="off" />}
              </label>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={close}>Cancel</Button>
              <Button variant="primary" data-testid="add-identity-finish" disabled={busy || (signer?.kind === "external-tool" && !pasted.trim())} onClick={finish}>{busy ? (signer?.kind === "redirect" ? "Waiting…" : "Checking…") : signer?.kind === "publish" ? "Check and save" : signer?.kind === "redirect" ? `Continue with ${provider!.label}` : "Verify and save"}</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <ProviderMark provider={provider.id} subject={needsSubject ? subject : undefined} />
              <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-sm text-text-primary">{provider.label}</p>
                <CategoryPill provider={provider} />
              </div>
              <Button disabled={busy} onClick={() => { setProvider(null); setError(""); }}>Back</Button>
            </div>
            <ProviderAbout provider={provider} testId="add-identity-about" />
            {signers.length > 1 && (
              <label className="block text-xs text-text-muted">Sign with
                <select data-testid="add-identity-signer" className={`${input} mt-1`} value={signer?.id} disabled={busy} onChange={e => { setSignerId(e.target.value); setError(""); }}>
                  {signers.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </label>
            )}
            {signer?.description && <p className="text-xs text-text-muted">{signer.description}</p>}
            {signer?.kind === "in-app" && signer.fields?.map(f => (
              <label key={f.name} className="block text-xs text-text-muted">{f.label}
                <input data-testid={`add-identity-field-${f.name}`} className={`${input} mt-1`} type={f.kind === "secret" ? "password" : "text"} autoComplete="off" spellCheck={false}
                  value={values[f.name] ?? ""} placeholder={f.placeholder} disabled={busy} onChange={e => setValues({ ...values, [f.name]: e.target.value })} />
                {f.help && <span className="block mt-1">{f.help}</span>}
              </label>
            ))}
            {needsSubject && (provider.subject.options ? (
              <div className="text-xs text-text-muted" role="radiogroup" aria-label={provider.subject.label} data-testid="add-identity-subject" data-value={subject}>{provider.subject.label}
                <div className="mt-1 grid gap-2 grid-cols-2 @sm:grid-cols-3">
                  {provider.subject.options.map(o => (
                    <button key={o.value} type="button" role="radio" aria-checked={subject === o.value} disabled={busy} onClick={() => setSubject(o.value)}
                      className={`flex items-center gap-2 rounded-xl border p-2 text-sm cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${subject === o.value ? "border-accent bg-accent/5 text-text-primary" : "border-border text-text-secondary hover:bg-surface-alt"}`}>
                      <ProviderMark provider={provider.id} subject={o.value} /><span className="truncate">{o.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <label className="block text-xs text-text-muted">{provider.subject.label}
                <input data-testid="add-identity-subject" className={`${input} mt-1 font-mono`} value={subject} placeholder={provider.subject.placeholder} disabled={busy} spellCheck={false} autoComplete="off" onChange={e => setSubject(e.target.value)} />
                {provider.subject.help && <span className="block mt-1">{provider.subject.help}</span>}
              </label>
            ))}
            <label className="block text-xs text-text-muted">Valid for
              <select data-testid="add-identity-validity" className={`${input} mt-1`} value={validity} disabled={busy} onChange={e => setDays(Number(e.target.value))}>
                {validityOptions.map(d => <option key={d} value={d}>{d} days</option>)}
              </select>
            </label>
            <p className="text-xs text-text-muted">{provider.privacy} Sharing the same identity with several contacts lets them know it is the same person.</p>
            {provider.experimental && <Notice tone="warning">Experimental: not yet tested with every tool.</Notice>}
            <div className="flex flex-wrap justify-end gap-2">
              {busy && <Button onClick={() => { abort.current?.abort(); setProgress(""); setError("Cancelled. Nothing was saved."); }}>Cancel</Button>}
              <Button variant="primary" data-testid="add-identity-start" disabled={busy || !signer || !fieldsFilled || (needsSubject && !subject.trim())} onClick={start}>
                {busy ? "Waiting…" : signer?.kind === "in-app" ? `Sign with ${signer.label.replace(/ \(.*\)$/, "")}` : "Continue"}
              </Button>
            </div>
          </div>
        )}
        {authUrl && <a href={authUrl} target="_blank" rel="noreferrer noopener" className="block text-xs text-accent underline">Open your signer to approve</a>}
        {progress && <Notice testId="add-identity-progress">{progress}</Notice>}
        {error && <Notice tone="error" testId="add-identity-error">{error}</Notice>}
      </div>
    </div>
  );
}

const CategoryPill = ({ provider }: { provider: IdentityProofProvider }) => <StatusPill>{provider.category === "provider-attested" ? "Attested by a provider" : "Your own key"}</StatusPill>;

/**
 * One kind of identity in the picker: its mark, name, category and one line, to be recognized at a glance.
 * The card starts adding it; "About" opens the explanation in place, for reading without starting.
 */
function ProviderCard({ provider: p, open, onAbout, onChoose }: { provider: IdentityProofProvider; open: boolean; onAbout: () => void; onChoose: () => void }) {
  const aboutId = `add-identity-about-${p.id}`;
  return (
    <div role="listitem" data-testid={`add-identity-card-${p.id}`} className="@container rounded-xl border border-border">
      <div className="flex items-stretch">
        <button type="button" data-testid={`add-identity-${p.id}`} onClick={onChoose}
          className="flex flex-1 min-w-0 items-center gap-3 p-3 min-h-11 text-left rounded-l-xl hover:bg-surface-alt cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
          <ProviderMark provider={p.id} />
          <span className="min-w-0 flex-1">
            {/* The category beside the name where the card is wide enough for every name, under it otherwise: never a mix. */}
            <span className="flex flex-col items-start gap-y-1 @md:flex-row @md:items-center @md:gap-x-2">
              <span className="text-sm text-text-primary truncate max-w-full">{p.label}</span>
              <CategoryPill provider={p} />
            </span>
            <span data-testid="add-identity-summary" className="block text-xs text-text-muted mt-0.5">{p.summary}</span>
            {p.subject.options && p.subject.options.length > 0 && (
              <span className="flex flex-wrap gap-1 mt-1.5">{p.subject.options.map(o => <ProviderMark key={o.value} provider={p.id} subject={o.value} small />)}</span>
            )}
          </span>
        </button>
        <button type="button" data-testid={`add-identity-about-${p.id}`} aria-label={`About ${p.label}`} aria-expanded={open} aria-controls={aboutId} onClick={onAbout}
          className={`grid place-items-center w-11 min-h-11 shrink-0 rounded-r-xl hover:bg-surface-alt cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${open ? "text-accent" : "text-text-muted hover:text-text-primary"}`}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
        </button>
      </div>
      {open && <div id={aboutId} className="border-t border-border px-3 py-3"><ProviderAbout provider={p} /></div>}
    </div>
  );
}

/** What a proof of this kind shows, what it does not, and who could have made it. Above the form and behind "About". */
function ProviderAbout({ provider: p, testId = "identity-about" }: { provider: IdentityProofProvider; testId?: string }) {
  return (
    <div data-testid={testId} className="space-y-1.5 text-xs">
      <p className="text-text-secondary">{p.description}</p>
      {p.limits && (
        <p data-testid="identity-about-limits" className="flex items-start gap-1.5 text-text-muted">
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
          <span>{p.limits}</span>
        </p>
      )}
      <p className="text-text-muted">{p.category === "provider-attested" ? "A company vouches that you logged in to this account. Your contacts see who vouches." : "Only the holder of this key can make this proof."}</p>
    </div>
  );
}

function CopyBlock({ text, testId }: { text: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5">
      <code data-testid={testId} className="block break-all select-all whitespace-pre-wrap bg-surface-alt rounded-lg p-2.5 text-xs text-text-primary font-mono">{text}</code>
      <Button onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</Button>
    </div>
  );
}
