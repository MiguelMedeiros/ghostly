import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS_INTRO, KEY_DOCS, SITE, llmsFull, llmsIndex, wispsOf } from "./llms.mjs";

// The reference index and the published copies come from `npm run sync:references` (CI runs it before `npm test`).
const root = fileURLToPath(new URL("../../../", import.meta.url));
const numbering = JSON.parse(readFileSync(resolve(root, "docs/wisps/numbering.json"), "utf8"));
const entries = JSON.parse(readFileSync(resolve(root, "apps/website/lib/reference-index.json"), "utf8"));
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("the sync writes llms.txt and llms-full.txt, as the generator makes them", () => {
  for (const name of ["llms.txt", "llms-full.txt"]) assert.ok(existsSync(resolve(root, "apps/website/public", name)), `apps/website/public/${name}: run npm run sync:references`);
  assert.equal(read("apps/website/public/llms.txt"), llmsIndex(entries, numbering));
  assert.equal(read("apps/website/public/llms-full.txt"), llmsFull(entries, numbering, read));
});

test("llms.txt follows the convention: an H1, a summary, then sections of links", () => {
  const index = llmsIndex(entries, numbering);
  assert.match(index, /^# Ghostly\n\n> \S/);
  for (const section of ["Ghostly", "AI agents", "Trust", "How it works", "Developers", "WISPs", "CLI", "Optional"]) assert.match(index, new RegExp(`^## ${section}$`, "m"));
  // Before the first section: prose only, no heading but the H1 (the convention keeps headings for the link lists).
  const sections = index.indexOf("\n## ");
  assert.doesNotMatch(index.slice(0, sections), /\n#{1,6} /);
  for (const row of index.slice(sections).split("\n").filter((l) => l.startsWith("- "))) assert.match(row, /^- \[[^\]]+\]\(https:\/\/[^)\s]+\)(: \S.*)?$/, row);
  assert.ok(index.includes(`(${SITE}/developers/agents)`), "the AI agents page");
  assert.ok(index.includes("/packages/cli/SKILL.md)"), "the agent skill");
});

test("every WISP is in llms.txt with its title, page and line, and in llms-full.txt", () => {
  const index = llmsIndex(entries, numbering);
  const full = llmsFull(entries, numbering, read);
  const wisps = wispsOf(entries, numbering);
  assert.equal(wisps.length, numbering.length);
  for (const wisp of wisps) {
    assert.ok(wisp.benefit, `${wisp.file}: its header's Summary row`);
    assert.ok(index.includes(`- [${wisp.title}](${SITE}/wisps/${wisp.slug}): ${wisp.benefit}`), `${wisp.file} in llms.txt`);
    assert.ok(full.includes(`<!-- Source: ${SITE}/reference/${wisp.file} -->\n\n# ${wisp.title}\n`), `${wisp.file} in llms-full.txt`);
  }
  for (const path of KEY_DOCS) assert.ok(full.includes(read(path).trim()), `${path} in llms-full.txt`);
});

test("llms-full.txt is llms.txt, then the agent guides and the CLI reference before the WISPs", () => {
  const index = llmsIndex(entries, numbering);
  const full = llmsFull(entries, numbering, read);
  assert.ok(full.startsWith(`${index}\n---\n`), "llms-full.txt starts with llms.txt");
  assert.ok(full.startsWith("# Ghostly\n"));
  assert.ok(KEY_DOCS.includes("packages/cli/README.md"), "the README's table of every command");
  const firstWisp = full.indexOf(`<!-- Source: ${SITE}/reference/`);
  for (const path of KEY_DOCS) assert.ok(full.indexOf(read(path).trim()) < firstWisp, `${path} before the WISPs`);
});

