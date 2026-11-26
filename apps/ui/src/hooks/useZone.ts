import { useEffect, useState } from "react";
import { zoneNow } from "../lib/chatDays";

/** Calls `check` each time the page comes back (shown or focused); gives what stops it. */
export function onPageBack(check: () => void): () => void {
  const shown = () => { if (document.visibilityState !== "hidden") check(); };
  document.addEventListener("visibilitychange", shown);
  window.addEventListener("focus", check);
  return () => {
    document.removeEventListener("visibilitychange", shown);
    window.removeEventListener("focus", check);
  };
}

/**
 * The device's time zone (`zoneNow`), checked again when the page comes back (shown or focused) and set only when it
 * changed: a chat finds its rows' days again then (`rowDaysReader`), so today's are under one Today in the new zone.
 */
export function useZone(): string {
  const [zone, setZone] = useState(zoneNow);
  useEffect(() => onPageBack(() => {
    const now = zoneNow();
    if (now !== zone) setZone(now);
  }), [zone]);
  return zone;
}
