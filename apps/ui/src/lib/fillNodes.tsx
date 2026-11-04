import { Fragment, type ReactNode } from "react";

/**
 * A translated sentence with elements inside it: `fillNodes(t("wallet.first.orNew"), { new: <button>…</button> })`
 * puts each `{{name}}` of the text where the translation has it, so the words around a link or a button (and their
 * punctuation, in a right-to-left language too) come from the translation, not from pieces glued around it.
 * Call `t()` without the element's params: a placeholder it is not given stays in the text for this to fill.
 */
export function fillNodes(text: string, nodes: Record<string, ReactNode>): ReactNode {
  const parts = text.split(/\{\{(\w+)\}\}/);
  return parts.map((part, i) => i % 2 === 0 ? part : <Fragment key={i}>{part in nodes ? nodes[part] : `{{${part}}}`}</Fragment>);
}

/**
 * A translated sentence with names in it, each its own `<bdi>`: `fillNames(t("devices.remove.title"), { device })`. A
 * name the person gave (a device's, Latin in an Arabic sentence) keeps its own direction, so the punctuation at its edge
 * stays on its side ("Pixel-", "MacBook (Pro)", "2nd phone"), and the sentence's text is the same as without. No
 * text (a notice with no next line) is none.
 */
export function fillNames(text: string | undefined, names: Record<string, string>): ReactNode {
  return text === undefined ? undefined : fillNodes(text, Object.fromEntries(Object.entries(names).map(([key, name]) => [key, <bdi>{name}</bdi>])));
}
