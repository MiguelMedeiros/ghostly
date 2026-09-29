"use client";

import { useRef, useState } from "react";

/**
 * The prompt a person pastes into their agent, with one big Copy button. Without a clipboard (an insecure origin, a
 * denied permission) the button selects the whole prompt instead, so Cmd+C or Ctrl+C still takes all of it.
 */
export function CopyPrompt({ text, label, copy, copied }: { text: string; label: string; copy: string; copied: string }) {
  const pre = useRef<HTMLPreElement>(null);
  const [done, setDone] = useState(false);
  const selectAll = () => {
    const node = pre.current;
    const selection = window.getSelection();
    if (!node || !selection) return;
    selection.removeAllRanges();
    selection.selectAllChildren(node);
  };
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch {
      selectAll();
    }
  };
  return (
    <div className="ag-prompt">
      <div className="ag-prompt-bar">
        <span className="ag-prompt-label">{label}</span>
        <button type="button" className="btn btn--primary ag-copy" onClick={onCopy} aria-live="polite" data-testid="agent-prompt-copy">
          {done ? `✓ ${copied}` : copy}
        </button>
      </div>
      <pre ref={pre} className="ag-prompt-text" aria-label={label} tabIndex={0} data-testid="agent-prompt">
        <code>{text}</code>
      </pre>
    </div>
  );
}
