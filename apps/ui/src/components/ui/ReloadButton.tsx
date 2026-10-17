import { useState } from "react";
import { useT } from "../../contexts/I18nContext";
import { reloadIfServed } from "../../lib/reloadIfServed";

/**
 * Reload, offered where a part of the app failed to load again (`reloadIfServed`: only into a page the server
 * answers for; with no connection yet it stays).
 */
export function ReloadButton({ className, testId }: { className: string; testId?: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    if (busy) return;
    setBusy(true);
    await reloadIfServed();
    setBusy(false);
  };
  // `aria-disabled`, not `disabled`: a disabled button gives up the keyboard focus while the server is asked.
  return <button type="button" data-testid={testId} aria-disabled={busy || undefined} onClick={() => void reload()} className={className}>{t("boot.reload")}</button>;
}
