
export const catalog = {
  meta: {
    title: "WISPs",
    description: "The Ghostly WISPs that work in the app today, drawn as layers from the core up. Each one is an open contract any app can implement.",
  },
  eyebrow: "WISPs",
  title: "Every contract, in one place.",
  lead: "WISPs (Wire Interoperability Specification Proposals) are Ghostly's open specs, and little ghosts. Like BIPs for Bitcoin, each one is a contract any app can implement. These work in Ghostly today.",
  next: "What comes next is on the",
  roadmap: "roadmap",
  kinds: { Contract: "Contract", Adapter: "Adapter", Profile: "Profile", Process: "Process" } as Record<string, string>,
  process: "Process document",
  map: {
    stack: "The WISP families as layers, the core at the top",
    legend: "Core at the top; each layer builds on the ones above it. Big tile: a family's contract.",
  },
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
