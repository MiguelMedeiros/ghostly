import { useEffect, useRef, useState } from "react";
import { identityStatement, type IdentityStatement } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { availableSigners } from "@ghostly/browser/proofs/verify";
import type { IdentityProofProvider, IdentitySigner, SignerContext, SignerInstructions } from "@ghostly/browser/proofs/contract";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { addableProviders, identityPlatform } from "../../lib/identities";
import { Button, Notice, input } from "../wallet/ui";
import { ProviderMark, StatusPill } from "./ProviderMark";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const VALIDITY = [7, 30, 90, 180, 365];

/** A statement waiting for its evidence: shown to the person (instructions), then checked by the engine. */
interface Pending { draftId: string; statement: IdentityStatement; instructions?: SignerInstructions }

/**
 * Profile → Identities → Add. Renders any provider from its descriptor: pick the kind of identity, the
 * signer, the subject and how long it lasts; then the signer's flow by its kind. The engine verifies the
 * evidence exactly as a contact will before anything is saved.
 */
export function AddIdentityDialog({ onClose }: { onClose: () => void }) {
  const providers = addableProviders();
  const platform = identityPlatform();
  const [provider, setProvider] = useState<IdentityProofProvider | null>(providers.length === 1 ? providers[0] : null);
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
            <div className="grid gap-2 grid-cols-1 @sm:grid-cols-2" role="list" aria-label="Kinds of identity">
              {providers.map(p => (
                <button key={p.id} type="button" role="listitem" data-testid={`add-identity-${p.id}`} onClick={() => choose(p)}
                  className="flex items-start gap-3 rounded-xl border border-border p-3 text-left hover:bg-surface-alt cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  <ProviderMark provider={p.id} />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2"><span className="text-sm text-text-primary">{p.label}</span><StatusPill>{p.category === "provider-attested" ? "Attested by a provider" : "Your own key"}</StatusPill></span>
                    <span className="block text-xs text-text-muted mt-1">{p.description}</span>
                  </span>
                </button>
              ))}
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
              <ProviderMark provider={provider.id} />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-text-primary">{provider.label}</p>
                <p className="text-xs text-text-muted">{provider.category === "provider-attested" ? "A company vouches that you logged in to this account. Your contacts see who vouches." : "Only the holder of this key can make this proof."}</p>
              </div>
              {providers.length > 1 && <Button disabled={busy} onClick={() => { setProvider(null); setError(""); }}>Back</Button>}
            </div>
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
              <label className="block text-xs text-text-muted">{provider.subject.label}
                <select data-testid="add-identity-subject" className={`${input} mt-1`} value={subject} disabled={busy} onChange={e => setSubject(e.target.value)}>
                  {provider.subject.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
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

function CopyBlock({ text, testId }: { text: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5">
      <code data-testid={testId} className="block break-all select-all whitespace-pre-wrap bg-surface-alt rounded-lg p-2.5 text-xs text-text-primary font-mono">{text}</code>
      <Button onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</Button>
    </div>
  );
}
