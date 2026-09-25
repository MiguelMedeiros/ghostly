import { useId, useState } from "react";
import { transportEventText, transportLineDetails, transportLineText, type TransportEntry, type TransportEvent } from "../lib/transportEvents";
import { focus } from "../lib/connection";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const when = (at: number) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });

/**
 * One change of the chat's live transport: a small centred line, not a bubble. Tapping it shows the details.
 * Local only: it is not a message, never counted as unread, never sent. `earlier`: the rows it stands for, with no
 * message between them (see `mergeTimeline`); its details list them.
 */
export function TransportLine({ entry, contact, earlier = [] }: { entry: TransportEntry; contact: string; earlier?: readonly TransportEntry[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const warn = entry.kind === "failed" || entry.kind === "lost" || (entry.kind === "flapping" && !entry.live);
  return (
    <div className="mb-3.5 flex flex-col items-center px-[63px] max-md:px-2.5" data-testid="transport-line" data-kind={entry.kind}>
      <button type="button" aria-expanded={open} aria-controls={`${id}-details`} onClick={() => setOpen(!open)}
        className={`inline-flex max-w-full items-center gap-1.5 rounded-lg px-3 py-1.5 text-start text-xs transition-colors ${warn ? "bg-surface-alt/80 text-text-muted" : "bg-surface-alt/80 text-text-secondary"} hover:bg-surface-hover ${focus}`}>
        <TransportLineIcon entry={entry} />
        <span className="min-w-0 break-words" data-testid="transport-line-text">{transportLineText(entry, contact)}</span>
        {earlier.length > 0 && <span className="shrink-0 text-[10px] text-text-muted" data-testid="transport-line-earlier-count"
          aria-label={`and ${earlier.length} earlier ${earlier.length === 1 ? "change" : "changes"}`}>+{earlier.length}</span>}
        <time dateTime={new Date(entry.at).toISOString()} className="shrink-0 text-[10px] text-text-muted">{time(entry.at)}</time>
      </button>
      {open && (
        <dl id={`${id}-details`} data-testid="transport-line-details"
          className="mt-1 grid w-full max-w-sm grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-border bg-surface-alt/90 px-3 py-2 text-[11px] text-text-secondary">
          {transportLineDetails(entry, contact, when).map(row => (
            <div key={row.label} className="contents">
              <dt className="text-text-muted">{row.label}</dt>
              <dd className="min-w-0 break-words text-text-primary">{row.value}</dd>
            </div>
          ))}
          {earlier.length > 0 && <div className="contents">
            <dt className="text-text-muted">Before this</dt>
            <dd className="min-w-0 text-text-primary">
              <span>…and {earlier.length} more {earlier.length === 1 ? "change" : "changes"}</span>
              <ul className="mt-0.5 space-y-0.5 text-text-secondary" data-testid="transport-line-earlier">
                {[...earlier].reverse().map(e => <li key={e.id} className="break-words">
                  <time dateTime={new Date(e.at).toISOString()} className="text-text-muted">{time(e.at)}</time> <span>{transportLineText(e, contact)}</span>
                </li>)}
              </ul>
            </dd>
          </div>}
        </dl>
      )}
    </div>
  );
}

/** Shown this many at first; the rest a tap away. */
const HISTORY_SHOWN = 20;

/**
 * The connection panel's "Connection history": every event of the chat's connection, newest first, including
 * what the timeline leaves out (drops it came back from, restarts, failed attempts, round trips).
 */
export function ConnectionHistory({ events, contact }: { events: readonly TransportEvent[]; contact: string }) {
  const [all, setAll] = useState(false);
  const newest = [...events].reverse(), shown = all ? newest : newest.slice(0, HISTORY_SHOWN);
  const day = new Date().toDateString();
  const stamp = (at: number) => new Date(at).toDateString() === day
    ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <details className="mt-2 border-t border-border pt-1 text-[11px]" data-testid="connection-history">
      <summary className={`w-fit cursor-pointer rounded-md py-2 pr-2 text-text-secondary ${focus}`}>Connection history ({events.length})</summary>
      <ol className="space-y-1 pb-2" aria-label="Connection history, newest first">
        {shown.map((e, i) => (
          <li key={`${e.at}-${i}`} className="grid grid-cols-[auto_1fr] gap-x-2" data-testid="connection-history-event" data-kind={e.kind}>
            <time dateTime={new Date(e.at).toISOString()} className="tabular-nums text-text-muted">{stamp(e.at)}</time>
            <span className="min-w-0 break-words text-text-primary">{transportEventText(e, contact)}</span>
          </li>
        ))}
      </ol>
      {!all && newest.length > shown.length && <button type="button" onClick={() => setAll(true)} data-testid="connection-history-more"
        className={`mb-2 min-h-9 rounded-md px-2 text-accent hover:bg-surface-hover ${focus}`}>Show all {newest.length}</button>}
    </details>
  );
}

function TransportLineIcon({ entry }: { entry: TransportEntry }) {
  const path = entry.kind === "chose" ? <><circle cx="12" cy="12" r="3" /><path d="M12 2v4m0 12v4M2 12h4m12 0h4" /></>
    : entry.kind === "dht-only" ? <><path d="m3 7 9-4 9 4-9 4Z" /><path d="m3 12 9 4 9-4M3 17l9 4 9-4" /></>
    : entry.kind === "failed" ? <><circle cx="12" cy="12" r="9" /><path d="M12 8v5m0 3h.01" /></>
    : entry.kind === "lost" || (entry.kind === "flapping" && !entry.live) ? <><path d="m18.8 12.3 1.7-1.8a5 5 0 0 0-7-7l-1.7 1.7" /><path d="m5.2 11.7-1.7 1.8a5 5 0 0 0 7 7l1.7-1.7" /><path d="M8 2v3M2 8h3m11 11v3m3-6h3" /></>
    : entry.kind === "switched" || entry.kind === "flapping" || entry.kind === "dht-left" ? <><path d="M4 8h13l-3-3M20 16H7l3 3" /></>
    : <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>;
  return <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">{path}</svg>;
}
