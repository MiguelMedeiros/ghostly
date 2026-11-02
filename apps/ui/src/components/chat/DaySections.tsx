import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { byDay, dayLabel, dayOf, nextDay } from "../../lib/chatDays";

/** Today's local midnight, again at each midnight while the chat stays open: its Today becomes Yesterday then. */
function useToday(): number {
  const [today, setToday] = useState(() => dayOf(Date.now()));
  useEffect(() => {
    const timer = window.setTimeout(() => setToday(dayOf(Date.now())), Math.max(1_000, nextDay(today) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [today]);
  return today;
}

/**
 * A chat's rows in the page, each day's under its date (`rowDays` over the whole timeline, `from` the first row's place
 * in it). The date is at the top of its day and stays at the top of the list while its day scrolls under it, until the
 * next day's pushes it out (sticky inside its day's section, no script). It takes no clicks, and its room at the top of
 * its day is its own: at rest it covers no message. A day whose rows all draw nothing (`draw` gives null) has no date.
 */
export function DaySections<R>({ rows, days, from, draw }: { rows: readonly R[]; days: readonly number[]; from: number; draw: (row: R) => ReactNode }) {
  const { t, language } = useI18n();
  const today = useToday();
  return byDay(rows, days, from).map(({ day, rows }) => {
    const drawn = rows.map(draw).filter(node => node !== null && node !== undefined && node !== false);
    if (drawn.length === 0) return null;
    if (Number.isNaN(day)) return <Fragment key="day:none">{drawn}</Fragment>;
    const date = new Date(day);
    return (
      <section key={`day:${day}`} data-day={day}>
        <div data-testid="chat-day" className="pointer-events-none sticky top-2 z-[2] mb-3 flex justify-center px-6">
          <time dateTime={`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`} className="rounded-lg bg-surface-alt/90 px-3 py-1 text-center text-[11px] font-medium text-text-muted shadow-sm">
            {dayLabel(day, today, language, t)}
          </time>
        </div>
        {drawn}
      </section>
    );
  });
}
