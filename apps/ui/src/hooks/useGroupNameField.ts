import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type CompositionEvent } from "react";
import { fitGroupName, fitGroupNameEdit } from "../lib/groups";

/**
 * A group name field's handlers and ref: each change kept to what a group's name takes (`fitGroupNameEdit`), the
 * caret put back where the kept text ends when something was left out (a controlled field otherwise moves it to the
 * end). New group and Rename (agents#1097).
 *
 * A word composed with an IME (Japanese, Chinese) is not cut while it is composed: fitted then, a name with one
 * character left took the first kana of the reading ("に") instead of the chosen word ("日本"). At the end it goes in
 * whole if it fits, else nothing does, as with `maxLength`.
 *
 * A keystroke or paste the name has no room for at all is refused before it reaches the field (`beforeinput`): let in
 * and then put back by script, the field lost the browser's undo history, and Ctrl+Z undid nothing (agents#1154).
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
  // Each draw: Rename's field comes and goes with the form around it.
  const bound = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const input = ref.current;
    if (input === bound.current) return;
    bound.current?.removeEventListener("beforeinput", refuse);
    input?.addEventListener("beforeinput", refuse);
    bound.current = input;
  });
  useEffect(() => () => bound.current?.removeEventListener("beforeinput", refuse), []);
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

/** Cancels an insertion at a caret that would leave the name as it is (`fitGroupNameEdit` keeps none of it). */
function refuse(e: InputEvent) {
  const input = e.target as HTMLInputElement;
  if (e.isComposing || !e.inputType.startsWith("insert") || !e.data) return;
  const at = input.selectionStart, end = input.selectionEnd;
  // Over a selection, what fits takes its place: that is a change, left to onChange.
  if (at === null || at !== end) return;
  const before = input.value, after = before.slice(0, at) + e.data + before.slice(at);
  if (fitGroupNameEdit(before, after, at + e.data.length).value === before) e.preventDefault();
}
