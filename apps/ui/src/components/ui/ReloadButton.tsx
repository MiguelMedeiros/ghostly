import { useState } from "react";
import { useT } from "../../contexts/I18nContext";
import { reloadIfServed } from "../../lib/reloadIfServed";

/**
 * Reload, offered where a part of the app failed to load again (`reloadIfServed`: only into a page the server
 * answers for; with no connection yet it stays). `to`: the address the app comes back on.
 */
export function ReloadButton({ className, testId, to }: { className: string; testId?: string; to?: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    if (busy) return;
    setBusy(true);
    await reloadIfServed(to);
    setBusy(false);
  };
  // `aria-disabled`, not `disabled`: a disabled button gives up the keyboard focus while the server is asked.
  return <button type="button" data-testid={testId} aria-disabled={busy || undefined} onClick={() => void reload()} className={className}>{t("boot.reload")}</button>;
}