// The commands of the CLI, as the first column of packages/cli/README.md's table names them (`group send <group>…`).
const cliCommands = () => {
  const readme = read("packages/cli/README.md");
  const table = readme.slice(readme.indexOf("| Command | What it does |"));
  const rows = table.split("\n").slice(2).filter((l) => l.startsWith("| `"));
  return new Set(rows.flatMap((row) => [...row.split(" | ")[0].matchAll(/`([a-z][a-z-]*(?: [a-z][a-z-]*)?)/g)].map((m) => m[1])));
};

test("every ghostly command the agents' text names is a command of the CLI, with flags the README gives it", () => {
  const commands = cliCommands();
  assert.ok(commands.has("listen") && commands.has("send") && commands.has("daemon"), "the README table was read");
  const used = [...AGENTS_INTRO.matchAll(/ghostly ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?((?: [^`#\n]*)?)/g)];
  assert.ok(used.length >= 8);
  const readme = read("packages/cli/README.md");
  for (const [whole, first, second, rest] of used) {
    const name = second && commands.has(`${first} ${second}`) ? `${first} ${second}` : first;
    assert.ok(commands.has(name), `ghostly ${name} is in packages/cli/README.md: ${whole}`);
    for (const flag of `${second ?? ""} ${rest}`.match(/--[a-z][a-z-]*/g) ?? []) {
      assert.ok(readme.includes(flag), `${flag} (in "${whole.trim()}") is in packages/cli/README.md`);
    }
  }
  assert.ok(AGENTS_INTRO.includes("npm install -g @ghostlytools/cli"));
  assert.equal(JSON.parse(read("packages/cli/package.json")).name, "@ghostlytools/cli");
});

// Pages that llms.txt links before they are on dev, each written in its own pull request (the threat model in #3004).
// One that is not there yet passes; once it is, it is checked like any other page. Take a path out once it is on dev.
const PENDING_ROUTES = new Set(["/developers/agents/threat-model", "/agents/faq"]);

/** The site's routes as patterns: app/<path>/page.tsx or route.ts, a [param] segment matching any one segment. */
const siteRoutes = () => {
  const app = resolve(root, "apps/website/app");
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (/^(page\.tsx|route\.ts)$/.test(entry.name)) out.push("/" + relative(app, dir).split("/").filter(Boolean).join("/"));
    }
  };
  walk(app);
  return out;
};

test("every link of llms.txt to the site lands on a page, a file or a WISP, and every link to the repository on a file", () => {
  const index = llmsIndex(entries, numbering);
  const routes = siteRoutes();
  const slugs = new Set(entries.map((e) => e.slug));
  const links = [...index.matchAll(/\]\((https:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
  const site = links.filter((url) => url === SITE || url.startsWith(`${SITE}/`));
  assert.ok(site.length > 10);
  for (const url of site) {
    const path = new URL(url).pathname.replace(/\/$/, "") || "/";
    if (PENDING_ROUTES.has(path) && !routes.includes(path)) continue;
    if (existsSync(resolve(root, "apps/website/public", `.${path}`)) && path !== "/") continue;
    const wisp = path.match(/^\/wisps\/([^/]+)$/);
    if (wisp) {
      assert.ok(slugs.has(wisp[1]), `${url}: a WISP or reference page`);
      continue;
    }
    const segments = path.split("/").filter(Boolean);
    const found = routes.some((route) => {
      const parts = route.split("/").filter(Boolean);
      return parts.length === segments.length && parts.every((part, i) => /^\[.+\]$/.test(part) || part === segments[i]);
    });
    assert.ok(found, `${url}: no page of apps/website/app serves it`);
  }
  const repo = /^https:\/\/(?:github\.com\/MiguelMedeiros\/ghostly\/blob\/(?:dev|main)|raw\.githubusercontent\.com\/MiguelMedeiros\/ghostly\/dev)\/(.+)$/;
  const files = links.map((url) => url.match(repo)).filter(Boolean);
  assert.ok(files.length >= 8);
  for (const [url, path] of files) assert.ok(existsSync(resolve(root, path)), `${url}: no file ${path} in the repository`);
});

test("both files start with # Ghostly, and every page links llms.txt in its head and footer", () => {
  for (const name of ["llms.txt", "llms-full.txt"]) assert.ok(read(`apps/website/public/${name}`).startsWith("# Ghostly\n"), name);
  assert.match(read("apps/website/app/layout.tsx"), /<link rel="alternate" type="text\/plain" href="\/llms\.txt"/);
  assert.match(read("apps/website/components/site/Footer.tsx"), /href: "\/llms\.txt"/);
});
