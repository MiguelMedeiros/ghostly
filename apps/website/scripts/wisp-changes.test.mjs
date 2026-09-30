import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { orderChanges, parseChange, readChanges, revisionOf, withRevisions } from "./wisp-changes.mjs";

const change = (name, text) => parseChange("400-chat", name, text);

test("a change file: its date from the name, an optional revision, one paragraph", () => {
  assert.deepEqual(change("2026-09-28-pins.md", "Pinned messages:\nthe `pin` frame.\n"), { date: "2026-09-28", revision: undefined, text: "Pinned messages: the `pin` frame.", name: "2026-09-28-pins.md" });
  assert.equal(change("2026-09-27-r0.2.11.md", "---\nrevision: 0.2.11\n---\nForwards.\n").revision, "0.2.11");
  assert.throws(() => change("pins.md", "Pins."), /<YYYY-MM-DD>-<slug>\.md/);
  assert.throws(() => change("2026-09-28-pins.md", "\n"), /no text/);
  assert.throws(() => change("2026-09-28-pins.md", "- a list\n"), /one paragraph/);
  assert.throws(() => change("2026-09-28-pins.md", "---\nauthor: me\n---\nPins.\n"), /front matter/);
});

test("in order: by date, numbered revisions in number order before the dated changes of their day", () => {
  const ordered = orderChanges([
    change("2026-09-28-b.md", "B."),
    change("2026-09-27-r0.2.10.md", "---\nrevision: 0.2.10\n---\nTen."),
    change("2026-09-27-a.md", "A."),
    change("2026-09-27-r0.2.9.md", "---\nrevision: 0.2.9\n---\nNine."),
    change("2026-09-25-r0.2.md", "---\nrevision: 0.2\n---\nTwo."),
  ]);
  assert.deepEqual(ordered.map((c) => c.text), ["Two.", "Nine.", "Ten.", "A.", "B."]);
  assert.deepEqual(revisionOf(ordered), { revision: "2026-09-28", updated: "2026-09-28" });
  assert.deepEqual(revisionOf(ordered.slice(0, 3)), { revision: "0.2.10", updated: "2026-09-27" });
});

test("the published copy gets the header rows and the log, newest first", () => {
  const source = "# WISP 400\n\n| Field | Value |\n|---|---|\n| Status | Draft |\n| Editors | Us |\n\n## Body\n\nText.\n\n## Revision log\n\nOne file per change in changes/400-chat/.\n";
  const changes = orderChanges([change("2026-09-25-r0.2.md", "---\nrevision: 0.2\n---\nTwo."), change("2026-09-28-pins.md", "Pins.")]);
  assert.equal(
    withRevisions(source, "400-chat", changes),
    "# WISP 400\n\n| Field | Value |\n|---|---|\n| Status | Draft |\n| Revision | 2026-09-28 |\n| Updated | 2026-09-28 |\n| Editors | Us |\n\n## Body\n\nText.\n\n## Revision log\n\n- 2026-09-28: Pins.\n- 0.2 (2026-09-25): Two.\n",
  );
});

test("a source written the old way is refused: a Revision row, or a log line in the document", () => {
  const changes = [change("2026-09-28-pins.md", "Pins.")];
  const header = "| Field | Value |\n|---|---|\n| Status | Draft |\n";
  assert.throws(() => withRevisions(`${header}| Revision | 0.3 |\n`, "400-chat", changes), /no Revision or Updated row/);
  assert.throws(() => withRevisions(`${header}\n## Revision log\n\n- 0.3 (2026-09-28): pins.\n`, "400-chat", changes), /lists nothing/);
  assert.ok(withRevisions(`${header}\n## Revision log\n\nSee the folder.\n\n## After\n\n- a list elsewhere\n`, "400-chat", changes));
});

test("reads a WISP's folder, and nothing for a WISP without one", () => {
  const wisps = mkdtempSync(join(tmpdir(), "wisp-changes-"));
  mkdirSync(join(wisps, "changes", "400-chat"), { recursive: true });
  writeFileSync(join(wisps, "changes", "400-chat", "2026-09-28-pins.md"), "Pins.\n");
  assert.deepEqual(readChanges(wisps, "400-chat").map((c) => c.text), ["Pins."]);
  assert.deepEqual(readChanges(wisps, "401-paired-chat"), []);
});
