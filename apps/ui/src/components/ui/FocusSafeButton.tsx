import { useState } from "react";

/**
 * A `<button>` that keeps the keyboard's focus when it gets `disabled` while it has it: pressed from the keys, the work
 * it starts (or a field it saved, now unchanged) disables it, and a browser drops the focus of a disabled control to
 * the page, where it stays when the work fails. Until the focus leaves it, it is `aria-disabled` instead (said as
 * unavailable, its press and a form's Enter on it ignored); then natively disabled as asked. A button disabled before
 * it had the focus is plain `disabled`, out of the Tab order as before. The window losing the focus (another tab, a save
 * dialog its work opened) blurs it but leaves it the page's focus, which the window's return gives back: it keeps it.
 */
export function FocusSafeButton({ disabled, onClick, onFocus, onBlur, ...props }: React.ComponentPropsWithRef<"button">) {
  const [focused, setFocused] = useState(false);
  const held = !!disabled && focused;
  return (
    <button {...props} disabled={!!disabled && !focused} aria-disabled={held || props["aria-disabled"] || undefined} data-held={held || undefined}
      onFocus={(e) => { setFocused(true); onFocus?.(e); }} onBlur={(e) => { if (document.activeElement !== e.currentTarget) setFocused(false); onBlur?.(e); }}
      onClick={(e) => { if (held) e.preventDefault(); else onClick?.(e); }} />
  );
}
