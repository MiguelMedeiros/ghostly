import { useEffect, useState } from "react";

/** Copies a key to the clipboard (an ID card's back) and says so for a moment. */
export function useCopyKey(key: string) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return { copied, copy: () => { void navigator.clipboard?.writeText(key).catch(() => {}); setCopied(true); } };
}
