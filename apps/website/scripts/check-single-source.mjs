// WISP content is written in docs/wisps and nowhere else: the site is generated from it
// (`npm run sync:references`). This fails when the site's own source starts holding text per WISP
// again, or a level the documents already state. Run by `npm run lint` and `npm test`.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";

const site = fileURLToPath(new URL("../", import.meta.url));

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mjs)$/.test(name) ? [path] : [];
  });
}

/** Every problem found in the site rooted at `root`, as lines to print; none when the site is clean. */
export function singleSourceProblems(root = site) {
  const numbering = JSON.parse(readFileSync(resolve(root, "lib/wisp-numbering.json"), "utf8"));
  const slugs = numbering.map((entry) => entry.file.replace(/\.md$/, "").toLowerCase());
  const problems = [];
  if (existsSync(resolve(root, "lib/wisp-editorial.ts")))
    problems.push("lib/wisp-editorial.ts is back: a WISP's summary, availability and notes are rows of its header in docs/wisps");
  for (const dir of ["lib", "content", "components", "app"].map((d) => resolve(root, d)).filter(existsSync)) {
    for (const path of sources(dir)) {
      const name = relative(root, path);
      const text = readFileSync(path, "utf8");
      // A record keyed by WISP: `"202-arkade": …`. Naming a WISP in a list (a block's `wisps`) is a pointer, not text.
      for (const slug of slugs)
        if (new RegExp(`["'\`]${slug}["'\`]\\s*:`).test(text)) problems.push(`${name}: an entry keyed by WISP "${slug}". Write it in docs/wisps/${slug}.md`);
      if (name === "lib/composition.ts" && /\bb\([^\n]*"(available|planned|research)"/.test(text))
        problems.push(`${name}: a block states its own level. It comes from its WISPs or its roadmap row (lib/levels.json)`);
      if (/^content\/roadmap/.test(name) && /\blevel:\s*["']|\b(tracks|lanes|now|next):\s*\[/.test(text))
        problems.push(`${name}: roadmap items are written in docs/wisps/ADAPTER-ROADMAP.md ("Tracks"), not on the site`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = singleSourceProblems();
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`\n${problems.length} place(s) where the site holds WISP content. WISP content lives in docs/wisps only; the site is generated.`);
    process.exit(1);
  }
  console.log("Single source: the site holds no WISP content of its own.");
}
