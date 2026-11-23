import { useId, useState } from "react";
import { useI18n } from "../contexts/I18nContext";
import { clockOffTexts } from "../lib/clockOff";
import { InfoButton } from "./layout/Section";

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
        <InfoButton open={open} onToggle={() => setOpen(!open)} controls={id} testId="connection-clock-off-info" />
      </p>
      {open && <p id={id} data-testid="connection-clock-off-text" className="mt-1.5 break-words text-text-secondary">{info}</p>}
    </div>
  );
}
