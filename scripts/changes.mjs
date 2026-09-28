#!/usr/bin/env node
/**
 * The changelog's next section, one file per change: changes/<slug>.md.
 *
 * Every pull request that adds a line to CHANGELOG.md's "## Unreleased" used to add it next to the others', so
 * pull requests open at the same time conflicted there. Now a change is a file of its own, and
 * scripts/bump-version.mjs puts the files into "## Unreleased" at release time and deletes them.
 *
 *   ---
 *   section: For users / Chat
 *   ---
 *   - Forward a message to up to five chats and groups at once.
 *
 * `section` names a "### " heading of "## Unreleased", and after " / " a **bold** group under it. One that does not
 * exist yet is added at the end. The body is one or more Markdown list items, added at the end of that section, in
 * the files' name order.
 *
 *   node scripts/changes.mjs            check every file (CI)
 *   node scripts/changes.mjs --preview  print "## Unreleased" as the release would write it
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
export const CHANGES = "changes";

/** A fragment's section and bullets, or a list of what is wrong with it. */
export function parseFragment(name, text) {
  const problems = [];
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { problems: [`${name}: starts with a front matter block (---, section: ..., ---)`] };
  const fields = Object.fromEntries(match[1].split("\n").map((line) => line.split(/:\s*(.*)/s).slice(0, 2)));
  const section = (fields.section ?? "").trim();
  const [heading, group, ...rest] = section.split(" / ").map((part) => part.trim());
  if (!heading || rest.length || group === "") problems.push(`${name}: "section" is "<### heading>" or "<### heading> / <**group**>"`);
  if (/[#*]/.test(section)) problems.push(`${name}: "section" is the heading's words, without # or **`);
  const body = match[2].trim();
  if (!body) problems.push(`${name}: no text after the front matter`);
  else if (!body.startsWith("- ")) problems.push(`${name}: the text is one or more list items ("- ...")`);
  if (/[–—]/.test(text)) problems.push(`${name}: no em or en dashes`);
  return { heading, group, body, problems };
}

/** Every fragment in changes/, in name order (README.md is the folder's own notes). */
export function readFragments(root = ROOT) {
  let names = [];
  try {
    names = readdirSync(join(root, CHANGES));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
    .map((name) => ({ name: `${CHANGES}/${name}`, ...parseFragment(`${CHANGES}/${name}`, readFileSync(join(root, CHANGES, name), "utf8")) }));
}

/** CHANGELOG.md with every fragment's items at the end of its section of "## Unreleased". */
export function assembleChangelog(changelog, fragments) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line === "## Unreleased");
  if (start < 0) throw new Error('CHANGELOG.md has no "## Unreleased" heading');
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  const section = lines.slice(start, end);
  while (section.length && section[section.length - 1] === "") section.pop();

  // The last line of a block that starts at `from` and ends before the next heading of the given kinds.
  const blockEnd = (from, stop) => {
    let i = from + 1;
    while (i < section.length && !stop(section[i])) i++;
    while (i > from + 1 && section[i - 1] === "") i--;
    return i;
  };
  const isHeading = (line) => line.startsWith("### ");
  const isGroup = (line) => /^\*\*[^*]+\*\*$/.test(line);

  for (const { heading, group, body } of fragments) {
    let h = section.findIndex((line) => line === `### ${heading}`);
    if (h < 0) {
      section.push("", `### ${heading}`);
      h = section.length - 1;
    }
    let at;
    if (group) {
      const headingEnd = blockEnd(h, isHeading);
      let g = section.findIndex((line, i) => i > h && i < headingEnd && line === `**${group}**`);
      if (g < 0) {
        section.splice(headingEnd, 0, "", `**${group}**`);
        g = headingEnd + 1;
      }
      at = blockEnd(g, (line) => isHeading(line) || isGroup(line));
      if (at === g + 1) section.splice(at++, 0, "");
    } else {
      at = blockEnd(h, (line) => isHeading(line) || isGroup(line));
      if (at === h + 1) section.splice(at++, 0, "");
    }
    section.splice(at, 0, ...body.split("\n"));
  }
  return [...lines.slice(0, start), ...section, "", ...lines.slice(end)].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fragments = readFragments();
  const problems = fragments.flatMap((f) => f.problems);
  if (problems.length) {
    console.error(`${problems.length} problem${problems.length > 1 ? "s" : ""} in ${CHANGES}/ (see scripts/changes.mjs):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  const changelog = assembleChangelog(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), fragments);
  if (process.argv.includes("--preview")) {
    const from = changelog.indexOf("## Unreleased");
    const to = changelog.indexOf("\n## ", from + 1);
    console.log(changelog.slice(from, to < 0 ? undefined : to));
  } else console.log(`${CHANGES}/: ${fragments.length} change${fragments.length === 1 ? "" : "s"} for the next release, all well formed`);
}
