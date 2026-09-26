import { useState } from "react";
import type { SourceView } from "@ghostly/browser/engine/paymentAdapters/providers/sources";
import type { ProviderDescriptorView, ProviderField } from "@ghostly/browser/engine/paymentAdapters/providers/types";
import { Block, Button, Notice, Row, Section, input } from "../ui";
import { useRun } from "../run";
import { Select } from "../../ui/Select";
import { PROVIDER_FORMS, type ProviderFormProps } from "./forms";
import { changeableFields, sourceStatus } from "./sourceStatus";


/** A field's suggested values that fit the other fields (`when`), as buttons that fill it in. */
function Suggestions({ field, values, onPick }: { field: ProviderField; values: Record<string, string | undefined>; onPick: (value: string) => void }) {
  const fitting = (field.suggestions ?? []).filter((s) => Object.entries(s.when ?? {}).every(([name, value]) => values[name] === value));
  if (!fitting.length) return null;
  return (
    <span className="flex flex-wrap gap-1.5" data-testid={`field-suggestions-${field.name}`}>
      {fitting.map((s) => (
        <button key={s.value} type="button" title={s.value} data-value={s.value} onClick={() => onPick(s.value)}
          className={`text-[11px] px-2 py-0.5 rounded-full border ${values[field.name] === s.value ? "border-accent text-accent" : "border-border text-text-secondary hover:text-text-primary"}`}>{s.label}</button>
      ))}
    </span>
  );
}

/**
 * Changes where a saved source reads from (its `changeable` fields, a server address) without typing its
 * secrets again: the same wallet, another server.
 */
function ServerForm({ kind, fields, config, busy, onSubmit, onCancel }: { kind: string; fields: ProviderField[]; config: Record<string, string>; busy: boolean; onSubmit: (values: Record<string, string>) => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, config[f.name] ?? ""])));
  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));
  return (
    <form className="space-y-3" data-testid={`${kind}-source-server-form`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); onSubmit(values); }}>
      {fields.map((field, i) => (
        <div key={field.name} className="space-y-1">
          <label className="block space-y-1">
            <span className="text-xs text-text-secondary">{field.label}{field.optional && <span className="text-text-muted"> (optional)</span>}</span>
            {/* Opened from the card's own button, further up: focusing it brings the form into view. */}
            <input aria-label={field.label} autoFocus={i === 0} className={`${input} font-mono text-xs`} type={field.kind === "url" ? "url" : "text"} spellCheck={false} placeholder={field.placeholder} value={values[field.name]} onChange={(e) => set(field.name, e.target.value)} />
          </label>
          <Suggestions field={field} values={{ ...config, ...values }} onPick={(value) => set(field.name, value)} />
          {field.help && <span className="block text-[11px] text-text-muted">{field.help}</span>}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={busy} data-testid={`${kind}-source-server-save`}>{busy ? "Connecting…" : "Use this server"}</Button>
        <Button type="button" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
      <Notice>The wallet stays the same; only where it reads the chain changes. It is checked before it is saved.</Notice>
    </form>
  );
}

/** The form built from a provider's declared fields. Secret fields are password inputs, never filled back in. */
export function ProviderConfigForm({ descriptor, mode, busy, onSubmit }: ProviderFormProps) {
  const initial = () => Object.fromEntries(descriptor.fields.map((f) => [f.name, f.defaults?.[mode] ?? (f.kind === "select" ? f.options?.[0]?.value ?? "" : "")]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));
  return (
    <form className="space-y-3" data-testid={`provider-form-${descriptor.id}`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); onSubmit(values); }}>
      {descriptor.fields.map((field) => (
        // The suggestions are buttons: beside the label, not inside it (a label holds one control).
        <div key={field.name} className="space-y-1">
          <label className="block space-y-1">
            <span className="text-xs text-text-secondary">{field.label}{field.optional && <span className="text-text-muted"> (optional)</span>}</span>
            {field.kind === "select" ? (
              <Select aria-label={field.label} value={values[field.name]} onChange={(v) => set(field.name, v)} options={field.options ?? []} />
            ) : field.kind === "textarea" ? (
              <textarea aria-label={field.label} className={`${input} font-mono text-xs resize-none`} rows={3} placeholder={field.placeholder} value={values[field.name]} onChange={(e) => set(field.name, e.target.value)} />
            ) : (
              <input aria-label={field.label} className={`${input} ${field.kind === "text" ? "" : "font-mono text-xs"}`} type={field.kind === "secret" ? "password" : field.kind === "url" ? "url" : "text"}
                autoComplete={field.kind === "secret" ? "new-password" : "off"} spellCheck={false} placeholder={field.placeholder} value={values[field.name]} onChange={(e) => set(field.name, e.target.value)} />
            )}
          </label>
          {field.kind !== "secret" && <Suggestions field={field} values={values} onPick={(value) => set(field.name, value)} />}
          {field.help && <span className="block text-[11px] text-text-muted">{field.help}</span>}
        </div>
      ))}
      <Button type="submit" variant="primary" className="w-full" disabled={busy} data-testid="provider-save">{busy ? "Connecting…" : `Use ${descriptor.label}`}</Button>
      {descriptor.fields.some((f) => f.kind === "secret") && <Notice>Secrets are sealed on this device and never shown again.</Notice>}
    </form>
  );
}

