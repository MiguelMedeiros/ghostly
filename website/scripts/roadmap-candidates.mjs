// Keep catalogue details sourced from the roadmap, including every inventory row.
const sections = {
  "Transport, discovery and delivery": ["1", "Adapter / discovery"],
  "Rails and wallet adapters": ["2", "Payment rail"],
  "Providers, chain data and signer boundaries": ["2", "Connector"],
  "Identity, profiles and social data": ["social", "Social capability"],
  "Identity and social candidate matrix": ["3", "Identity / account adapter"],
  "Hardware and signing": ["signers", "Signer"],
  "Communication, groups and storage": ["storage", "Capability / storage"],
  "Plugins, apps, catalogs and GhostlyOS": ["runtime", "Runtime / product composition"],
};
const overrides = {
  "QR / explicit invitation": ["8", "Discovery / invitation"],
  GossipSub: ["9", "Distribution adapter"],
  "Ark via Bark": ["2", "Alternative Ark provider"],
  "Manual external wallet": ["2", "Wallet handoff"],
  "Bitcoin Core RPC": ["2", "Wallet connector / data source"],
  "Electrum protocol": ["2", "Chain data source"],
  Esplora: ["2", "Chain data source / broadcaster"],
  BDK: ["2", "Wallet library"],
  "PSBT exchange": ["2", "Signer handoff"],
  "Personal wallet / Umbrel": ["2", "Deployment composition"],
  NsecBunker: ["3", "Remote signer"],
  "Pubky profiles / graph / content": ["social", "Social data source"],
  Profile: ["social", "Profile data"],
  Proof: ["3", "Proof capability"],
  "Text, presence and typing": ["4", "Messaging / presence profile"],
  "Files and attachments": ["5", "File profile"],
  "Voice/video/screenshare": ["6", "Media profile"],
  "Private groups": ["9", "Membership capability"],
  "Group crypto": ["9", "Cryptographic profile"],
  "Channels / topics / forums": ["9", "Content profile"],
  "Password / payment-gated access": ["8", "Admission policy"],
  "Local HTTP / Bitcoin / Lightning services": ["7", "Service profile"],
};
// The one status each inventory row carries, in bold: "**Available**", "**In implementation: #123**",
// "**Blocked: what it waits for**", "**Planned**" or "**Research**" (see "Evidence and readiness" in
// the roadmap). The site shows it as one of its three levels; the text after the colon is a short
// plain-text note shown under the entry's title (code marks dropped, no links).
const STATES = { Available: "available", "In implementation": "planned", Blocked: "planned", Planned: "planned", Research: "research" };
const STATE = new RegExp(`\\*\\*(${Object.keys(STATES).join("|")})(?:: ([^*]+))?\\*\\*`, "g");
export function roadmapCandidates(markdown) {
  let section = "", headers = [];
  const entries = [];
  for (const line of markdown.split("\n")) {
    if (/^#{2,3} /.test(line)) { section = line.replace(/^#+ /, ""); headers = []; }
    if (!sections[section] || !line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (!headers.length) { headers = cells; continue; }
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (cells.length !== headers.length) throw new Error(`Malformed roadmap row: ${cells[0]}`);
    const title = cells[0];
    const [family, kind] = overrides[title] ?? sections[section];
    const detail = cells.slice(1).join(" ");
    const states = [...detail.matchAll(STATE)];
    if (states.length !== 1) throw new Error(`Roadmap row "${title}" needs exactly one status (${Object.keys(STATES).join(", ")}) in bold; found ${states.length}`);
    const [, status, marked] = states[0];
    const note = marked?.replace(/`/g, "");
    if (/[[\]()]/.test(note ?? "")) throw new Error(`Roadmap row "${title}": the status note is plain text, links go after it`);
    if (["In implementation", "Blocked"].includes(status) && !note) throw new Error(`Roadmap row "${title}": ${status} needs a note (the PR, or what it waits for)`);
    const slug = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    entries.push({ id: `candidate-${slug}`, title, family, kind, status, ...(note ? { note } : {}), level: STATES[status], range: /^\d$/.test(family) ? `${family}xx` : "Unassigned", section,
      body: cells.slice(1).map((cell, index) => `**${headers[index + 1]}**\n\n${cell}`).join("\n\n"),
      sourceAnchor: section.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-") });
  }
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Duplicate roadmap candidate ID");
  for (const section of Object.keys(sections)) if (!entries.some((entry) => entry.section === section)) throw new Error(`Missing roadmap inventory: ${section}`);
  return entries;
}
