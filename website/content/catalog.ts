
export const catalog = {
  meta: {
    title: "WISPs",
    description: "Every Ghostly WISP draft: searchable, grouped by family, with specification status kept apart from what actually runs.",
  },
  eyebrow: "WISPs",
  title: "Every contract, in one place.",
  lead: "Each WISP is an open contract that any app can implement. Here are all of them, by family. Tap one to read it.",
  axes: "Two separate questions: every document is a Draft specification; the badge says whether what it describes runs in the app.",
  search: "Search by number, name or what it does",
  searchLabel: "Search the WISPs",
  family: "Family",
  kind: "Kind",
  level: "Availability",
  all: "All",
  kinds: { Contract: "Contract", Adapter: "Adapter", Profile: "Profile", Process: "Process" } as Record<string, string>,
  process: "Process document",
  results: "{n} of {t} drafts",
  none: "Nothing matches. Try a number like 401 or a word like “files”.",
  clear: "Clear filters",
  unassigned: "number to be defined",
  unassignedHelp: "A planned draft whose public number isn't assigned yet; the old file name stays for links.",
  implements: "implements {n}",
  notClassified: "Not yet reviewed for the site",
  read: "Read",
  inventory: {
    title: "Adapter inventory",
    lead: "Candidates from the adapter roadmap. Listed here so links keep working; the roadmap explains order and dependencies. A candidate is not a commitment.",
    cta: "See the roadmap",
  },
  sources: "Catalog sources",
  map: {
    drafts: "drafts",
    contract: "Big tile: the contract, the shared rule of a family",
    adapter: "Small tile: an adapter or profile, one concrete way to follow it",
    color: "Color: whether it already works in the app",
  },
  listTitle: "Search and full list",
  glossary: {
    title: "Glossary",
    hint: "WISP, capability, adapter, profile, provider, plugin",
    items: [
      { id: "wisp", term: "WISP", gloss: "A contract anyone can implement", key: "WISP 03" },
      { id: "capability", term: "Capability", gloss: "What a running client offers", key: "files/2" },
      { id: "adapter", term: "Adapter", gloss: "One technology behind a contract", key: "webrtc/1" },
      { id: "profile", term: "Protocol profile", gloss: "The exact wire rules in use", key: "paired-chat/1" },
      { id: "provider", term: "Provider / signer", gloss: "Who runs a service or signs for it", key: "Cashu mint" },
      { id: "plugin", term: "Plugin", gloss: "Adapters packaged and compiled into a build", key: "registerAdapters()" },
    ] as { id: string; term: string; gloss: string; key: string; status?: string }[],
  },
};

export type CatalogCopy = typeof catalog;
