import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** What a security branch changes: the compare's files, and file contents on main and on the branch. */
export type Fixture = {
  files: { filename: string; additions: number; deletions: number; previous_filename?: string }[];
  main: Record<string, unknown>;
  branch: Record<string, unknown>;
};

const SHA = "a".repeat(40);
const gate = resolve(import.meta.dirname, "../autorelease-gate.mjs");
const api = resolve(import.meta.dirname, "fixtures/autorelease-gate-api.mjs");

/** GITHUB_OUTPUT read the way the Actions runner reads it: `key=value` lines and `key<<DELIMITER` blocks. */
export function readOutputs(text: string): Record<string, string> {
  const lines = text.split("\n");
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const heredoc = line.indexOf("<<");
    const equals = line.indexOf("=");
    if (heredoc > 0 && (equals < 0 || heredoc < equals)) {
      const delimiter = line.slice(heredoc + 2);
      const value: string[] = [];
      for (i++; i < lines.length && lines[i] !== delimiter; i++) value.push(lines[i]);
      if (i >= lines.length) throw new Error(`Matching delimiter not found '${delimiter}'`);
      out[line.slice(0, heredoc)] = value.join("\n");
    } else if (equals > 0) out[line.slice(0, equals)] = line.slice(equals + 1);
    else throw new Error(`Invalid format '${line}'`);
  }
  return out;
}

/** Runs the gate against a fake GitHub API holding `fixture`: its exit code, what it printed, and its outputs. */
export function runGate(fixture: Fixture, mode: "all" | "deps" = "all") {
  const dir = mkdtempSync(join(tmpdir(), "autorelease-gate-"));
  try {
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ sha: SHA, ...fixture }));
    writeFileSync(join(dir, "output"), "");
    const run = spawnSync(process.execPath, ["--import", api, gate], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        GATE_FIXTURE: join(dir, "fixture.json"),
        GH_TOKEN: "test",
        GITHUB_REPOSITORY: "owner/repo",
        BRANCH: "claude/security-auto-test",
        HEAD_SHA: SHA,
        MODE: mode,
        GITHUB_OUTPUT: join(dir, "output"),
      },
    });
    return { code: run.status, stderr: run.stderr, outputs: readOutputs(readFileSync(join(dir, "output"), "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A branch that bumps 1.1.6 to 1.1.7 with its changelog section, plus `extra` changes. */
export function bump(extra: Partial<Fixture> = {}, notes = "- Fix a thing."): Fixture {
  return {
    files: [{ filename: "package.json", additions: 1, deletions: 1 }, { filename: "CHANGELOG.md", additions: 4, deletions: 0 }, ...(extra.files ?? [])],
    main: { "package.json": { name: "ghostly", version: "1.1.6" }, ...extra.main },
    branch: { "package.json": { name: "ghostly", version: "1.1.7" }, "CHANGELOG.md": `# Changelog\n\n## 1.1.7\n\n${notes}\n\n## 1.1.6\n\n- Older.\n`, ...extra.branch },
  };
}
