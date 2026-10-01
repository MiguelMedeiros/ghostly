import { useState } from "react";
import type { Translate } from "../contexts/I18nContext";
import { amountInput, amountText, formatAmount, readAmount } from "../lib/amount";
import type { Language } from "../lib/settings";

/**
 * An amount field: it shows what the person typed, in their own writing ("1.000,5" in Portuguese), and gives its
 * owner the amount it means ("1000.5", or "" while it means nothing clear: the owner's buttons wait). `value` is that
 * amount: one set from outside (a default, a field emptied after a send) is shown the language's way. `hint` says, in
 * a few words, why what was typed is not read: a grouping mark where it could be a decimal point, or a decimal point
 * in a field of whole sats.
 */
export function useAmountText(value: string, onChange: (value: string) => void, language: Language, decimals = 0, t?: Translate) {
  const [text, setText] = useState(() => amountText(value, language));
  // The amount this field last gave its owner (or was given): another one is the owner's, and replaces the text.
  const [given, setGiven] = useState(value);
  if (value !== given) { setGiven(value); setText(amountText(value, language)); }
  const read = readAmount(text, language, decimals);
  const change = (typed: string) => {
    const next = amountInput(typed), meant = readAmount(next, language, decimals);
    const amount = meant.ok ? meant.value : "";
    setText(next); setGiven(amount);
    if (amount !== value) onChange(amount);
  };
  const example = decimals ? amountText("1234.5", language).replace(/^1234/, formatAmount(1234, language)) : formatAmount(1234, language);
  const hint = read.ok || !t ? null : t(read.why === "whole" ? "wallet.ui.amountWhole" : "wallet.ui.amountUnclear", { example });
  return { text, change, hint, problem: read.ok ? null : read.why };
}
