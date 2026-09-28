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
import { roadmapTracks } from "./roadmap-tracks.mjs";
import { siteFields } from "./wisp-header.mjs";
import { readChanges, withRevisions } from "./wisp-changes.mjs";
import { writeLlms } from "./llms.mjs";
import { agentPromptJson } from "./agent-prompt.mjs";
import { README, expectedReadme } from "./wisp-index.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = resolve(root, "docs/wisps");
const destination = resolve(root, "website/public/reference");
const numbering = JSON.parse(readFileSync(resolve(source, "numbering.json"), "utf8"));
const roadmap = readFileSync(resolve(source, "ADAPTER-ROADMAP.md"), "utf8");
const candidates = roadmapCandidates(roadmap);
writeFileSync(resolve(root, "website/lib/roadmap-tracks.json"), JSON.stringify(roadmapTracks(roadmap), null, 2) + "\n");
writeFileSync(resolve(root, "website/lib/roadmap-candidates.json"), JSON.stringify(candidates, null, 2) + "\n");
console.log(`Catalogue coverage: ${candidates.length} roadmap inventory entries, each with a unique navigable ID.`);
writeFileSync(resolve(root, "website/lib/wisp-numbering.json"), JSON.stringify(numbering, null, 2) + "\n");
const guide = `# WISP numbering and compatibility

All ${numbering.length} specifications have the document status Draft; each says in its header what is implemented, and the [index](README.md) lists them all. Family numbering was approved on 2026-09-22. This migration is editorial: wire capability names, versions, storage keys and implemented protocol behavior are unchanged.

## Independent families

| Range | Contract and scope |
|---|---|
| 00-99 | Foundations: process (00), Ghost Core (01), peer keys (02), capabilities (03), local profiles (04), profile backups (05) |
| 100-199 | Transport negotiation (100), WebRTC (101), Iroh (102), HyperDHT (103) |
| 200-299 | Payment negotiation (200), Cashu (201), Arkade (202), Lightning (203), Bark (204), Lightning addresses (205); Spark and Fedimint (2xx, numbers to be defined) |
| 300-399 | Identity proofs (300; external proofs optional), Nostr (301); Pubky, Keet, domain, OpenPGP, Bitcoin address, SSH, OpenID Connect, AT Protocol (Bluesky) and DID providers, the profile DID (did:dht) and the Nostr social layer (3xx, numbers to be defined) |
| 400-499 | Chat messaging (400), chat session (401), compatibility chat (402), DHT text (403); store-and-forward for an away contact (4xx, number to be defined) |
| 500-599 | File transfer (500), chat files (501), compatibility file frames (502) |
| 600-699 | Voice and video (600), WebRTC media (601) |
| 700-799 | Local services (700), HTTP local service profile (701) |
| 800-899 | Invite and join (800), invitation profiles (801) |
| 900-999 | Group session negotiation (900); group mesh, group community and optional GossipSub distribution (9xx, numbers to be defined) |
| 1000-1099 | Storage contract (1000), local file storage (1001), S3-compatible storage (1002) |
| 1100-1199 | Headless runtime and its local control API (11xx, number to be defined); local only, nothing on the wire |

A document describing an adapter does not establish that an adapter is implemented. A vendor/plugin does not automatically require a WISP. These families are not a mandatory stack; DHT text has its own bounded delivery path and external identity remains optional.

## Migration table

Generated from [numbering.json](numbering.json); edit that source instead of this table.

| Previous draft | Current draft |
|---|---|
${numbering.map((entry) => `| ${entry.oldId} | [${entry.displayNumber}${entry.numberAssignment === "unassigned" ? " · " + entry.file.replace(/^[0-9x]+-/, "").replace(/\.md$/, "") + " · number to be defined" : ""}](${entry.file}) |`).join("\n")}

## Link compatibility

New profile entries describe existing wire behavior, not new implementations. No empty numbered specifications are generated.

Old website reader URLs render the current document with a canonical link and a migration notice. Old raw Markdown URLs remain downloadable aliases. Existing section fragments remain usable; renamed top-level WISP headings have legacy anchor aliases. Catalogue fragments use current IDs first. Old numeric-only fragments 01/02/03 are ambiguous after the foundations migration; current numbering wins. Legacy full-slug reader URLs remain unambiguous. Repository forwarding documents preserve old Markdown links. No server redirect is required, including for a static export.
`;
writeFileSync(resolve(source, "NUMBERING.md"), guide);
// The index on GitHub (docs/wisps/README.md): its table is read from the WISPs' headers (scripts/wisp-index.mjs).
writeFileSync(resolve(root, README), expectedReadme(root));
for (const entry of numbering.filter((entry) => entry.oldFile !== entry.file)) {
  writeFileSync(resolve(source, entry.oldFile), `# WISP ${entry.oldId} moved to ${entry.id}\n\nThis Draft has a new editorial number. Read [WISP ${entry.id}](${entry.file}). Protocol identifiers and implementation status are unchanged. See [the migration map](NUMBERING.md).\n`);
}
const legacyFiles = new Set(numbering.filter((entry) => entry.oldFile !== entry.file).map((entry) => entry.oldFile));

mkdirSync(destination, { recursive: true });
// Working notes between agents (local paths, internal state) live next to the WISPs but are not published.
const internal = (name) => /^(HANDOFF|QA)-CLAUDE/.test(name);
// README.md is the index on GitHub. On the site the index is /wisps, so the README is not a page of its own
// (lib/references.ts sends links to it there).
const paths = readdirSync(source)
  .filter((name) => name.endsWith(".md") && name !== basename(README) && !legacyFiles.has(name) && !internal(name))
  .map((name) => `docs/wisps/${name}`);
