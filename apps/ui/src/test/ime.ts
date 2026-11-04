import { fireEvent } from "@testing-library/react";

/**
 * A word composed with an IME at the caret, as Chromium sends it: compositionstart, an input for each step of the
 * reading with the composed text in the field (に, にほ, 日本), then compositionend. `read` is how the field looks after
 * each step, for a test to check what it showed while composing.
 */
export function compose(input: HTMLInputElement, steps: string[], read: (value: string) => void = () => {}) {
  const at = input.selectionStart ?? input.value.length, before = input.value.slice(0, at), after = input.value.slice(input.selectionEnd ?? at);
  fireEvent.compositionStart(input);
  for (const step of steps) {
    fireEvent.input(input, { target: { value: before + step + after } });
    read(input.value);
  }
  fireEvent.compositionEnd(input, { data: steps[steps.length - 1] });
}
