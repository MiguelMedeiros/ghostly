import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, basename } from "node:path";
import { roadmapCandidates } from "./roadmap-candidates.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = resolve(root, "docs/wisps");
const destination = resolve(root, "website/public/reference");
const numbering = JSON.parse(readFileSync(resolve(source, "numbering.json"), "utf8"));
const candidates = roadmapCandidates(readFileSync(resolve(source, "ADAPTER-ROADMAP.md"), "utf8"));
writeFileSync(resolve(root, "website/lib/roadmap-candidates.json"), JSON.stringify(candidates, null, 2) + "\n");
console.log(`Catalogue coverage: ${candidates.length} roadmap inventory entries, each with a unique navigable ID.`);
writeFileSync(resolve(root, "website/lib/wisp-numbering.json"), JSON.stringify(numbering, null, 2) + "\n");
const guide = `# WISP numbering and compatibility

All ${numbering.length} specifications remain Draft. Family numbering was approved on 2026-09-22. This migration is editorial: wire capability names, versions, storage keys and implemented protocol behavior are unchanged.

## Independent families

| Range | Contract and scope |
|---|---|
| 00–99 | Foundations: process, Ghost Core, peer keys, common capabilities |
| 100–199 | Transport negotiation (100), WebRTC (101), Iroh (102), HyperDHT (103) |
| 200–299 | Payment negotiation (200), Cashu (201), experimental Arkade (202), Lightning (203) |
| 300–399 | Identity proofs (300; external proofs optional), Nostr (301; disabled experimental), Pubky and Keet (3xx; planned, number to be defined) |
| 400–499 | Chat messaging (400), an independent application capability |
| 500–599 | File transfer (500), an independent application capability |
| 600–699 | Voice and video (600), an independent application capability |
| 700–799 | Local services (700), an independent application capability |
| 800–899 | Invite and join (800), an independent admission contract |
| 900–999 | Group session negotiation (900), optional GossipSub distribution (9xx; planned, number to be defined) |

202 documents the experimental Arkade integration, its regtest evidence and unfinished release gates. A document describing an adapter does not establish that an adapter is implemented. A vendor/plugin does not automatically require a WISP. These families are not a mandatory stack; DHT text has its own bounded delivery path and external identity remains optional.

## Migration table

Generated from [numbering.json](numbering.json); edit that source instead of this table.

| Previous draft | Current draft |
|---|---|
${numbering.map((entry) => `| ${entry.oldId} | [${entry.displayNumber}${entry.numberAssignment === "unassigned" ? " · " + entry.file.replace(/^[0-9]+-/, "").replace(/\.md$/, "") + " · planned; number to be defined" : ""}](${entry.file}) |`).join("\n")}

## Link compatibility

New profile entries describe existing wire behavior, not new implementations. No empty numbered specifications are generated.

Old website reader URLs render the current document with a canonical link and a migration notice. Old raw Markdown URLs remain downloadable aliases. Existing section fragments remain usable; renamed top-level WISP headings have legacy anchor aliases. Catalogue fragments use current IDs first. Old numeric-only fragments 01/02/03 are ambiguous after the foundations migration; current numbering wins. Legacy full-slug reader URLs remain unambiguous. Repository forwarding documents preserve old Markdown links. No server redirect is required, including for a static export.
`;
writeFileSync(resolve(source, "NUMBERING.md"), guide);
for (const entry of numbering.filter((entry) => entry.oldFile !== entry.file)) {
  writeFileSync(resolve(source, entry.oldFile), `# WISP ${entry.oldId} moved to ${entry.id}\n\nThis Draft has a new editorial number. Read [WISP ${entry.id}](${entry.file}). Protocol identifiers and implementation status are unchanged. See [the migration map](NUMBERING.md).\n`);
}
const legacyFiles = new Set(numbering.filter((entry) => entry.oldFile !== entry.file).map((entry) => entry.oldFile));

mkdirSync(destination, { recursive: true });
// Working notes between agents (local paths, internal state) live next to the WISPs but are not published.
const internal = (name) => /^(HANDOFF|QA)-CLAUDE/.test(name);
const paths = readdirSync(source)
  .filter((name) => name.endsWith(".md") && !legacyFiles.has(name) && !internal(name))
  .map((name) => `docs/wisps/${name}`);
paths.push(
  "docs/PROTOCOL.md",
  "docs/USDT-INTEGRATION.md",
  "docs/DHT-DELIVERY.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
);
const entries = paths.map((sourcePath) => {
  const file = basename(sourcePath);
  copyFileSync(resolve(root, sourcePath), resolve(destination, file));
  const body = readFileSync(resolve(root, sourcePath), "utf8");
  return {
    file,
    sourcePath,
    aliases: numbering.filter((entry) => entry.file === file && entry.oldFile !== file).map((entry) => entry.oldFile.replace(/\.md$/, "").toLowerCase()),
    slug: file.replace(/\.md$/, "").toLowerCase(),
    title: body.match(/^#\s+(.+)$/m)?.[1] ?? file,
  };
});
for (const entry of numbering.filter((entry) => entry.oldFile !== entry.file)) {
  copyFileSync(resolve(destination, entry.file), resolve(destination, entry.oldFile));
}
if (new Set(entries.map((e) => e.slug)).size !== entries.length)
  throw new Error("Reference slug collision");
writeFileSync(
  resolve(root, "website/lib/reference-index.json"),
  JSON.stringify(entries, null, 2) + "\n",
);
console.log(
  `Synced ${entries.length} reference documents and their route index.`,
);
