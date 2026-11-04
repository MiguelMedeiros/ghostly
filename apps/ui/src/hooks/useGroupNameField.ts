import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type CompositionEvent } from "react";
import { fitText, fitTextEdit } from "../lib/fitText";
import { fitsGroupName } from "../lib/groups";

/**
 * A name field's handlers and ref: each change kept to what the name takes (`fits`, by `fitTextEdit`), the caret put
 * back where the kept text ends when something was left out (a controlled field otherwise moves it to the end). New
 * group and Rename (agents#1097), a new device's name.
 *
 * A word composed with an IME (Japanese, Chinese) is not cut while it is composed: fitted then, a name with one
 * character left took the first kana of the reading ("に") instead of the chosen word ("日本"). At the end it goes in
 * whole if it fits, else nothing does, as with `maxLength`.
 *
 * A keystroke or paste the name has no room for at all is refused before it reaches the field (`beforeinput`): let in
 * and then put back by script, the field lost the browser's undo history, and Ctrl+Z undid nothing (agents#1154).
 */
export function useFittedNameField(value: string, setValue: (value: string) => void, fits: (name: string) => boolean) {
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
  // One listener for the field's life, which reads the rule of the latest draw.
  const rule = useRef(fits);
  rule.current = fits;
  const [refuse] = useState(() => (e: InputEvent) => refuseInsertion(e, rule.current));
  // Each draw: Rename's field comes and goes with the form around it.
  const bound = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const input = ref.current;
    if (input === bound.current) return;
    bound.current?.removeEventListener("beforeinput", refuse);
    input?.addEventListener("beforeinput", refuse);
    bound.current = input;
  });
  useEffect(() => () => bound.current?.removeEventListener("beforeinput", refuse), [refuse]);
  const onChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    if (composing.current) { setValue(e.target.value); return; }
    const next = fitTextEdit(value, e.target.value, e.target.selectionStart, fits);
    if (next.value !== e.target.value) { caret.current = next.caret; setRefused(n => n + 1); }
    setValue(next.value);
  }, [value, setValue, fits]);
  const onCompositionStart = useCallback((e: CompositionEvent<HTMLInputElement>) => {
    composing.current = { value, caret: e.currentTarget.selectionStart ?? value.length };
  }, [value]);
  const onCompositionEnd = useCallback((e: CompositionEvent<HTMLInputElement>) => {
    const start = composing.current, composed = e.currentTarget.value;
    composing.current = null;
    if (!start || fitText(composed, fits) === composed) { setValue(composed); return; }
    caret.current = start.caret; setRefused(n => n + 1);
    setValue(start.value);
  }, [setValue, fits]);
  return { ref, onChange, onCompositionStart, onCompositionEnd };
}

/** A group name field (`fitsGroupName`). */
export const useGroupNameField = (value: string, setValue: (value: string) => void) => useFittedNameField(value, setValue, fitsGroupName);

/** Cancels an insertion at a caret that would leave the name as it is (`fitTextEdit` keeps none of it). */
function refuseInsertion(e: InputEvent, fits: (name: string) => boolean) {
  const input = e.target as HTMLInputElement;
  if (e.isComposing || !e.inputType.startsWith("insert") || !e.data) return;
  const at = input.selectionStart, end = input.selectionEnd;
  // Over a selection, what fits takes its place: that is a change, left to onChange.
  if (at === null || at !== end) return;
  const before = input.value, after = before.slice(0, at) + e.data + before.slice(at);
  if (fitTextEdit(before, after, at + e.data.length, fits).value === before) e.preventDefault();
}
