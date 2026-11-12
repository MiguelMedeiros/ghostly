import React, { useState } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { shownUrl, SPOILER_PLAIN, type Atom, type MdLinkData, type Segment, type TimeData } from "../../lib/parse";
import { externalLinkProps } from "../../lib/externalLink";
import type { Language } from "../../lib/settings";
import { formatAt } from "../../lib/time";
import { matchRanges } from "../../lib/chatSearch";
import { Marked } from "../chat/ChatSearch";
import { CopyButton } from "./CopyButton";
import type { AtomMarks } from "./views";

/**
 * A web address: a new tab, with no opener and no referrer; on Desktop the system browser, since its WebView opens
 * no new tab (`externalLinkProps`). It reads left to right on its own (`dir`), so no
 * direction control before or inside it can make it show another address, and as it is typed only when that is
 * plain ASCII with no user part: anything else shows as the browser will read it (`shownUrl`).
 */
export function LinkView({ atom, marks }: { atom: Atom<"link", { url: string }>; marks?: AtomMarks }) {
  const shown = shownUrl(atom.text);
  return (
    <a {...externalLinkProps(atom.data.url)} dir="ltr" className="text-link underline hover:decoration-2 inline-block max-w-full [overflow-wrap:anywhere]">
      {/* A chat search's words, marked where it shows the address as written; all of it when it shows it otherwise. */}
      {!marks ? shown
        : shown === atom.text ? <Marked text={shown} start={marks.start} ranges={marks.ranges} />
        : <Marked text={shown} start={0} ranges={holds(marks, atom.text.length) ? [[0, shown.length]] : []} />}
    </a>
  );
}

/** Whether a chat search's matches fall in the `length` characters an atom's words take from `marks.start`. */
const holds = (marks: AtomMarks, length: number): boolean => marks.ranges.some(([from, to]) => from < marks.start + length && to > marks.start);

/** A label's words as they read, a spoiler's uncovered: what a chat search finds in it (lib/chatSearch). */
const labelText = (label: readonly Segment[]): string => label.map((s) => (s.type === "span" ? labelText(s.children) : s.text)).join("");

/**
 * A link's label: its formatting, and a spoiler stays covered (a tap on it would follow the link). Code never gets
 * here: backticks pair before links are looked for. With `marks`, a chat search's words are marked in it; `marks.start`
 * moves past each word.
 */
function labelNodes(label: Segment[], marks?: AtomMarks, key = ""): React.ReactNode[] {
  return label.map((s, i) => {
    const k = key + i;
    if (s.type !== "span") {
      if (!marks) return s.text;
      const start = marks.start;
      marks.start += s.text.length;
      return <Marked key={k} text={s.text} start={start} ranges={marks.ranges} />;
    }
    if (s.style === "spoiler") {
      if (marks) marks.start += labelText(s.children).length;
      return SPOILER_PLAIN;
    }
    const inner = labelNodes(s.children, marks, `${k}.`);
    return s.style === "bold" ? <strong key={k} className="font-semibold">{inner}</strong> : s.style === "italic" ? <em key={k}>{inner}</em> : <s key={k}>{inner}</s>;
  });
}

/**
 * `[text](https://…)`: the text as a link, with the host it goes to (and the whole address) on hover; a long press
 * gets the browser's own menu, which names the address too. Text that reads as another address than the link's
 * (`labelMisleads`) is not shown: the address is, as `LinkView` shows one.
 *
 * A chat search finds the link by its text and by its address (lib/chatSearch), so with `marks` the words are marked
 * where it shows them, and what it shows is marked whole when they are only in the part it does not show.
 */
export function MdLinkView({ atom, marks }: { atom: Atom<"md-link", MdLinkData>; marks?: AtomMarks }) {
  const { url, label, showUrl } = atom.data;
  const shown = shownUrl(url);
  let title = shown;
  try { title = `${new URL(url).hostname}\n${shown}`; } catch { /* the parser only takes addresses a URL parser reads */ }
  const inAddress = !!marks && matchRanges(url, marks.term).length > 0;
  if (showUrl) {
    // Its address's own matches, the first ones the message may still mark (thousands in one long address).
    const inShown = marks ? matchRanges(shown, marks.term) : [];
    const ranges: [number, number][] = !marks ? [] : inShown.length ? marks.spend(inShown)
      : inAddress || holds(marks, labelText(label).length) ? [[0, shown.length]] : [];
    return <a data-testid="rich-md-link" data-shows="url" {...externalLinkProps(url)} title={title} dir="ltr" className="text-link underline hover:decoration-2 inline-block max-w-full [overflow-wrap:anywhere]"><Marked text={shown} start={0} ranges={ranges} /></a>;
  }
  const labelMarks: AtomMarks | undefined = marks && (inAddress ? { ...marks, ranges: [[0, Infinity]], start: 0 } : { ...marks });
  return <a data-testid="rich-md-link" data-shows="text" {...externalLinkProps(url)} title={title} className="text-link underline hover:decoration-2">{labelNodes(label, labelMarks)}</a>;
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

/** "Sep 25, 17:00 GMT+3": the reader's own zone, with the date when it is not the day the message was sent, in the app's language. */
function localLabel(at: number, sameDay: boolean, language?: Language): string {
  return formatAt(at, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }, language);
}

/** A time with its zone: the reader's local time on hover (the title) or on a tap, next to what was written. */
export function TimeView({ atom, sentAt }: { atom: Atom<"time", TimeData>; sentAt?: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const sent = new Date(sentAt ?? Date.now());
  const local = new Date(atom.data.at);
  // A moment no date holds (the parser refuses one; this is the last guard): the text as written, not a crash.
  if (Number.isNaN(local.getTime())) return <>{atom.text}</>;
  const label = t("chat.rich.localTime", { time: localLabel(atom.data.at, local.toDateString() === sent.toDateString(), t.language) });
  return (
    <span data-testid="rich-time">
      <button type="button" title={label} aria-expanded={open} onClick={() => setOpen((v) => !v)} className="rich-time">
        <time dateTime={local.toISOString()}>{atom.text}</time>
      </button>
      {open && <span data-testid="rich-time-local" className="rich-time-local"> ({label})</span>}
    </span>
  );
}
