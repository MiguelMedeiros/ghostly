import { useState } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { shownUrl, type Atom, type TimeData } from "../../lib/parse";
import { CopyButton } from "./CopyButton";

/**
 * A web address: a new tab, with no opener and no referrer. It reads left to right on its own (`dir`), so no
 * direction control before or inside it can make it show another address, and as it is typed only when that is
 * plain ASCII: anything else shows as the browser will read it (`shownUrl`).
 */
export function LinkView({ atom }: { atom: Atom<"link", { url: string }> }) {
  return (
    <a href={atom.data.url} dir="ltr" target="_blank" rel="noopener noreferrer" className="text-link underline hover:decoration-2 break-all">
      {shownUrl(atom.text)}
    </a>
  );
}

/** A long key or token: one line until "Show all", and Copy either way. */
export function BlobView({ atom }: { atom: Atom<"blob", null> }) {
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
export function TimeView({ atom, sentAt }: { atom: Atom<"time", TimeData>; sentAt?: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const sent = new Date(sentAt ?? Date.now());
  const local = new Date(atom.data.at);
  // A moment no date holds (the parser refuses one; this is the last guard): the text as written, not a crash.
  if (Number.isNaN(local.getTime())) return <>{atom.text}</>;
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
