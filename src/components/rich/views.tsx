import { useState, type ComponentType } from "react";
import { useI18n } from "../../contexts/I18nContext";
import type { Atom, TimeData } from "../../lib/parse";
import { CopyButton } from "./CopyButton";

/** A web address: a new tab, with no opener and no referrer. */
function LinkView({ atom }: { atom: Atom<"link", { url: string }> }) {
  return (
    <a href={atom.data.url} target="_blank" rel="noopener noreferrer" className="text-link underline hover:decoration-2 break-all">
      {atom.text}
    </a>
  );
}

/** A long key or token: one line until "Show all", and Copy either way. */
function BlobView({ atom }: { atom: Atom<"blob", null> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <span data-testid="rich-blob" data-open={open || undefined} className={`rich-blob ${open ? "rich-blob-open" : ""}`}>
      <code dir="ltr" className="rich-blob-text">{atom.text}</code>
      <span className="rich-blob-actions">
        <button type="button" data-testid="rich-blob-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="rich-action">
          {open ? t("chat.rich.showLess") : t("chat.rich.showAll")}
        </button>
        <CopyButton text={atom.text} testId="rich-blob-copy" />
      </span>
    </span>
  );
}

/** "Sep 25, 17:00 GMT+3": the reader's own zone, with the date when it is not the day the message was sent. */
function localLabel(at: number, sameDay: boolean): string {
  return new Date(at).toLocaleString([], {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** A time with its zone: the reader's local time on hover (the title) or on a tap, next to what was written. */
function TimeView({ atom, sentAt }: { atom: Atom<"time", TimeData>; sentAt?: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const sent = new Date(sentAt ?? Date.now());
  const local = new Date(atom.data.at);
  const label = t("chat.rich.localTime", { time: localLabel(atom.data.at, local.toDateString() === sent.toDateString()) });
  return (
    <span data-testid="rich-time">
      <button type="button" title={label} aria-expanded={open} onClick={() => setOpen((v) => !v)} className="rich-time">
        <time dateTime={local.toISOString()}>{atom.text}</time>
      </button>
      {open && <span data-testid="rich-time-local" className="rich-time-local"> ({label})</span>}
    </span>
  );
}

export interface AtomViewProps<A extends Atom = Atom> {
  atom: A;
  /** When the message was sent (ms). */
  sentAt?: number;
}

/**
 * How each kind of atom looks, by the detector's `kind` (src/lib/parse/detectors.ts). A kind with no view here shows
 * as the text it matched, so a new detector works before it has a look of its own.
 */
export const VIEWS: Record<string, ComponentType<AtomViewProps<any>>> = {
  link: LinkView,
  blob: BlobView,
  time: TimeView,
};
