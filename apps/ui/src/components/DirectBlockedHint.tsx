import { useId, useState } from "react";
import { useI18n } from "../contexts/I18nContext";
import { InfoButton } from "./layout/Section";

/**
 * The connection panel's note that direct connections do not get through this device's network (a VPN, a firewall, a
 * carrier's NAT), shown while the engine says so (`EngineState.transport.directBlocked`, the rule in packages/core's
 * directPath.ts). One short line; why the app thinks so, what still works and when the note goes away are behind its ⓘ.
 * It never names a VPN as found: the app only sees that its direct attempts fail.
 */
export function DirectBlockedHint() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div data-testid="connection-direct-blocked" className="mt-1.5 rounded-lg bg-surface-hover px-2.5 py-2 leading-4">
      <p className="flex items-start gap-1.5">
        <span className="min-w-0 break-words text-text-primary">{t("connection.directBlocked.hint")}</span>
        <InfoButton open={open} onToggle={() => setOpen(!open)} controls={id} testId="connection-direct-blocked-info" />
      </p>
      {open && <p id={id} data-testid="connection-direct-blocked-text" className="mt-1.5 break-words text-text-secondary">{t("connection.directBlocked.info")}</p>}
    </div>
  );
}
