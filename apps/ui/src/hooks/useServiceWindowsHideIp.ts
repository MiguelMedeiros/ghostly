import { useEffect, useRef } from "react";
import { useEngineValue } from "../lib/engineState";
import { closeServiceWindows } from "../lib/serviceWindows";

/**
 * "Hide my IP from contacts" turned on: every contact's app open now closes, as at the lock. Each was opened with the
 * setting off, so it loads from wherever the app says (Desktop's window, the web's view) or, in the extension, may send
 * its tab to any server, and the extension opens none while the setting is on. Opened again, it gets the new rules.
 * Only a change from off: the profile's first state is no change.
 */
export function useServiceWindowsHideIp(): void {
  const relayOnly = useEngineValue((state) => (state ? state.settings.relayOnly === true : null));
  const before = useRef(relayOnly);
  useEffect(() => {
    const was = before.current;
    before.current = relayOnly;
    if (was === false && relayOnly === true) closeServiceWindows();
  }, [relayOnly]);
}
