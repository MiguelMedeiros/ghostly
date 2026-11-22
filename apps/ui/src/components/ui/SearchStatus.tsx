import { useEffect, useState } from "react";

/** How long the typing rests before what a search found is said. */
export const SEARCH_STATUS_SETTLE_MS = 600;

/**
 * What a search found, said to a screen reader once the typing settles (a polite status, out of sight): "45 emoji",
 * "No chat by that name". Each keystroke would say a count of its own; an empty `text` (no search) is cleared at once.
 */
export function SearchStatus({ text, testId }: { text: string; testId: string }) {
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (!text) { setSaid(""); return; }
    const timer = setTimeout(() => setSaid(text), SEARCH_STATUS_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid={testId}>{said}</p>;
}
