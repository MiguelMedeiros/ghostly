/**
 * Where an old link to the WISPs page goes (OldAnchors), from its anchor decoded and the drafts the page no longer
 * draws, by every id an old link may use: a `#wisp-…` of one of those drafts opens its page, `#inventory` and its
 * `#candidate-…` rows open the roadmap. `undefined` leaves the page as it is. Only the drafts' own keys count: on a
 * plain object, `#wisp-constructor` or `#wisp-__proto__` would find what every object inherits.
 */
export function oldAnchorTarget(id: string, drafts: Record<string, string>): string | undefined {
  const key = id.slice(5);
  const slug = id.startsWith("wisp-") && Object.hasOwn(drafts, key) ? drafts[key] : undefined;
  if (slug) return `/wisps/${slug}`;
  if (id === "inventory") return "/roadmap#inventory-title";
  if (id.startsWith("candidate-")) return `/roadmap#${id}`;
  return undefined;
}
