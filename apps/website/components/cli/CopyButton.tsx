"use client";

import { useState } from "react";

/** Copies a command. The label says what happened, so no icon is needed to read it. */
export function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (an insecure origin, a denied permission): the command stays selectable.
    }
  };
  return (
    <button type="button" className="btn cl-copy" onClick={copy} aria-live="polite">
      {copied ? done : label}
    </button>
  );
}
