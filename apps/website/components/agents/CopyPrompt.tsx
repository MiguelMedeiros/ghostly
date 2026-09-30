"use client";

import { useState } from "react";

/** The prompt's box on the page: what a Copy without a clipboard selects. */
const PROMPT_ID = "agent-prompt";

/**
 * Copies the prompt. Without a clipboard (an insecure origin, a denied permission) it selects the whole prompt in its
 * box instead, and brings the box into view, so Cmd+C or Ctrl+C still takes all of it.
 */
function usePromptCopy(text: string) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch {
      const node = document.getElementById(PROMPT_ID);
      const selection = window.getSelection();
      if (!node || !selection) return;
      selection.removeAllRanges();
      selection.selectAllChildren(node);
      node.scrollIntoView({ block: "nearest" });
    }
  };
  return { done, copy };
}

/** The hero's one button: copies the prompt, which is read in full further down. */
export function CopyPromptButton({ text, copy, copied }: { text: string; copy: string; copied: string }) {
  const c = usePromptCopy(text);
  return (
    <button type="button" className="btn btn--primary btn--lg ag-copy" onClick={c.copy} aria-live="polite" data-testid="agent-prompt-copy">
      {c.done ? `✓ ${copied}` : copy}
    </button>
  );
}

/** The prompt a person pastes into their agent, whole, with its own Copy button. */
export function CopyPrompt({ text, label, copy, copied }: { text: string; label: string; copy: string; copied: string }) {
  const c = usePromptCopy(text);
  return (
    <div className="ag-prompt">
      <div className="ag-prompt-bar">
        <span className="ag-prompt-label">{label}</span>
        <button type="button" className="btn btn--primary ag-copy" onClick={c.copy} aria-live="polite" data-testid="agent-prompt-box-copy">
          {c.done ? `✓ ${copied}` : copy}
        </button>
      </div>
      <pre id={PROMPT_ID} className="ag-prompt-text" aria-label={label} tabIndex={0} data-testid="agent-prompt">
        <code>{text}</code>
      </pre>
    </div>
  );
}
