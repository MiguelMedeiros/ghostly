import axe from "axe-core";

/**
 * What axe-core finds wrong in an element, as `rule: html` lines (none: `[]`). Without `color-contrast`: the tests load
 * no stylesheets, so every colour is the default one.
 */
export async function axeViolations(element: Element): Promise<string[]> {
  const { violations } = await axe.run(element, { rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
  return violations.flatMap(v => v.nodes.map(node => `${v.id}: ${node.html}`));
}
