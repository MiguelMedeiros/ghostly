// A WISP's revision log, one file per change: docs/wisps/changes/<wisp>/<YYYY-MM-DD>-<slug>.md (docs/wisps/00-process.md,
// "Revisions"). Pull requests changing the same WISP at the same time each add a file instead of all editing its
// Revision row and the top of its log. The sync writes the log, the Revision row and the Updated row into the copy
// the site publishes; the source documents only point at their folder.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const NAME = /^(\d{4}-\d\d-\d\d)-[a-z0-9][a-z0-9.-]*\.md$/;
const REVISION = /^\d+(?:\.\d+)+$/;

/** One change file: its date (from the name), its revision number if it has one, and its text (one paragraph). */
export function parseChange(stem, name, text) {
  const where = `docs/wisps/changes/${stem}/${name}`;
  const date = name.match(NAME)?.[1];
  if (!date) throw new Error(`${where}: name it <YYYY-MM-DD>-<slug>.md (lowercase, digits, dots and dashes)`);
  let body = text;
  let revision;
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (front) {
    body = text.slice(front[0].length);
    for (const line of front[1].split("\n")) {
      const [key, value] = line.split(/:\s*/, 2);
      if (key !== "revision" || !REVISION.test(value ?? "")) throw new Error(`${where}: the front matter only holds "revision: <number>"`);
      revision = value;
    }
  }
  body = body.trim().replace(/\s*\n\s*/g, " ");
  if (!body) throw new Error(`${where}: no text`);
  if (body.startsWith("- ") || body.startsWith("#")) throw new Error(`${where}: one paragraph of text, not a list or a heading`);
  return { date, revision, text: body, name };
}

const numbers = (revision) => revision.split(".").map(Number);
function compareRevisions(a, b) {
  const [x, y] = [numbers(a), numbers(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
  return 0;
}

/** Oldest first: by date, then numbered revisions in their order before the dated changes of that day, then by name. */
export function orderChanges(changes) {
  return [...changes].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.revision && b.revision ? compareRevisions(a.revision, b.revision) : a.revision ? -1 : b.revision ? 1 : 0) ||
      a.name.localeCompare(b.name),
  );
}

/** The changes of docs/wisps/<stem>.md, oldest first ([] when it has no folder). */
export function readChanges(wisps, stem) {
  const dir = resolve(wisps, "changes", stem);
  if (!existsSync(dir)) return [];
  return orderChanges(
    readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => parseChange(stem, name, readFileSync(resolve(dir, name), "utf8"))),
  );
}

/** What the header says: the revision is the latest change's number, or its date once changes stopped being numbered. */
export function revisionOf(changes) {
  const last = changes.at(-1);
  return last ? { revision: last.revision ?? last.date, updated: last.date } : undefined;
}

/**
 * The document as the site publishes it: Revision and Updated rows after the Status row of the header, and the
 * "## Revision log" section's text replaced by the log, newest first.
 */
export function withRevisions(body, stem, changes) {
  const current = revisionOf(changes);
  if (!current) return body;
  const lines = body.split("\n");
  const how = "a change is a file in docs/wisps/changes/" + stem + "/ (00-process.md, \"Revisions\")";
  if (lines.some((line) => /^\|\s*(Revision|Updated)\s*\|/.test(line))) throw new Error(`docs/wisps/${stem}.md: no Revision or Updated row in the source; ${how}`);
  const logAt = lines.indexOf("## Revision log");
  const logEnd = lines.findIndex((line, i) => i > logAt && line.startsWith("## "));
  const logLines = logAt < 0 ? [] : lines.slice(logAt + 1, logEnd < 0 ? undefined : logEnd);
  if (logLines.some((line) => line.startsWith("- ")))
    throw new Error(`docs/wisps/${stem}.md: the Revision log lists nothing in the source; ${how}`);
  const status = lines.findIndex((line) => /^\|\s*Status\s*\|/.test(line));
  if (status < 0) throw new Error(`docs/wisps/${stem}.md: no Status row in the header`);
  lines.splice(status + 1, 0, `| Revision | ${current.revision} |`, `| Updated | ${current.updated} |`);
  const log = [...changes].reverse().map((c) => `- ${c.revision ? `${c.revision} (${c.date})` : c.date}: ${c.text}`);
  const at = lines.indexOf("## Revision log");
  if (at < 0) return `${lines.join("\n").replace(/\n+$/, "")}\n\n## Revision log\n\n${log.join("\n")}\n`;
  let end = lines.findIndex((line, i) => i > at && line.startsWith("## "));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, at + 1), "", ...log, "", ...lines.slice(end)].join("\n").replace(/\n+$/, "\n");
}
