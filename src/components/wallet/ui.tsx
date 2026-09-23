import { useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";

/** The same building blocks as Settings, so a wallet's options read like any other option. */
export function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-3" data-testid={testId}>
      <h2 className="text-sm font-semibold text-accent uppercase tracking-wide">{title}</h2>
      <div className="bg-surface rounded-xl divide-y divide-border">{children}</div>
    </section>
  );
}

export function Row({ label, hint, children, testId }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="flex items-center justify-between gap-4 px-4 py-3.5 max-sm:flex-wrap">
      <div className="min-w-0">
        <p className="text-text-primary text-sm">{label}</p>
        {hint && <p className="text-xs text-text-muted mt-0.5 break-words">{hint}</p>}
      </div>
      {children && <div className="shrink-0 flex items-center gap-2 max-sm:w-full max-sm:justify-end">{children}</div>}
    </div>
  );
}

/** A block inside a section that is not a label/control pair: a list, a form, a phrase. */
export function Block({ children }: { children: ReactNode }) {
  return <div className="px-4 py-3.5 space-y-3">{children}</div>;
}

export function Switch({ checked, onChange, label, disabled, testId }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; testId?: string }) {
  return (
    <button type="button" role="switch" data-testid={testId} aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={`relative w-12 h-6 rounded-full transition-colors shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${checked ? "bg-accent" : "bg-surface-alt"}`}>
      <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${checked ? "translate-x-6" : "translate-x-0"}`} />
    </button>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label, disabled }: { options: { value: T; label: string }[]; value: T; onChange: (next: T) => void; label: string; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1 bg-surface-alt rounded-lg p-1">
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} disabled={disabled && value !== option.value} onClick={() => { if (option.value !== value) onChange(option.value); }}
          className={`px-3 py-1.5 rounded-md text-sm transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${value === option.value ? "bg-accent text-[#111b21] font-medium" : "text-text-secondary hover:text-text-primary"}`}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

const BUTTON = {
  primary: "bg-accent text-[#111b21] hover:bg-accent-hover font-semibold",
  secondary: "bg-surface-alt text-text-primary hover:bg-surface-hover border border-border",
  danger: "bg-transparent text-danger hover:bg-danger/10 border border-border",
} as const;
export function Button({ variant = "secondary", className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON }) {
  return <button type="button" {...props} className={`px-4 py-2 max-md:min-h-11 rounded-lg text-sm transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${BUTTON[variant]} ${className}`} />;
}

export const input = "w-full min-w-0 bg-surface-alt text-text-primary px-3 py-2 max-md:min-h-11 rounded-lg border border-border text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent";

export type Action = "receive" | "send" | "history";
const ACTION_ICON: Record<Action, ReactNode> = {
  receive: <path d="M12 5v14M5 12l7 7 7-7" />,
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  history: <><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></>,
};
const ACTION_LABEL: Record<Action, string> = { receive: "Receive", send: "Send", history: "History" };
/** The two (or three) things a wallet is for, as big equal buttons. */
export function Actions({ value, onChange, actions = ["receive", "send"] }: { value: Action; onChange: (next: Action) => void; actions?: Action[] }) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${actions.length}, minmax(0, 1fr))` }} role="tablist">
      {actions.map((action) => (
        <button key={action} type="button" role="tab" aria-selected={value === action} data-testid={`wallet-${action === "send" ? "send" : action}`} onClick={() => onChange(action)}
          className={`flex items-center justify-center gap-2 py-2.5 max-md:min-h-11 rounded-xl text-sm font-semibold transition-colors cursor-pointer border ${value === action ? "bg-accent text-[#111b21] border-accent" : "bg-surface text-text-secondary border-border hover:text-text-primary hover:border-border-bright"}`}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ACTION_ICON[action]}</svg>
          {ACTION_LABEL[action]}
        </button>
      ))}
    </div>
  );
}

/** Where to be paid: a QR code, the text, and one button to copy it. */
export function Address({ value, qr, testId, note }: { value: string | undefined; qr?: string; testId: string; note?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  // Never a QR code or a Copy button for an address that is not there yet: someone could share it.
  if (!value) return <Notice testId={`${testId}-pending`}>Getting an address… It shows up here once the provider answers.</Notice>;
  return (
    <div className="flex gap-4 items-center max-sm:flex-col">
      <div className="bg-white rounded-xl p-2.5 shrink-0"><QRCodeSVG value={qr ?? value} size={144} title="Receiving address" /></div>
      <div className="min-w-0 flex-1 space-y-2.5 max-sm:w-full">
        <code className="block break-all select-all bg-surface-alt rounded-lg p-2.5 text-xs text-text-primary font-mono" data-testid={testId}>{value}</code>
        <Button variant="primary" onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</Button>
        {note && <p className="text-xs text-text-muted">{note}</p>}
      </div>
    </div>
  );
}

/** A large amount field: what matters most when paying is the number. */
export function Amount({ value, onChange, unit, decimals = 0, testId, autoFocus }: { value: string; onChange: (next: string) => void; unit: string; decimals?: number; testId?: string; autoFocus?: boolean }) {
  return (
    <label className="flex items-baseline gap-2 bg-surface-alt rounded-xl px-4 py-3 border border-border focus-within:ring-2 focus-within:ring-accent">
      <input data-testid={testId} autoFocus={autoFocus} inputMode={decimals ? "decimal" : "numeric"} placeholder="0" aria-label={`Amount in ${unit}`}
        className="min-w-0 flex-1 bg-transparent border-none outline-none text-3xl font-semibold text-text-primary placeholder-text-muted tabular-nums"
        value={value} onChange={(e) => onChange(e.target.value.replace(decimals ? /[^0-9.]/g : /\D/g, ""))} />
      <span className="text-text-muted text-sm shrink-0">{unit}</span>
    </label>
  );
}

export function Notice({ tone = "muted", children, testId }: { tone?: "muted" | "error" | "success" | "warning"; children: ReactNode; testId?: string }) {
  const color = { muted: "text-text-muted", error: "text-danger", success: "text-accent", warning: "text-yellow-500" }[tone];
  return <p role={tone === "error" ? "alert" : undefined} data-testid={testId} className={`text-xs ${color}`}>{children}</p>;
}
