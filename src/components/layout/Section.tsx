import { useId, useState, type ReactNode } from "react";
import { useOptionalI18n } from "../../contexts/I18nContext";

/** A titled group of rows on a card, like the sections of Settings. */
export function Section({ title, children, testId }: { title: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-3" data-testid={testId}>
      <h2 className="text-sm font-semibold text-accent uppercase tracking-wide">{title}</h2>
      <div className="bg-surface rounded-xl divide-y divide-border">{children}</div>
    </section>
  );
}

/**
 * One line of a section: what it is (label, hint), optionally a value, and what can be done with it.
 *
 * It sizes itself from the space it gets, not from the window. The text keeps at least 12rem (8rem for a
 * bare label, without a hint); when the value and the controls do not fit beside that, they wrap under the
 * text, aligned with it, and a group of buttons wraps inside itself before anything is squeezed. A hint
 * never becomes a one-letter column, and a button is never pushed out of the card.
 */
export function Row({ label, hint, info, value, leading, children, testId }: {
  label: ReactNode;
  /** One short line: what changing it does. */
  hint?: ReactNode;
  /** The longer story (a privacy trade-off, what a server sees), behind an ⓘ beside the label. */
  info?: ReactNode;
  /** A figure beside the label (a balance, a size): never shrinks, never wraps inside. */
  value?: ReactNode;
  /** An icon or avatar before the text. */
  leading?: ReactNode;
  /** The row's controls: buttons, a switch, a select. */
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
      <div className={`flex items-center gap-3 min-w-0 ${hint ? "flex-[1_1_12rem]" : "flex-[1_1_8rem]"}`}>
        {leading && <div className="shrink-0">{leading}</div>}
        <RowText label={label} hint={hint} info={info} />
      </div>
      {value !== undefined && <div className="shrink-0 whitespace-nowrap text-sm text-text-secondary tabular-nums">{value}</div>}
      {children && <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">{children}</div>}
    </div>
  );
}

/** A row's words: the label (with an ⓘ when there is more to say), the hint, and the more once asked for. */
function RowText({ label, hint, info, htmlFor, trailing }: { label: ReactNode; hint?: ReactNode; info?: ReactNode; htmlFor?: string; trailing?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const more = useOptionalI18n()?.t("common.moreInfo") ?? "More info";
  const Label = htmlFor ? "label" : "div";
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-x-2 min-w-0">
        <Label htmlFor={htmlFor} className="text-text-primary text-sm break-words min-w-0">{label}</Label>
        {info && (
          <button type="button" data-testid="row-info" aria-expanded={open} aria-controls={id} aria-label={more} title={more} onClick={() => setOpen(!open)}
            className="relative shrink-0 grid place-items-center w-5 h-5 -my-1 rounded-full text-text-muted hover:text-accent aria-expanded:text-accent transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent before:absolute before:-inset-2.5 before:content-['']">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /><path d="M12 11v5.5M12 7.5v.01" /></svg>
          </button>
        )}
        {trailing && <div className="ms-auto shrink-0">{trailing}</div>}
      </div>
      {hint && <div className="text-xs text-text-muted mt-0.5 break-words">{hint}</div>}
      {info && open && <div id={id} data-testid="row-info-text" className="text-xs text-text-secondary leading-relaxed mt-2 ps-3 border-s-2 border-border break-words">{info}</div>}
    </div>
  );
}

/**
 * A field that takes the card's whole width (a list of relays, an address): the same label, hint and ⓘ as a
 * `Row`, `trailing` beside the label (a Reset), and the field under them.
 */
export function Field({ label, hint, info, htmlFor, trailing, children, testId }: {
  label: ReactNode;
  hint?: ReactNode;
  info?: ReactNode;
  /** The id of the field the label names. */
  htmlFor?: string;
  trailing?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="px-4 py-3.5 space-y-2.5 min-w-0" data-testid={testId}>
      <RowText label={label} hint={hint} info={info} htmlFor={htmlFor} trailing={trailing} />
      {children}
    </div>
  );
}

/** A block inside a section that is not a label/control pair: a list, a form, a phrase. */
export function Block({ children, testId }: { children: ReactNode; testId?: string }) {
  return <div className="px-4 py-3.5 space-y-3 min-w-0" data-testid={testId}>{children}</div>;
}

/**
 * A row that goes somewhere: the whole line is one button, with a chevron at the end. Same parts as `Row`
 * (`leading`, `label`, `hint`, `value`), but no controls of its own.
 */
export function LinkRow({ label, hint, value, leading, onClick, testId }: {
  label: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  leading?: ReactNode;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button type="button" data-testid={testId} onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 min-h-12 text-left hover:bg-surface-alt transition-colors cursor-pointer first:rounded-t-xl last:rounded-b-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
      {leading && <span className="shrink-0">{leading}</span>}
      <span className="flex-1 min-w-0">
        <span className="block truncate text-sm text-text-primary">{label}</span>
        {hint && <span className="block text-xs text-text-muted mt-0.5 break-words">{hint}</span>}
      </span>
      {value !== undefined && <span className="shrink-0 whitespace-nowrap text-sm text-text-muted tabular-nums">{value}</span>}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="shrink-0 text-text-muted" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
    </button>
  );
}