/**
 * Where a card's money comes from: the source in use for this mode, and (with `onSet`) the providers that can
 * replace it, each with its own form. Mainnet and Testnet keep separate sources; a Lightning card keeps its own
 * (no `onSet`: another source is another card, made with New). A source that is not connected can be tried again
 * now (Retry), and one with a server can move to another (Change server) keeping its wallet; `changing` /
 * `onChanging` let the card open that form from its own Change server button.
 */
export function SourcePicker({ kind, view, onSet, onClear, onRetry, onReconfigure, changing, onChanging }: {
  kind: "lightning" | "onchain"; view: SourceView;
  onSet?: (providerId: string, values: Record<string, string>) => Promise<void>; onClear?: () => Promise<void>;
  onRetry?: () => Promise<void>; onReconfigure?: (values: Record<string, string>) => Promise<void>;
  changing?: boolean; onChanging?: (open: boolean) => void;
}) {
  const { busy, error, run } = useRun();
  const [chosen, setChosen] = useState<string>("");
  const [saved, setSaved] = useState("");
  const [ownChanging, setOwnChanging] = useState(false);
  const serverOpen = changing ?? ownChanging, setServerOpen = onChanging ?? setOwnChanging;
  const offered = view.offered;
  const descriptor: ProviderDescriptorView | undefined = offered.find((d) => d.id === chosen);
  const Form = descriptor ? PROVIDER_FORMS[descriptor.id] ?? ProviderConfigForm : null;
  const current = offered.find((d) => d.id === view.providerId);
  const serverFields = onReconfigure ? changeableFields(view) : [];
  const failing = view.status === "error" || (view.status === "connecting" && !!view.failures);
  const submit = (values: Record<string, string>) => void run(async () => { setSaved(""); await onSet!(descriptor!.id, values); setChosen(""); setSaved(`${descriptor!.label} is now your ${kind === "onchain" ? "Bitcoin" : "Lightning"} source.`); });
  const reconfigure = (values: Record<string, string>) => void run(async () => { setSaved(""); await onReconfigure!(values); setServerOpen(false); setSaved(`${view.label ?? "The source"} now uses that server.`); });

  return (
    <Section title="Source" testId={`${kind}-source`}>
      <Row testId={`${kind}-source-current`}
        label={view.providerId ? <>{view.label ?? view.providerId}{view.isDefault && onSet && <span className="text-accent ml-2 text-[10px] uppercase tracking-wider">Default</span>}</> : "No source"}
        hint={<span data-testid={`${kind}-source-status`}>{sourceStatus(view)}</span>}>
        {onRetry && failing && view.providerId && <Button disabled={busy} onClick={() => void run(onRetry)} data-testid={`${kind}-source-retry`}>Retry</Button>}
        {serverFields.length > 0 && !serverOpen && <Button disabled={busy} onClick={() => { setServerOpen(true); setSaved(""); }} data-testid={`${kind}-source-change-server`}>Change server</Button>}
        {onClear && view.providerId && !view.isDefault && <Button disabled={busy} onClick={() => void run(onClear)} data-testid={`${kind}-source-clear`}>{kind === "lightning" ? "Back to Cashu mints" : "Remove"}</Button>}
      </Row>
      {serverOpen && serverFields.length > 0 && (
        <Block><ServerForm kind={kind} fields={serverFields} config={view.config ?? {}} busy={busy} onSubmit={reconfigure} onCancel={() => setServerOpen(false)} /></Block>
      )}
      {!onSet ? (saved || error) && <Block>
        {saved && <Notice tone="success" testId={`${kind}-source-saved`}>{saved}</Notice>}
        {error && <Notice tone="error" testId={`${kind}-source-error`}>{error}</Notice>}
      </Block> : <Block>
        {offered.length === 0 ? (
          <Notice testId={`${kind}-source-none-offered`}>No {kind === "onchain" ? "on-chain Bitcoin" : "Lightning"} provider is available here yet{view.mode === "testnet" ? " in Testnet" : ""}.</Notice>
        ) : (
          <label className="block space-y-1">
            <span className="text-xs text-text-secondary">{view.providerId ? "Change source" : "Choose a source"}</span>
            <Select aria-label={`${kind === "onchain" ? "Bitcoin" : "Lightning"} source`} data-testid={`${kind}-source-select`} value={chosen} placeholder={`${offered.length} available…`}
              onChange={(v) => { setChosen(v); setSaved(""); }}
              options={offered.map((d) => ({
                value: d.id,
                label: d.label,
                description: [d.custodial && "Custodial", d.experimental && "Experimental", d.id === view.providerId && "In use"].filter(Boolean).join(" · ") || undefined,
                disabled: d.id === current?.id && view.status === "ready" && d.fields.length === 0,
              }))} />
          </label>
        )}
        {descriptor && Form && (
          <div className="space-y-3" data-testid={`${kind}-source-config`}>
            <p className="text-xs text-text-muted">{descriptor.description}</p>
            <Form key={descriptor.id} descriptor={descriptor} mode={view.mode} busy={busy} onSubmit={submit} />
          </div>
        )}
        {saved && <Notice tone="success" testId={`${kind}-source-saved`}>{saved}</Notice>}
        {error && <Notice tone="error" testId={`${kind}-source-error`}>{error}</Notice>}
        <Notice>{view.mode === "testnet" ? "This is the Testnet wallet's source; a Mainnet wallet has its own." : "This is the Mainnet wallet's source; a Testnet wallet has its own."}</Notice>
      </Block>}
    </Section>
  );
}
