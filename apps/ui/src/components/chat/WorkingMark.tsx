import { useRef, type ReactNode } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { agoIn } from "../../lib/relativeTime";
import { durationIn } from "../../lib/statusCards";
import { workingQuietMs, workingState, type WorkingEntry, type WorkingState } from "../../lib/working";

/*
 * Whether a bot is working now (WISP 405 § Showing a card), on its chat's row: a dot of one width, with no text. In
 * the accent with a slow pulse while one of its tasks is running and was updated lately; a muted ring, still, once
 * they have all gone quiet: a shape of its own, as the muted tone is close to the accent in some themes. The pulse is
 * the app's (it rests after half a minute) and starts again with each update. The chat's header says it in words
 * (`WorkingLine`): what the bot is working on, or since when it has said nothing.
 */

/** The dot's place: as wide with a dot as without, so what follows it never moves. */
const SLOT = "inline-flex h-2 w-2 shrink-0";

/** The dot's place kept empty: a row with a usage meter and no running task, so its meter starts where the others do. */
export function WorkingGap() {
  return <span aria-hidden="true" data-testid="chat-row-working-gap" className={SLOT} />;
}

/** The dot: "Working" or "No update for 40 min" to a screen reader, the newest task's title and step in its tooltip. */
export function WorkingDot({ entry, testId }: { entry: WorkingEntry; testId: string }) {
  const { t, language } = useI18n();
  const ref = useRef<HTMLSpanElement>(null);
  const now = useMinuteClock(ref);
  const state = workingState(entry, now);
  const label = state === "working" ? t("cards.working.label") : t("cards.working.stale", { duration: durationIn(language)(workingQuietMs(entry, now)) });
  return (
    <span ref={ref} role="img" aria-label={label} title={[label, entry.title, entry.step].filter(Boolean).join(" · ")} data-testid={testId} data-state={state} className={SLOT}>
      <Dot entry={entry} state={state} />
    </span>
  );
}

function Dot({ entry, state }: { entry: WorkingEntry; state: WorkingState }) {
  return <span key={entry.at} aria-hidden="true" className={`h-full w-full rounded-full ${state === "working" ? "bg-accent motion-safe:animate-pulse" : "border-[1.5px] border-text-muted"}`} />;
}

/**
 * The same in a chat's header, in words: "Working · <the newest running task>" (and "+2" when more are running), or
 * "Working? · last update 40 min ago" once they have gone quiet. With `onToggle` it is a button that opens the chat's
 * Tasks panel (and closes it, pressed while it is open). A phone's header has no room for the words beside the key and
 * the meter: there it is the dot alone, the words read out, and the panel it opens names the tasks.
 */
export function WorkingLine({ entry, open = false, onToggle }: { entry: WorkingEntry; open?: boolean; onToggle?: (open: boolean) => void }) {
  const { t, language } = useI18n();
  const ref = useRef<HTMLSpanElement>(null);
  // Open when the press began: the panel closes itself on a press outside it, before the click comes.
  const wasOpen = useRef(false);
  const now = useMinuteClock(ref);
  const state = workingState(entry, now);
  const words: ReactNode = state === "working"
    ? <>{t("cards.working.label")} · <bdi>{entry.title}</bdi>{entry.count > 1 && <span dir="ltr"> +{entry.count - 1}</span>}</>
    : t("cards.working.quiet", { ago: agoIn(language)(entry.at / 1000, now / 1000) });
  const line = <>
    <span className={SLOT}><Dot entry={entry} state={state} /></span>
    <span data-testid="chat-working-text" className="min-w-0 truncate max-md:sr-only">{words}</span>
  </>;
  const shape = `inline-flex min-w-0 items-center gap-1.5 text-xs max-md:text-[10px] leading-4 ${state === "working" ? "text-text-secondary" : "text-text-muted"}`;
  return (
    <span ref={ref} className="inline-flex min-w-0" title={[entry.title, entry.step].filter(Boolean).join(" · ")}>
      {onToggle
        ? <button type="button" data-testid="chat-working" data-state={state} aria-haspopup="dialog" aria-expanded={open}
            onPointerDown={() => { wasOpen.current = open; }} onClick={() => { onToggle(!wasOpen.current); wasOpen.current = false; }}
            className={`${shape} rounded cursor-pointer max-md:-m-2 max-md:p-2 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent`}>{line}</button>
        : <span data-testid="chat-working" data-state={state} className={shape}>{line}</span>}
    </span>
  );
}
