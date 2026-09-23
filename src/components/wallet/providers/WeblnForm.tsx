import { useEffect, useState } from "react";
import { Button, Notice } from "../ui";
import type { ProviderFormProps } from "./forms";

/** Whether a WebLN wallet has put `window.webln` in this page (some do so a moment after it loads). */
function useWeblnPresent() {
  const present = () => typeof (window as { webln?: { enable?: unknown } }).webln?.enable === "function";
  const [found, setFound] = useState(present);
  useEffect(() => {
    if (found) return;
    const check = () => { if (present()) setFound(true); };
    const poll = setInterval(check, 500);
    window.addEventListener("webln:ready", check);
    return () => { clearInterval(poll); window.removeEventListener("webln:ready", check); };
  }, [found]);
  return found;
}

/**
 * The browser wallet (WebLN) has nothing to type and no secret to keep: one button, and the wallet asks
 * the person to approve the connection in its own window.
 */
export function WeblnForm({ descriptor, busy, onSubmit }: ProviderFormProps) {
  const found = useWeblnPresent();
  return (
    <div className="space-y-3" data-testid={`provider-form-${descriptor.id}`}>
      {found ? (
        <Notice testId="webln-found">A WebLN wallet is in this browser. It will ask you to approve the connection, and again before each payment if you set it to.</Notice>
      ) : (
        <Notice tone="warning" testId="webln-missing">No WebLN wallet found in this browser. Install or unlock one (Alby, for example), then connect.</Notice>
      )}
      <Button variant="primary" className="w-full" disabled={busy} onClick={() => onSubmit({})} data-testid="provider-save">{busy ? "Waiting for the wallet…" : "Connect browser wallet"}</Button>
      <Notice>Ghostly still shows you every payment to approve before the wallet is asked to pay. The wallet holds the sats; nothing is stored here.</Notice>
    </div>
  );
}
