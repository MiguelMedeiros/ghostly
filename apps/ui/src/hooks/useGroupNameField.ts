import { useCallback, useLayoutEffect, useRef, useState, type ChangeEvent, type CompositionEvent } from "react";
import { fitGroupName, fitGroupNameEdit } from "../lib/groups";

/**
 * A group name field's handlers and ref: each change kept to what a group's name takes (`fitGroupNameEdit`), the
 * caret put back where the kept text ends when something was left out (a controlled field otherwise moves it to the
 * end). New group and Rename (agents#1097).
 *
 * A word composed with an IME (Japanese, Chinese) is not cut while it is composed: fitted then, a name with one
 * character left took the first kana of the reading ("に") instead of the chosen word ("日本"). At the end it goes in
 * whole if it fits, else nothing does, as with `maxLength`.
 */
export function useGroupNameField(value: string, setValue: (value: string) => void) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  // The name and caret as a composition found them, from its start to its end.
  const composing = useRef<{ value: string; caret: number } | null>(null);
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
    if (composing.current) { setValue(e.target.value); return; }
    const next = fitGroupNameEdit(value, e.target.value, e.target.selectionStart);
    if (next.value !== e.target.value) { caret.current = next.caret; setRefused(n => n + 1); }
    setValue(next.value);
  }, [value, setValue]);
  const onCompositionStart = useCallback((e: CompositionEvent<HTMLInputElement>) => {
    composing.current = { value, caret: e.currentTarget.selectionStart ?? value.length };
  }, [value]);
  const onCompositionEnd = useCallback((e: CompositionEvent<HTMLInputElement>) => {
    const start = composing.current, composed = e.currentTarget.value;
    composing.current = null;
    if (!start || fitGroupName(composed) === composed) { setValue(composed); return; }
    caret.current = start.caret; setRefused(n => n + 1);
    setValue(start.value);
  }, [setValue]);
  return { ref, onChange, onCompositionStart, onCompositionEnd };
}
