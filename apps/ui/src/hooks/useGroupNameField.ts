import { useCallback, useLayoutEffect, useRef, useState, type ChangeEvent } from "react";
import { fitGroupNameEdit } from "../lib/groups";

/**
 * A group name field's change handler and ref: each change kept to what a group's name takes (`fitGroupNameEdit`), the
 * caret put back where the kept text ends when something was left out (a controlled field otherwise moves it to the
 * end). New group and Rename (agents#1097).
 */
export function useGroupNameField(value: string, setValue: (value: string) => void) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  // A keystroke refused whole leaves the value as it was, and React draws nothing: this draws once more, after it put
  // the field's value back (and its caret at the end), so the caret goes back.
  const [refused, setRefused] = useState(0);
  useLayoutEffect(() => {
    const at = caret.current, input = ref.current;
    if (at === null || !input) return;
    caret.current = null;
    input.setSelectionRange(at, at);
  }, [value, refused]);
  const onChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const next = fitGroupNameEdit(value, e.target.value, e.target.selectionStart);
    if (next.value !== e.target.value) { caret.current = next.caret; setRefused(n => n + 1); }
    setValue(next.value);
  }, [value, setValue]);
  return { ref, onChange };
}
