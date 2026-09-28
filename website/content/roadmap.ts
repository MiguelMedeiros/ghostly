/**
 * The roadmap page's own words: the introduction and the labels. The tracks
 * (what exists, what is next, the gates) and the inventory are written in
 * docs/wisps/ADAPTER-ROADMAP.md and generated into lib/roadmap-tracks.json and
 * lib/roadmap-candidates.json by `npm run sync:references`.
 */
export const roadmap = {
  meta: {
    title: "Roadmap",
    description:
      "Where Ghostly goes after 1.0, in order and with dependencies: richer chats, more ways to pay, optional identities, groups, storage, SDKs and plugins, independent apps and a self-hosted runtime. No invented dates.",
  },
  eyebrow: "Public roadmap",
  title: "The ghost keeps learning.",
  lead: "It started small, learned to find someone, then new ways to talk and to trade value. What comes next is ordered by what it depends on, not by dates we'd have to invent.",
  rules: [
    "No dates. Order and dependencies only.",
    "What already exists is marked as such, not listed as future work.",
    "A candidate is not a commitment. Crediting a technology is not a partnership.",
  ],
  now: "Where it stands",
  next: "Next",
  gate: "Before it's called done",
  after: "Builds on",
  /** A track with nothing built yet. */
  nothing: "Nothing yet",
  inventory: {
    title: "Every possibility, classified",
    lead: "From the adapter roadmap in the repository: transports, rails, providers, identities, hardware, storage and apps. Open a category to see its entries, and an entry for the source notes.",
    entries: "entries",
    openAll: "Open all",
    closeAll: "Close all",
    source: "Read the full adapter roadmap",
    sourceStatus: "as written in the source",
    /** The source's statuses that the three levels don't name; shown before the source's note. */
    states: { "In implementation": "In implementation", Blocked: "Blocked" },
  },
};

export type RoadmapCopy = typeof roadmap;
