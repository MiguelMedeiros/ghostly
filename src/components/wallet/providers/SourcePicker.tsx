import { useState } from "react";
import type { SourceView } from "@ghostly/browser/engine/paymentAdapters/providers/sources";
import type { ProviderDescriptorView } from "@ghostly/browser/engine/paymentAdapters/providers/types";
import { Block, Button, Notice, Row, Section, input } from "../ui";
import { useRun } from "../run";
import { Select } from "../../ui/Select";
import { PROVIDER_FORMS, type ProviderFormProps } from "./forms";

const STATUS = { none: "Not set up", connecting: "Connecting…", ready: "Connected", error: "Not connected" } as const;

/** The form built from a provider's declared fields. Secret fields are password inputs, never filled back in. */
export function ProviderConfigForm({ descriptor, mode, busy, onSubmit }: ProviderFormProps) {
  const initial = () => Object.fromEntries(descriptor.fields.map((f) => [f.name, f.defaults?.[mode] ?? (f.kind === "select" ? f.options?.[0]?.value ?? "" : "")]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));
  return (
    <form className="space-y-3" data-testid={`provider-form-${descriptor.id}`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); onSubmit(values); }}>
      {descriptor.fields.map((field) => (
        <label key={field.name} className="block space-y-1">
          <span className="text-xs text-text-secondary">{field.label}{field.optional && <span className="text-text-muted"> (optional)</span>}</span>
          {field.kind === "select" ? (
            <Select aria-label={field.label} value={values[field.name]} onChange={(v) => set(field.name, v)} options={field.options ?? []} />
          ) : field.kind === "textarea" ? (
            <textarea aria-label={field.label} className={`${input} font-mono text-xs resize-none`} rows={3} placeholder={field.placeholder} value={values[field.name]} onChange={(e) => set(field.name, e.target.value)} />
          ) : (
            <input aria-label={field.label} className={`${input} ${field.kind === "text" ? "" : "font-mono text-xs"}`} type={field.kind === "secret" ? "password" : field.kind === "url" ? "url" : "text"}
              autoComplete={field.kind === "secret" ? "new-password" : "off"} spellCheck={false} placeholder={field.placeholder} value={values[field.name]} onChange={(e) => set(field.name, e.target.value)} />
          )}
          {field.help && <span className="block text-[11px] text-text-muted">{field.help}</span>}
        </label>
      ))}
      <Button type="submit" variant="primary" className="w-full" disabled={busy} data-testid="provider-save">{busy ? "Connecting…" : `Use ${descriptor.label}`}</Button>
      {descriptor.fields.some((f) => f.kind === "secret") && <Notice>Secrets are sealed on this device and never shown again.</Notice>}
    </form>
  );
}

/**
 * Where a card's money comes from: the source in use for this mode, and the providers that can replace
 * it, each with its own form. Mainnet and Testnet keep separate sources.
 */
export function SourcePicker({ kind, view, onSet, onClear }: { kind: "lightning" | "onchain"; view: SourceView; onSet: (providerId: string, values: Record<string, string>) => Promise<void>; onClear?: () => Promise<void> }) {
  const { busy, error, run } = useRun();
  const [chosen, setChosen] = useState<string>("");
  const [saved, setSaved] = useState("");
  const offered = view.offered;
  const descriptor: ProviderDescriptorView | undefined = offered.find((d) => d.id === chosen);
  const Form = descriptor ? PROVIDER_FORMS[descriptor.id] ?? ProviderConfigForm : null;
  const current = offered.find((d) => d.id === view.providerId);
  const submit = (values: Record<string, string>) => void run(async () => { setSaved(""); await onSet(descriptor!.id, values); setChosen(""); setSaved(`${descriptor!.label} is now your ${kind === "onchain" ? "Bitcoin" : "Lightning"} source.`); });

  return (
    <Section title="Source" testId={`${kind}-source`}>
      <Row testId={`${kind}-source-current`}
        label={view.providerId ? <>{view.label ?? view.providerId}{view.isDefault && <span className="text-accent ml-2 text-[10px] uppercase tracking-wider">Default</span>}</> : "No source"}
        hint={<span data-testid={`${kind}-source-status`}>{view.error ?? [STATUS[view.status], view.alias, view.network && view.network !== "bitcoin" ? view.network : undefined, view.custodial ? "custodial" : undefined].filter(Boolean).join(" · ")}</span>}>
        {onClear && view.providerId && !view.isDefault && <Button disabled={busy} onClick={() => void run(onClear)} data-testid={`${kind}-source-clear`}>{kind === "lightning" ? "Back to Cashu mints" : "Remove"}</Button>}
      </Row>
      <Block>
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
        <Notice>{view.mode === "testnet" ? "Testnet has its own source; your Mainnet source is kept." : "Mainnet has its own source; your Testnet source is kept."}</Notice>
      </Block>
    </Section>
  );
}
