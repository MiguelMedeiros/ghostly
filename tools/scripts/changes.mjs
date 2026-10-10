#!/usr/bin/env node
/**
 * The changelog's next section, one file per change: docs/changelog/unreleased/<slug>.md.
 *
 * Every pull request that adds a line to CHANGELOG.md's "## Unreleased" used to add it next to the others', so
 * pull requests open at the same time conflicted there. Now a change is a file of its own, and
 * tools/scripts/bump-version.mjs puts the files into "## Unreleased" at release time and deletes them.
 *
 *   ---
 *   section: For users / Chat
 *   ---
 *   - Forward a message to up to five chats and groups at once.
 *
 * `section` names a "### " heading of "## Unreleased", and after " / " a **bold** group under it. A group that does
 * not exist yet is added at the end of its heading, and a heading in its place in the order Security, For users, Fixed,
 * For developers (another one after them). The body is one or more Markdown list items, added at the end of that
 * section, in the files' name order.
 *
 * An optional `release: <major>.<minor>` holds an entry for that release: a bump to an older version (a 1.1.x patch
 * for `release: 1.2`) leaves the file where it is, and the first bump to 1.2.0 or later takes it.
 *
 *   node tools/scripts/changes.mjs                    check every file, held ones too (CI)
 *   node tools/scripts/changes.mjs --preview          print "## Unreleased" with every entry
 *   node tools/scripts/changes.mjs --preview 1.1.7    print it as bumping to 1.1.7 would write it (held entries out)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
export const CHANGES = "docs/changelog/unreleased";

/**
 * Flags that hold part of the next release back, one per flag. A version before `from` must not ship the flag on
 * (tools/scripts/bump-version.mjs refuses the bump), and while the repository is at a version before `from`, an entry
 * about it (`entry`) says `release: <release>` or later, so a patch never announces it. The flag flips only on the
 * release/<from> branch, before that release's bump (docs/RELEASING.md).
 */
export const RELEASE_GUARDS = [
  {
    file: "packages/browser/src/shared/features.ts",
    flag: "APPS_ENABLED",
    from: "1.2.0",
    release: "1.2",
    about: "Apps",
    entry: ({ group, body }) => group === "Apps" || /apps flag|WISP 1200|\bapps\/1\b/i.test(body ?? ""),
  },
  // No flag, so it holds entries only: the native Android app is a build of its own, in no release before
  // ANDROID_FROM in .github/workflows/release.yml (the owner's decision, 2026-10-10), which `from` follows.
  {
    from: "1.3.0",
    release: "1.3",
    about: "Android app",
    entry: ({ group, body }) => group === "Android" || /\bAndroid app\b|\bAPK\b/i.test(body ?? ""),
  },
];

/** The only front matter keys a fragment has: a misspelled `release` would otherwise leave its entry unheld. */
const KEYS = ["section", "release"];

/**
 * A fragment's section and bullets, or a list of what is wrong with it. `version` is the repository's (package.json):
 * before a guard's `from`, an entry about that flag must be held for its release.
 */
