import { useRef } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { durationIn } from "../../lib/statusCards";
import { workingQuietMs, workingState, type WorkingEntry } from "../../lib/working";

/*
 * Whether a bot is working now (WISP 405 § Showing a card), on its chat's row: a dot of one width, with no text. In
 * the accent with a slow pulse while one of its tasks is running and was updated lately; muted and still once they
 * have all gone quiet. The pulse is the app's (it rests after half a minute) and starts again with each update.
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
      <span key={entry.at} aria-hidden="true" className={`h-full w-full rounded-full ${state === "working" ? "bg-accent motion-safe:animate-pulse" : "bg-text-muted"}`} />
    </span>
  );
}
