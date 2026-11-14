import { LEGACY_GROUP_MEMBERS, type PollIntervals } from "@ghostly/core";

/**
 * How much slower this app looks at the Pkarr records of its connected edges in a community than a chat would, while it
 * holds `edges` edges there: up to eight, as a chat; past that, in proportion. A member holds one or two (its hubs);
 * a hub one per member it carries, and each connected read is a request of the minute the relays allow this app.
 * At the chat's pace, an admin carrying 22 members spent 22 of its 60 requests a minute on those reads alone, so it
 * had little left to bring up the edges of the members another hub's closing had cut off, who waited two to five
 * minutes (bug hunt, 2026-11-11). Now a hub's connected edges cost about 8 reads a minute however many it
 * carries, as a private group's do (`meshEdgeScale`), and the edges it is bringing up count too, so the reads slow
 * further while it takes members in. A data link that drops is noticed on its own (the edge reads fast again): a
 * connected read only notices a member's new offer while this side still thinks the link is up.
 */
export function communityEdgeScale(edges: number): number {
  return Math.max(1, edges / LEGACY_GROUP_MEMBERS);
}
/** A community edge's poll pace, read live: its connected reads follow how many edges this app holds there. */
export function communityEdgeIntervals(base: PollIntervals, edges: () => number): PollIntervals {
  return {
    active: base.active, idle: base.idle, fast: base.fast, background: base.background,
    get connected() { return Math.round(base.connected * communityEdgeScale(edges())); },
  };
}