export function parseFragment(name, text, version) {
  const problems = [];
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { problems: [`${name}: starts with a front matter block (---, section: ..., ---)`] };
  const fields = {};
  for (const line of match[1].split("\n")) {
    const pair = line.match(/^([a-z]+): ?(.*)$/);
    if (!pair) problems.push(`${name}: each front matter line is "<key>: <value>" (${KEYS.join(", ")}), not "${line}"`);
    else if (!KEYS.includes(pair[1])) problems.push(`${name}: "${pair[1]}" is not a front matter key (${KEYS.join(", ")})`);
    else if (pair[1] in fields) problems.push(`${name}: "${pair[1]}" appears twice in the front matter`);
    else fields[pair[1]] = pair[2];
  }
  const section = (fields.section ?? "").trim();
  const [heading, group, ...rest] = section.split(" / ").map((part) => part.trim());
  if (!heading || rest.length || group === "") problems.push(`${name}: "section" is "<### heading>" or "<### heading> / <**group**>"`);
  if (/[#*]/.test(section)) problems.push(`${name}: "section" is the heading's words, without # or **`);
  const body = match[2].trim();
  if (!body) problems.push(`${name}: no text after the front matter`);
  else if (!body.startsWith("- ")) problems.push(`${name}: the text is one or more list items ("- ...")`);
  if (/[–—]/.test(text)) problems.push(`${name}: no em or en dashes`);
  const release = fields.release === undefined ? undefined : fields.release.trim();
  const releaseOk = release !== undefined && /^\d+\.\d+$/.test(release);
  if (release !== undefined && !releaseOk) {
    problems.push(`${name}: "release" is the release that takes the entry, as <major>.<minor> (such as 1.2)`);
  }
  for (const guard of RELEASE_GUARDS) {
    if (version !== undefined && !versionBefore(version, guard.from)) continue;
    if (!guard.entry({ group, body })) continue;
    if (release === undefined || (releaseOk && versionBefore(release, guard.release))) {
      const ships = guard.flag ? `it ships with ${guard.flag} from ${guard.from}` : `it is in no release before ${guard.from}`;
      problems.push(`${name}: an ${guard.about} entry says "release: ${guard.release}" (${ships})`);
    }
  }
  return { heading, group, body, release, problems };
}

/** A version's numbers, for comparing: "1.2" is [1, 2], "1.10.3" is [1, 10, 3]. */
const numbers = (version) => version.split(".").map(Number);

/** Whether version `a` comes before `b`, number by number ("1.9.0" before "1.10.0"; a missing number counts as 0). */
export function versionBefore(a, b) {
  const [x, y] = [numbers(a), numbers(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

/**
 * Whether an entry held for `release` ("1.2") stays out of `version` ("1.1.7"): its major.minor is newer. An entry
 * with no `release` is never held, and `release: 1.2` goes out with 1.2.0 and every version after it.
 */
export function heldFor(release, version) {
  if (!release) return false;
  const [major, minor] = numbers(version);
  return versionBefore(`${major}.${minor}`, release);
}

/** The fragments a bump to `version` writes, and the ones it leaves for a later release. */
export function splitFragments(fragments, version) {
  const released = [];
  const held = [];
  for (const fragment of fragments) (heldFor(fragment.release, version) ? held : released).push(fragment);
  return { released, held };
}

/** The repository's version (package.json), or undefined where there is none. */
export function repositoryVersion(root = ROOT) {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

/** Every fragment in docs/changelog/unreleased/, in name order (README.md is the folder's own notes). */
export function readFragments(root = ROOT) {
  const version = repositoryVersion(root);
  let names = [];
  try {
    names = readdirSync(join(root, CHANGES));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
    .map((name) => ({ name: `${CHANGES}/${name}`, ...parseFragment(`${CHANGES}/${name}`, readFileSync(join(root, CHANGES, name), "utf8"), version) }));
}

/**
 * Entries still written to the old folder, `changes/` at the root (before 2026-10): a branch made before the move
 * brings its entry there, where no release would read it.
 */
export function strayFragments(root = ROOT) {
  let names = [];
  try {
    names = readdirSync(join(root, "changes"));
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".md") && name !== "README.md").sort().map((name) => `changes/${name}`);
}

/**
 * The order of a release's "### " headings: what people came for first. A heading that is not here goes after them.
 * Without it the order was the files' name order, so holding one entry back could put "Fixed" above "For users".
 */
const HEADINGS = ["Security", "For users", "Fixed", "For developers"];
const headingRank = (heading) => (HEADINGS.includes(heading) ? HEADINGS.indexOf(heading) : HEADINGS.length);

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
      // Before the first heading that comes later in the order, or at the end.
      const later = section.findIndex((line) => isHeading(line) && headingRank(line.slice(4)) > headingRank(heading));
      if (later < 0) {
        section.push("", `### ${heading}`);
        h = section.length - 1;
      } else {
        section.splice(later, 0, `### ${heading}`, "");
        h = later;
      }
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

/**
 * CHANGELOG.md after a bump to `version`: the fragments go into "## Unreleased", which becomes "## <version>", and a
 * new "## Unreleased" with the same note stays above it, for the entries still held and the next ones.
 */
export function releaseChangelog(changelog, fragments, version) {
  const lines = assembleChangelog(changelog, fragments).split("\n");
  const start = lines.indexOf("## Unreleased");
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  const notes = [];
  const entries = [];
  // The note is an HTML comment (one line or several): it stays with the heading, the rest goes to the release.
  let inNote = false;
  for (const line of lines.slice(start + 1, end)) {
    if (line.startsWith("<!--")) inNote = true;
    (inNote ? notes : entries).push(line);
    if (inNote && line.includes("-->")) inNote = false;
  }
  while (entries.length && entries[0] === "") entries.shift();
  const unreleased = ["## Unreleased", "", ...(notes.length ? [...notes, ""] : [])];
  return [...lines.slice(0, start), ...unreleased, `## ${version}`, "", ...entries, ...lines.slice(end)].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stray = strayFragments();
  if (stray.length) {
    console.error(`Changelog entries moved to ${CHANGES}/: move ${stray.join(", ")} there (git mv changes/*.md ${CHANGES}/).`);
    process.exit(1);
  }
  const fragments = readFragments();
  const problems = fragments.flatMap((f) => f.problems);
  if (problems.length) {
    console.error(`${problems.length} problem${problems.length > 1 ? "s" : ""} in ${CHANGES}/ (see tools/scripts/changes.mjs):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  const preview = process.argv.indexOf("--preview");
  const version = preview < 0 ? undefined : process.argv[preview + 1];
  if (version !== undefined && !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error("usage: node tools/scripts/changes.mjs [--preview [<major.minor.patch>]]");
    process.exit(1);
  }
  const { released, held } = version ? splitFragments(fragments, version) : { released: fragments, held: [] };
  let changelog;
  try {
    changelog = assembleChangelog(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), released);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
  if (preview >= 0) {
    const from = changelog.indexOf("## Unreleased");
    const to = changelog.indexOf("\n## ", from + 1);
    console.log(changelog.slice(from, to < 0 ? undefined : to));
    if (held.length) console.error(`Held for a later release: ${held.map((f) => `${f.name} (${f.release})`).join(", ")}`);
  } else {
    const waiting = fragments.filter((f) => f.release);
    const note = waiting.length ? `, ${waiting.length} of them held for a release (release: <major.minor>)` : "";
    console.log(`${CHANGES}/: ${fragments.length} change${fragments.length === 1 ? "" : "s"}${note}, all well formed`);
  }
}