paths.push(
  "docs/PROTOCOL.md",
  "docs/SDK.md",
  "docs/USDT-INTEGRATION.md",
  "docs/DHT-DELIVERY.md",
);
// SECURITY.md and CONTRIBUTING.md stay on GitHub only: the footer links there, and their old reader
// addresses redirect there (next.config.ts).
// Plain text of a Markdown fragment: links keep their label, code keeps its text.
const plain = (text) =>
  text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
// What a WISP says about itself in its header table and first section, so the
// catalogue follows the documents instead of a copy of them.
function describe(body, file) {
  const field = (...names) => {
    for (const name of names) {
      const row = body.match(new RegExp(`^\\|\\s*${name}\\s*\\|\\s*(.+?)\\s*\\|\\s*$`, "m"));
      if (row) return row[1];
    }
    return undefined;
  };
  const dependencies = [...(field("Dependencies") ?? "").matchAll(/\]\(([^)#]+\.md)/g)].map((m) => basename(m[1]));
  const firstSection = body.split(/^## .+$/m)[1] ?? "";
  const paragraph = firstSection
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^[|>#`-]/.test(block) && !/^\d+\./.test(block));
  const notices = [...body.matchAll(/^> (?:\*\*)?(Release decision[^\n]*|Planned integration[^\n]*)/gm)].map((m) => plain(m[1]));
  const status = field("Status");
  const implementation = field("Implementation");
  const updated = field("Updated");
  return {
    status: status ? plain(status) : undefined,
    updated: updated ? plain(updated) : undefined,
    implementation: implementation ? plain(implementation) : undefined,
    documentKind: plain(field("Document kind", "Kind") ?? "") || undefined,
    dependencies,
    summary: paragraph ? plain(paragraph).slice(0, 420) : undefined,
    notices,
    // The catalogue's own line, availability and caveat: written in the header, nowhere on the site.
    ...siteFields(body, file),
  };
}
// Each WISP's revision log is a folder of change files (wisp-changes.mjs); a folder must name a WISP.
const wispStems = new Set(numbering.map((entry) => entry.file.replace(/\.md$/, "")));
for (const stem of readdirSync(resolve(source, "changes"))) {
  if (!wispStems.has(stem)) throw new Error(`docs/wisps/changes/${stem}/: no WISP ${stem}.md in numbering.json`);
}
const entries = paths.map((sourcePath) => {
  const file = basename(sourcePath);
  const stem = file.replace(/\.md$/, "");
  const text = readFileSync(resolve(root, sourcePath), "utf8");
  // The published copy carries the Revision and Updated rows and the log, from docs/wisps/changes/<stem>/.
  const changes = wispStems.has(stem) ? readChanges(source, stem) : [];
  if (wispStems.has(stem) && !changes.length) throw new Error(`docs/wisps/${stem}.md: no change file in docs/wisps/changes/${stem}/ (see 00-process.md, "Revisions")`);
  const body = changes.length ? withRevisions(text, stem, changes) : text;
  writeFileSync(resolve(destination, file), body);
  return {
    file,
    sourcePath,
    aliases: numbering.filter((entry) => entry.file === file && entry.oldFile !== file).map((entry) => entry.oldFile.replace(/\.md$/, "").toLowerCase()),
    slug: file.replace(/\.md$/, "").toLowerCase(),
    title: body.match(/^#\s+(.+)$/m)?.[1] ?? file,
    ...(numbering.some((entry) => entry.file === file) ? describe(body, file) : { dependencies: [], notices: [] }),
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
// What the map's blocks (lib/composition.ts) light up by: small, because the map runs in the browser.
writeFileSync(
  resolve(root, "website/lib/levels.json"),
  JSON.stringify(
    {
      wisps: Object.fromEntries(entries.filter((e) => "level" in e).map((e) => [e.slug, e.level])),
      rows: Object.fromEntries(candidates.map((c) => [c.id, c.level])),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Synced ${entries.length} reference documents and their route index.`,
);
// /llms.txt and /llms-full.txt for AI readers, from the documents just published (scripts/llms.mjs).
writeLlms(root, entries, numbering);
console.log("Wrote public/llms.txt and public/llms-full.txt.");

// Code the developer page quotes, cut from the source so it can't drift.
function excerpt(file, startPattern) {
  const lines = readFileSync(resolve(root, file), "utf8").split("\n");
  const start = lines.findIndex((line) => line.includes(startPattern));
  if (start < 0) throw new Error(`Snippet "${startPattern}" not found in ${file}`);
  let end = start;
  while (end < lines.length && lines[end] !== "}") end++;
  return { file, line: start + 1, code: lines.slice(start, end + 1).join("\n") };
}
writeFileSync(
  resolve(root, "website/lib/code-snippets.json"),
  JSON.stringify(
    {
      createLink: excerpt("packages/core/src/invite.ts", "/** Creates both ends of a link"),
      rankTransports: excerpt("packages/core/src/pairedTransports.ts", "/** Symmetric rank sum"),
    },
    null,
    2,
  ) + "\n",
);

// The prompt /developers/agents copies, cut from docs/AI-AGENTS.md so the page and the guide say the same thing.
writeFileSync(resolve(root, "website/lib/agent-prompt.json"), JSON.stringify(agentPromptJson(root), null, 2) + "\n");
