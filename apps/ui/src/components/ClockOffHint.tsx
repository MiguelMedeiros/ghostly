import { useId, useState } from "react";
import { useI18n } from "../contexts/I18nContext";
import { clockOffTexts } from "../lib/clockOff";

/**
 * The connection panel's note that this device's own clock seems to be off, shown while the engine says so
 * (`EngineState.transport.clockOffMs`, the rule in packages/core's clockWatch.ts: several sources that agree, never one
 * contact). One short line; which way, why it matters and what to do are behind its ⓘ.
 */
export function ClockOffHint({ ms }: { ms: number }) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  const { hint, info } = clockOffTexts(t, ms, language);
  return (
    <div data-testid="connection-clock-off" className="mt-1.5 rounded-lg bg-surface-hover px-2.5 py-2 leading-4">
      <p className="flex items-start gap-1.5">
        <span className="min-w-0 break-words text-text-primary">{hint}</span>
        <button type="button" data-testid="connection-clock-off-info" aria-expanded={open} aria-controls={id} aria-label={t("common.moreInfo")} title={t("common.moreInfo")}
          onClick={() => setOpen(!open)}
          className="relative grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-full text-text-muted transition-colors hover:text-accent aria-expanded:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent before:absolute before:-inset-2.5 before:content-['']">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /><path d="M12 11v5.5M12 7.5v.01" /></svg>
        </button>
      </p>
      {open && <p id={id} data-testid="connection-clock-off-text" className="mt-1.5 break-words text-text-secondary">{info}</p>}
    </div>
  );
}
