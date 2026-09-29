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
