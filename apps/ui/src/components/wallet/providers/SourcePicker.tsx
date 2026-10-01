import { useState } from "react";
import type { SourceView } from "@ghostly/browser/engine/paymentAdapters/providers/sources";
import type { ProviderDescriptorView, ProviderField } from "@ghostly/browser/engine/paymentAdapters/providers/types";
import { Block, Button, Notice, Row, Section, input } from "../ui";
import { useRun } from "../run";
import { Select } from "../../ui/Select";
import { PROVIDER_FORMS, type ProviderFormProps } from "./forms";
import { changeableFields, sourceStatus } from "./sourceStatus";
import { useI18n } from "../../../contexts/I18nContext";


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
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, config[f.name] ?? ""])));
  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));
  return (
    <form className="space-y-3" data-testid={`${kind}-source-server-form`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); onSubmit(values); }}>
      {fields.map((field, i) => (
        <div key={field.name} className="space-y-1">
          <label className="block space-y-1">
            <span className="text-xs text-text-secondary">{field.label}{field.optional && <span className="text-text-muted"> {t("wallet.source.optional")}</span>}</span>
            {/* Opened from the card's own button, further up: focusing it brings the form into view. */}
            <input aria-label={field.label} autoFocus={i === 0} className={`${input} font-mono text-xs`} type={field.kind === "url" ? "url" : "text"} spellCheck={false} placeholder={field.placeholder} value={values[field.name]} onChange={(e) => set(field.name, e.target.value)} />
          </label>
          <Suggestions field={field} values={{ ...config, ...values }} onPick={(value) => set(field.name, value)} />
          {field.help && <span className="block text-[11px] text-text-muted">{field.help}</span>}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={busy} data-testid={`${kind}-source-server-save`}>{busy ? t("wallet.source.connecting") : t("wallet.source.useServer")}</Button>
        <Button type="button" disabled={busy} onClick={onCancel}>{t("common.cancel")}</Button>
      </div>
      <Notice>{t("wallet.source.serverNote")}</Notice>
    </form>
  );
}

/** The form built from a provider's declared fields. Secret fields are password inputs, never filled back in. */
export function ProviderConfigForm({ descriptor, mode, busy, onSubmit }: ProviderFormProps) {
  const { t } = useI18n();
  const initial = () => Object.fromEntries(descriptor.fields.map((f) => [f.name, f.defaults?.[mode] ?? (f.kind === "select" ? f.options?.[0]?.value ?? "" : "")]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));
  return (
    <form className="space-y-3" data-testid={`provider-form-${descriptor.id}`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); onSubmit(values); }}>
      {descriptor.fields.map((field) => (
        // The suggestions are buttons: beside the label, not inside it (a label holds one control).
        <div key={field.name} className="space-y-1">
          <label className="block space-y-1">
            <span className="text-xs text-text-secondary">{field.label}{field.optional && <span className="text-text-muted"> {t("wallet.source.optional")}</span>}</span>
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
      <Button type="submit" variant="primary" className="w-full" disabled={busy} data-testid="provider-save">{busy ? t("wallet.source.connecting") : t("wallet.source.use", { name: descriptor.label })}</Button>
      {descriptor.fields.some((f) => f.kind === "secret") && <Notice>{t("wallet.source.secretsSealed")}</Notice>}
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
  const { t } = useI18n();
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
  const submit = (values: Record<string, string>) => void run(async () => { setSaved(""); await onSet!(descriptor!.id, values); setChosen(""); setSaved(t(kind === "onchain" ? "wallet.source.savedOnchain" : "wallet.source.savedLightning", { name: descriptor!.label })); });
  const reconfigure = (values: Record<string, string>) => void run(async () => { setSaved(""); await onReconfigure!(values); setServerOpen(false); setSaved(view.label ? t("wallet.source.reconfigured", { name: view.label }) : t("wallet.source.reconfiguredUnnamed")); });

  return (
    <Section title={t("wallet.source.title")} testId={`${kind}-source`}>
      <Row testId={`${kind}-source-current`}
        label={view.providerId ? <>{view.label ?? view.providerId}{view.isDefault && onSet && <span className="text-accent ms-2 text-[10px] uppercase tracking-wider">{t("wallet.source.default")}</span>}</> : t("wallet.source.none")}
        hint={<span data-testid={`${kind}-source-status`}>{sourceStatus(t, view)}</span>}>
        {onRetry && failing && view.providerId && <Button disabled={busy} onClick={() => void run(onRetry)} data-testid={`${kind}-source-retry`}>{t("wallet.source.retry")}</Button>}
        {serverFields.length > 0 && !serverOpen && <Button disabled={busy} onClick={() => { setServerOpen(true); setSaved(""); }} data-testid={`${kind}-source-change-server`}>{t("wallet.source.changeServer")}</Button>}
        {onClear && view.providerId && !view.isDefault && <Button disabled={busy} onClick={() => void run(onClear)} data-testid={`${kind}-source-clear`}>{kind === "lightning" ? t("wallet.source.backToMints") : t("wallet.source.remove")}</Button>}
      </Row>
      {serverOpen && serverFields.length > 0 && (
        <Block><ServerForm kind={kind} fields={serverFields} config={view.config ?? {}} busy={busy} onSubmit={reconfigure} onCancel={() => setServerOpen(false)} /></Block>
      )}
      {!onSet ? (saved || error) && <Block>
        {saved && <Notice tone="success" testId={`${kind}-source-saved`}>{saved}</Notice>}
        {error && <Notice tone="error" testId={`${kind}-source-error`}>{error}</Notice>}
      </Block> : <Block>
        {offered.length === 0 ? (
          <Notice testId={`${kind}-source-none-offered`}>{kind === "onchain"
            ? t(view.mode === "testnet" ? "wallet.source.noneOffered.onchainTestnet" : "wallet.source.noneOffered.onchain")
            : t(view.mode === "testnet" ? "wallet.source.noneOffered.lightningTestnet" : "wallet.source.noneOffered.lightning")}</Notice>
        ) : (
          <label className="block space-y-1">
            <span className="text-xs text-text-secondary">{view.providerId ? t("wallet.source.change") : t("wallet.source.choose")}</span>
            <Select aria-label={kind === "onchain" ? t("wallet.source.selectOnchain") : t("wallet.source.selectLightning")} data-testid={`${kind}-source-select`} value={chosen} placeholder={t("wallet.source.available", { count: offered.length })}
              onChange={(v) => { setChosen(v); setSaved(""); }}
              options={offered.map((d) => ({
                value: d.id,
                label: d.label,
                description: [d.custodial && t("wallet.source.custodial"), d.experimental && t("wallet.source.experimental"), d.id === view.providerId && t("wallet.source.inUse")].filter(Boolean).join(" · ") || undefined,
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
        <Notice>{view.mode === "testnet" ? t("wallet.source.modeNote.testnet") : t("wallet.source.modeNote.mainnet")}</Notice>
      </Block>}
    </Section>
  );
}
